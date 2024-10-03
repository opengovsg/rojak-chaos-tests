import path from 'node:path'
import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { createStateMachine } from './state-machine'

interface FaultAll {
  fault: 'all'
  parameters?: Record<string, string>
}

interface FaultAvailabilityZone {
  fault: 'availability-zone'
  parameters?: Record<string, string>
}

interface FaultDynamo {
  fault: 'dynamo'
  parameters?: Record<string, string>
}

interface FaultPrefixList {
  fault: 'prefix-list'
  parameters: {
    prefixListId: string
  }
}

interface FaultS3 {
  fault: 's3'
  parameters?: Record<string, string>
}

interface FaultVpc {
  fault: 'vpc'
  parameters?: Record<string, string>
}

export type Fault = FaultAll | FaultAvailabilityZone | FaultDynamo | FaultPrefixList | FaultS3 | FaultVpc

export interface NetworkDisruptConnectivityArgs {
  readonly fault: Fault

  // Integer in minutes how long the fault should run for
  readonly duration: number
  readonly vpcId: pulumi.Input<string>
  readonly azs: pulumi.Input<string>[]

  // URL to monitor for downtime
  readonly monitoringUrl: pulumi.Input<string>
}

export class NetworkDisruptConnectivity extends pulumi.ComponentResource {
  public stateMachine: pulumi.Output<aws.sfn.StateMachine>

