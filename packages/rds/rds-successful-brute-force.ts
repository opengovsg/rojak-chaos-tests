import path from 'node:path'
import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import type { PolicyStatement } from '@pulumi/aws/iam'
import stateMachine from './state-machine.json'

interface RdsSuccessfulBruteForceArgs {
  readonly host: pulumi.Input<string>
  readonly port: pulumi.Input<string>
  readonly vpcId?: pulumi.Input<string>
  readonly subnetId?: pulumi.Input<string>
  readonly user?: pulumi.Input<string>
  readonly password?: pulumi.Input<string>
  readonly bruteForceCount?: pulumi.Input<string>
}

export class RdsSuccessfulBruteForce extends pulumi.ComponentResource {
  public stateMachine: pulumi.Output<aws.sfn.StateMachine>

  constructor(
    name: string,
    { host, port, vpcId, subnetId, user, password, bruteForceCount }: RdsSuccessfulBruteForceArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    const fullName = `${name}-rds-successful-brute-force`
    const fnLogGroupName = '/aws/lambda/opengovsg/rojak-rds'
    const ebfLogGroupName = '/aws/lambda/opengovsg/rojak-rds-ebf'

    const region = pulumi.output(aws.getRegion())
    const callerIdentity = pulumi.output(aws.getCallerIdentity({}))

    super('@opengovsg/rojak-chaos-experiments:RdsSuccessfulBruteForce', fullName, {}, opts)

    // MARK: Injection Function
    // Short formed to fn

    const fnTaskTokenSsmParam = new aws.ssm.Parameter(`${name}-fn-task-token-ssm-param`, {
      name: '/chaosexperiments/rds/injection/tasktoken',
      type: aws.ssm.ParameterType.String,
      value: 'PLACEHOLDER',
    }, { parent: this })

    const fnRole = new aws.iam.Role(`${name}-fn-role`, {
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [{
          Action: 'sts:AssumeRole',
          Principal: {
            Service: 'lambda.amazonaws.com',
          },
          Effect: 'Allow',
        }],
      },
    }, { parent: this })

    const fnLogGroup = new aws.cloudwatch.LogGroup(`${name}-fn-log-group`, {
      name: fnLogGroupName,
      retentionInDays: 7,
    }, { parent: this })

    const fnRolePolicyStatements: PolicyStatement[] = [
      {
        Action: ['ssm:GetParameter'],
        Effect: 'Allow',
        Resource: pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${fnTaskTokenSsmParam.name}`,
      },
      {
        Action: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
        Effect: 'Allow',
        Resource: '*',
      },
      {
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Effect: 'Allow',
        Resource: pulumi.interpolate`${fnLogGroup.arn}:*`,
      },
    ]

    // MARK: Injection Function VPC
    //
    let fnSecurityGroup

    if (vpcId && subnetId) {
      fnSecurityGroup = new aws.ec2.SecurityGroup(`${name}-fn-security-group`, {
        vpcId,
        ingress: [
          {
            fromPort: 0,
            toPort: 0,
            protocol: '-1',
            cidrBlocks: ['0.0.0.0/0'],
            ipv6CidrBlocks: ['::/0'],
          },
        ],
        egress: [
          {
            fromPort: 0,
            toPort: 0,
            protocol: '-1',
            cidrBlocks: ['0.0.0.0/0'],
            ipv6CidrBlocks: ['::/0'],
          },
        ],
      })

      fnRolePolicyStatements.push({
        Action: [
          'ec2:DescribeNetworkInterfaces',
          'ec2:CreateNetworkInterface',
          'ec2:DeleteNetworkInterface',
          'ec2:DescribeInstances',
          'ec2:AttachNetworkInterface',
        ],
        Effect: 'Allow',
        Resource: '*', // TODO narrow with condition which I cannot figure out
      })

      const fnSsmVpcEndpoint = new aws.ec2.VpcEndpoint(`${name}-fn-ssm-vpc-endpoint`, {
        vpcId,
        serviceName: pulumi.interpolate`com.amazonaws.${region.name}.ssm`,
        privateDnsEnabled: true,
        vpcEndpointType: 'Interface',
        subnetIds: [subnetId],
        securityGroupIds: [fnSecurityGroup.id],
      }, { parent: this })

      const fnSfnVpcEndpoint = new aws.ec2.VpcEndpoint(`${name}-fn-sfn-vpc-endpoint`, {
        vpcId,
        serviceName: pulumi.interpolate`com.amazonaws.${region.name}.states`,
        privateDnsEnabled: true,
        vpcEndpointType: 'Interface',
        subnetIds: [subnetId],
        securityGroupIds: [fnSecurityGroup.id],
      })

      const fnLogsVpcEndpoint = new aws.ec2.VpcEndpoint(`${name}-fn-logs-vpc-endpoint`, {
        vpcId,
        serviceName: pulumi.interpolate`com.amazonaws.${region.name}.logs`,
        vpcEndpointType: 'Interface',
        subnetIds: [subnetId],
        securityGroupIds: [fnSecurityGroup.id],
        privateDnsEnabled: true,
      }, { parent: this })
    }

    // MARK: End Injection Function VPC

    const fn = new aws.lambda.Function(`${name}-fn`, {
      role: fnRole.arn,
      environment: {
        variables: {
          DB_HOST: host,
          DB_PORT: port,
          // @ts-expect-error It is ok to be undefined
          DB_USER: user,
          // @ts-expect-error It is ok to be undefined
          DB_PASSWORD: password,
          // @ts-expect-error It is ok to be undefined
          BRUTE_FORCE_COUNT: bruteForceCount,
        },
      },
      loggingConfig: {
        logFormat: 'JSON',
        logGroup: fnLogGroupName,
        applicationLogLevel: 'DEBUG',
      },
      vpcConfig: subnetId && fnSecurityGroup
        ? {
            subnetIds: [subnetId],
            securityGroupIds: [fnSecurityGroup.id],
          }
        : undefined,
      handler: 'lambda.handler',
      runtime: 'nodejs20.x',
      timeout: 900,
      memorySize: 1024,
      code: new pulumi.asset.FileArchive(path.join(__dirname, '..', 'node_modules', '@opengovsg', 'rojak-rds-lambda', 'assets', 'lambda.zip')),
    }, { parent: this })

    const fnRolePolicy = new aws.iam.RolePolicy(`${name}-fn-role-policy`, {
      role: fnRole.id,
      policy: {
        Version: '2012-10-17',
        Statement: fnRolePolicyStatements,
      },
    })

    // MARK: EventBridge Filter Function
    // Short formed to `ebf`

    const ebfTaskTokenSsmParam = new aws.ssm.Parameter(`${name}-ebf-task-token-ssm-param`, {
      name: '/chaosexperiments/rds/guardduty/tasktoken',
      type: aws.ssm.ParameterType.String,
      value: 'PLACEHOLDER',
    }, { parent: this })

    const ebfLogGroup = new aws.cloudwatch.LogGroup(`${name}-ebf-log-group`, {
      name: ebfLogGroupName,
      retentionInDays: 7,
    }, { parent: this })

    const ebfFnRole = new aws.iam.Role(`${name}-ebf-fn-role`, {
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [{
          Action: 'sts:AssumeRole',
          Principal: {
            Service: 'lambda.amazonaws.com',
          },
          Effect: 'Allow',
        }],
      },
    }, { parent: this })

    const ebfFnPolicy = new aws.iam.RolePolicy(`${name}-ebf-fn-policy`, {
      role: ebfFnRole.id,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: ['ssm:GetParameter'],
            Effect: 'Allow',
            Resource: pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${ebfTaskTokenSsmParam.name}`,
          },
          {
            Action: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
            Effect: 'Allow',
            Resource: '*',
          },
          {
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Effect: 'Allow',
            Resource: pulumi.interpolate`${ebfLogGroup.arn}:*`,
          },
        ],
      },
    })

    const ebfFn = new aws.lambda.Function(`${name}-ebf-fn`, {
      runtime: 'nodejs20.x',
      role: ebfFnRole.arn,
      handler: 'index.handler',
      loggingConfig: {
        logFormat: 'JSON',
        logGroup: ebfLogGroupName,
        applicationLogLevel: 'DEBUG',
      },
      code: new pulumi.asset.AssetArchive({
        '.': new pulumi.asset.FileArchive(path.join(__dirname, '..', `lambdas`, 'task-token-trigger')),
      }),
    })

    const ebfRole = new aws.iam.Role(`${name}-ebf-role`, {
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [{
          Action: 'sts:AssumeRole',
          Principal: {
            Service: 'events.amazonaws.com',
          },
          Effect: 'Allow',
        }],
      },
    })

    const ebfRolePolicy = new aws.iam.RolePolicy(`${name}-ebf-role-policy`, {
      role: ebfRole,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: ['lambda:InvokeFunction'],
            Effect: 'Allow',
            Resource: [
              ebfFn.arn,
              pulumi.interpolate`${ebfFn.arn}:*`,
            ],
          },
        ],
      },
    })

    const ebfEventRule = new aws.cloudwatch.EventRule(`${name}-ebf-event-rule`, {
      name: `${name}-ebf-event-rule`,
      eventPattern: JSON.stringify(
        {
          'source': ['aws.guardduty'],
          'detail-type': ['GuardDuty Finding'],
          'detail': {
            type: ['CredentialAccess:RDS/AnomalousBehavior.SuccessfulLogin'],
          },
        },
      ),
    })

    const ebfFnPermission = new aws.lambda.Permission(`${name}-ebf-fn-permisssion`, {
      function: ebfFn.name,
      action: 'lambda:InvokeFunction',
      principal: 'events.amazonaws.com',
      sourceArn: ebfEventRule.arn,
    })

    const ebfEventTarget = new aws.cloudwatch.EventTarget(`${name}-ebf-event-target`, {
      rule: ebfEventRule.name,
      arn: ebfFn.arn,
    })

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
    })

    const sfnRolePolicy = new aws.iam.RolePolicy(`${name}-sfn-role-policy`, {
      role: sfnRole.id,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              'lambda:InvokeFunction',
            ],
            Resource: [
              fn.arn,
              pulumi.interpolate`${fn.arn}:*`,
            ],
          },
          {
            Effect: 'Allow',
            Action: [
              'ssm:PutParameter',
            ],
            Resource: [
              fnTaskTokenSsmParam.arn,
              ebfTaskTokenSsmParam.arn,
            ],
          },
        ],
      },
    })

    this.stateMachine = fn.arn.apply(arn => new aws.sfn.StateMachine(`${name}-step-fn`, {
      roleArn: sfnRole.arn,
      definition: JSON.stringify(stateMachine).replace('{{FnArn}}', arn),
    }))
  }
}