  constructor(
    name: string,
    { fault, duration, monitoringUrl, vpcId, azs }: NetworkDisruptConnectivityArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    const fullName = `${name}-network-disrupt-connectivity`
    const fisLogGroupName = '/chaosexperiments/network/fis'
    const monitoringFnLogGroupName = `/aws/lambda/rojak-${name}`

    const region = pulumi.output(aws.getRegion())
    const callerIdentity = pulumi.output(aws.getCallerIdentity({}))

    super('@opengovsg/rojak-chaos-experiments:NetworkDisruptConnectivity', fullName, {}, opts)

    const fisLogGroup = new aws.cloudwatch.LogGroup(`${name}-fis-log-group`, {
      name: fisLogGroupName,
      retentionInDays: 7,
    }, { parent: this })

    const monitoringFnLogGroup = new aws.cloudwatch.LogGroup(`${name}-monitoring-fn-log-group`, {
      name: monitoringFnLogGroupName,
      retentionInDays: 7,
    }, { parent: this })

    // Create FIS assumed role for this experiment
    const fisRole = new aws.iam.Role(`${name}-fis-role`, {
      name: `${name}-fis-role`,
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: {
              Service: 'fis.amazonaws.com',
            },
            Condition: {
              ArnLike: {
                'aws:sourceArn': pulumi.interpolate`arn:aws:fis:${region.name}:${callerIdentity.accountId}:experiment/*`,
              },
              StringEquals: {
                'aws:SourceAccount': pulumi.output(callerIdentity.accountId),
              },
            },
          },
        ],
      },
    }, { parent: this })

    const fisRolePolicyAttachment = new aws.iam.RolePolicyAttachment(`${name}-network-role-policy-attachment`, {
      role: fisRole,
      policyArn: aws.iam.ManagedPolicy.AWSFaultInjectionSimulatorNetworkAccess,
    }, { parent: this })

    const fisLogsRolePolicy = new aws.iam.RolePolicy(`${name}-fis-logs-role-policy`, {
      role: fisRole,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              'logs:CreateLogDelivery',
              'logs:PutResourcePolicy',
              'logs:DescribeResourcePolicies',
              'logs:DescribeLogGroups',
            ],
            Resource: '*',
          },
          {
            Effect: 'Allow',
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: pulumi.interpolate`${fisLogGroup.arn}:*`,
          },
        ],
      },
    }, { parent: this })

    const fis = new aws.fis.ExperimentTemplate(`${name}-template`, {
      description: 'Network Chaos Experiment',
      roleArn: fisRole.arn,
      logConfiguration: {
        logSchemaVersion: 2,
        cloudwatchLogsConfiguration: {
          logGroupArn: pulumi.interpolate`${fisLogGroup.arn}:*`,
        },
      },
      // experimentOptions: {
      //   emptyTargetResolutionMode: 'skip',
      // },
      stopConditions: [
        {
          source: 'none',
        },
      ],
      actions: azs.map(az => ({
        name: az,
        actionId: 'aws:network:disrupt-connectivity',
        parameters: [
          {
            key: 'duration',
            value: `PT${duration}M`,
          },
          {
            key: 'scope',
            value: fault.fault,
          },
          ...Object.entries(fault.parameters ?? {})
            .filter(([_, value]) => value !== undefined)
            .map(([key, value]) => ({
              key,
              value,
            })),
        ],
        target: {
          key: 'Subnets',
          value: az,
        },
      }),
      ),
      targets: azs.map(az => ({
        name: az,
        resourceType: 'aws:ec2:subnet',
        selectionMode: 'ALL',
        parameters: {
          availabilityZoneIdentifier: az,
          vpc: vpcId,
        },
      }
      )),
    }, { parent: this })

    // MARK: SSM Parameters

    const injectionTaskTokenSsmParam = new aws.ssm.Parameter(`${name}-service-down-ssm-param`, {
      name: '/chaosexperiments/network/disruption/injection/tasktoken',
      type: aws.ssm.ParameterType.String,
      value: 'PLACEHOLDER',
    }, { parent: this })

    const remediationTaskTokenSsmParam = new aws.ssm.Parameter(`${name}-service-up-ssm-param`, {
      name: '/chaosexperiments/network/disruption/remediation/tasktoken',
      type: aws.ssm.ParameterType.String,
      value: 'PLACEHOLDER',
    }, { parent: this })

    // MARK: Monitoring lambda

    const monitoringFnRole = new aws.iam.Role(`${name}-monitoring-fn-role`, {
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'lambda.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
            Condition: {
              ArnLike: {
                'aws:sourceArn': pulumi.interpolate`arn:aws:lambda:${region.name}:${callerIdentity.accountId}:function:*`,
              },
              StringEquals: {
                'aws:SourceAccount': pulumi.output(callerIdentity.accountId),
              },
            },
          },
        ],
      },
    }, { parent: this })

    const monitoringFnRolePolicy = new aws.iam.RolePolicy(`${name}-validate-injection-fn-policy`, {
      role: monitoringFnRole.id,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: ['ssm:GetParameter'],
            Effect: 'Allow',
            Resource: pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${injectionTaskTokenSsmParam.name}`,
          },
          {
            Action: ['ssm:GetParameter'],
            Effect: 'Allow',
            Resource: pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${remediationTaskTokenSsmParam.name}`,
          },
          {
            Action: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
            Effect: 'Allow',
            Resource: '*',
          },
          {
            Effect: 'Allow',
            Action: ['logs:CreateLogGroup'],
            Resource: pulumi.interpolate`arn:aws:logs:${region.name}:${callerIdentity.accountId}:*`,
          },
          {
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Effect: 'Allow',
            Resource: pulumi.interpolate`${fisLogGroup.arn}:*`,
          },
        ],
      },
    }, { parent: this })

    const monitoringFn = new aws.lambda.Function(`${name}-monitoring-fn`, {
      runtime: 'nodejs20.x',
      role: monitoringFnRole.arn,
      handler: 'index.handler',
      loggingConfig: {
        logFormat: 'JSON',
        logGroup: monitoringFnLogGroupName,
        applicationLogLevel: 'DEBUG',
      },
      environment: {
        variables: {
          MONITOR_URL: monitoringUrl,
        },
      },
      timeout: (duration + 1) * 60, // Run function for 1 more minute to prevent timeout errors in SFN
      code: new pulumi.asset.AssetArchive({
        '.': new pulumi.asset.FileArchive(
          path.join(
            __dirname,
            '..',
            'lambdas',
            'monitor',
          ),
        ),
      }),
    }, { parent: this })

    // MARK: Step Function
    // Short formed to `sfn`

    const sfnRole = new aws.iam.Role(`${name}-sfn-role`, {
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'states.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
            Condition: {
              ArnLike: {
                'aws:sourceArn': pulumi.interpolate`arn:aws:states:${region.name}:${callerIdentity.accountId}:stateMachine:*`,
              },
              StringEquals: {
                'aws:SourceAccount': pulumi.output(callerIdentity.accountId),
              },
            },
          },
        ],
      },
    }, { parent: this })

    const sfnRolePolicy = new aws.iam.RolePolicy(`${name}-sfn-role-policy`, {
      role: sfnRole.id,
      policy: {
        Version: '2012-10-17',
        Statement: [
          // https://docs.aws.amazon.com/fis/latest/userguide/security_iam_id-based-policy-examples.html
          {
            Action: ['fis:StartExperiment'],
            Effect: 'Allow',
            Resource: [
              pulumi.interpolate`arn:aws:fis:${region.name}:${callerIdentity.accountId}:experiment-template/${fis.id}`,
              pulumi.interpolate`arn:aws:fis:${region.name}:${callerIdentity.accountId}:experiment/*`,
            ],
          },
          {
            Action: ['iam:CreateServiceLinkedRole'],
            Effect: 'Allow',
            Resource: '*',
            Condition: {
              StringEquals: {
                'iam:AWSServiceName': 'fis.amazonaws.com',
              },
            },
          },
          {
            Action: ['fis:GetExperiment'],
            Effect: 'Allow',
            Resource: '*', // experiment ID is not known ahead of time
          },
          {
            Action: ['ssm:PutParameter'],
            Effect: 'Allow',
            Resource: pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${injectionTaskTokenSsmParam.name}`,
          },
          {
            Action: ['ssm:PutParameter'],
            Effect: 'Allow',
            Resource: pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${remediationTaskTokenSsmParam.name}`,
          },
          {
            Action: ['lambda:InvokeFunction'],
            Effect: 'Allow',
            Resource: [
              monitoringFn.arn,
              pulumi.interpolate`${monitoringFn.arn}:*`,
            ],
          },
        ],
      },
    }, { parent: this })

    this.stateMachine = fis.id.apply(id => monitoringFn.arn.apply(fnArn => new aws.sfn.StateMachine(`${name}-sfn`, {
      roleArn: sfnRole.arn,
      definition: JSON.stringify(createStateMachine(id, duration * 60, fnArn)),
    })))
  }
}
