import * as path from 'node:path'
import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { createStateMachine } from './state-machine'

interface Ec2C2DnsCallbackArgs {
  /** The malicious C2 domain to resolve; default to GuardDuty test domain guarddutyc2activityb.com */
  readonly c2Domain?: pulumi.Input<string>
  /** The VPC to create the resources in */
  readonly vpcId: pulumi.Input<string>
  /** The subnet to create the compromised EC2 in */
  readonly subnetId: pulumi.Input<string>
  /** If existing, resolver query log group for target VPC (only 1 log configuration allowed) */
  readonly resolverQueryLogGroupName?: pulumi.Input<string>
}

/**
 * Chaos experiment that creates a compromised EC2 instance in the VPC that
 * makes DNS callbacks to a malware C2 domain using SSM runCommand.
 * Writes callback results to CloudWatch Logs to measure detection metrics.
 */
export class Ec2C2DnsCallback extends pulumi.ComponentResource {
  public stateMachine: pulumi.Output<aws.sfn.StateMachine>

  constructor(
    name: string,
    { c2Domain, vpcId, subnetId, resolverQueryLogGroupName }: Ec2C2DnsCallbackArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    const fullName = `${name}-ec2-c2-dns-callback`
    const region = pulumi.output(aws.getRegion())
    const callerIdentity = pulumi.output(aws.getCallerIdentity({}))

    super(
      '@opengovsg/rojak-chaos-experiments:Ec2C2DnsCallback',
      fullName,
      {},
      opts,
    )

    // Create EC2 security group
    const ec2SecurityGroup = new aws.ec2.SecurityGroup(`${name}-ec2-security-group`, {
      vpcId,
    }, { parent: this })

    // Get latest Amazon Linux 2 AMI (SSM preinstalled)
    const ami = pulumi.output(
      aws.ec2.getAmi({
        mostRecent: true,
        filters: [
          {
            name: 'architecture',
            values: ['x86_64'],
          },
          {
            name: 'name',
            values: ['amzn2-ami-kernel-*-gp2'],
          },
          {
            name: 'virtualization-type',
            values: ['hvm'],
          },
        ],
        owners: ['137112412989'], // AWS's owner ID in AMI
      }),
    ).id

    // Create EC2 instance
    const targetEc2 = new aws.ec2.Instance(`${name}-target-ec2`, {
      ami,
      instanceType: aws.ec2.InstanceType.T2_Micro,
      subnetId,
      vpcSecurityGroupIds: [ec2SecurityGroup.id],
      /**
       * Workaround as EC2 instances are created in running state and userdata scripts only run on first start.
       * This allows the EC2 instance scenario to be re-started multiple times without remaining running.
       */
      userData: `
          #!/bin/bash
          echo '#!/bin/bash' >> /etc/rc.local
          echo 'while true; do dig ${c2Domain} any; sleep 1; done' >> /etc/rc.local
          chmod +x /etc/rc.local
          systemctl enable rc-local
          shutdown -h now
        `,
    }, { parent: this })

    // Stores injection validation step function callback token
    const injectionTaskTokenSsmParam = new aws.ssm.Parameter(
      `${name}-injection-task-token-ssm-param`,
      {
        name: '/chaosexperiments/ec2/c2dns/injection/tasktoken',
        type: aws.ssm.ParameterType.String,
        value: 'PLACEHOLDER',
      },
      { parent: this },
    )

    // Stores detection validation step function callback token
    const detectionTaskTokenSsmParam = new aws.ssm.Parameter(
      `${name}-detection-task-token-ssm-param`,
      {
        name: '/chaosexperiments/ec2/c2dns/detection/tasktoken',
        type: aws.ssm.ParameterType.String,
        value: 'PLACEHOLDER',
      },
      { parent: this },
    )

    // Stores remediation validation step function callback token
    const remediationTaskTokenSsmParam = new aws.ssm.Parameter(
      `${name}-remediation-task-token-ssm-param`,
      {
        name: '/chaosexperiments/ec2/c2dns/remediation/tasktoken',
        type: aws.ssm.ParameterType.String,
        value: 'PLACEHOLDER',
      },
      { parent: this },
    )

    // Create assumed role for the state machine
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

    // Grant permissions to state machine assume role
    const sfnPolicy = new aws.iam.RolePolicy(`${name}-sfn-policy`, {
      role: sfnRole.id,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: ['ec2:StartInstances', 'ec2:StopInstances'],
            Effect: 'Allow',
            Resource: [
              targetEc2.arn,
            ],
          },
          {
            Action: ['ssm:PutParameter'],
            Effect: 'Allow',
            Resource: [
              pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${injectionTaskTokenSsmParam.name}`,
              pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${detectionTaskTokenSsmParam.name}`,
              pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${remediationTaskTokenSsmParam.name}`,
            ],
          },
        ],
      },
    }, { parent: this })

    // Create or get route53 query log group
    const resolverQueryLogGroup = resolverQueryLogGroupName
      // By default getting existing log group will skipDestroy
      ? aws.cloudwatch.LogGroup.get(`${name}-r53-log-group`, resolverQueryLogGroupName)
      : (new aws.cloudwatch.LogGroup(`${name}-r53-log-group`, {
          retentionInDays: 7,
        }, { parent: this }))

    // Add route53 query logging for VPC if not enabled to monitor for injection
    if (!resolverQueryLogGroupName) {
      // Create route53 query logging
      const resolverQueryLogConfig = new aws.route53.ResolverQueryLogConfig(
        `${name}-r53-resolver-query-log-config`,
        {
          destinationArn: resolverQueryLogGroup.arn,
        },
        { parent: this },
      )

      // Associate route53 query logging with target VPC
      const resolverQueryLogConfigAssociation = new aws.route53.ResolverQueryLogConfigAssociation(
        `${name}-r53-resolver-query-log-config-association`,
        {
          resolverQueryLogConfigId: resolverQueryLogConfig.id,
          resourceId: vpcId,
        },
        { parent: this },
      )
    }

    // Create assumed role for validate injection Lambda
    const validateInjectionFnRole = new aws.iam.Role(
      `${name}-validate-injection-fn-role`,
      {
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
      },
      { parent: this },
    )

    // Grant permissions to validate injection Lambda role
    const validateInjectionFnPolicy = new aws.iam.RolePolicy(
      `${name}-validate-injection-fn-policy`,
      {
        role: validateInjectionFnRole.id,
        policy: {
          Version: '2012-10-17',
          Statement: [
            {
              Action: ['ssm:GetParameter'],
              Effect: 'Allow',
              Resource: pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${injectionTaskTokenSsmParam.name}`,
            },
            {
              Action: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
              Effect: 'Allow',
              Resource: '*',
            },
          ],
        },
      },
      { parent: this },
    )

    // Lambda that validates injection occurred and callback with task token
    const validateInjectionFn = new aws.lambda.Function(
      `${name}-validate-injection-fn`,
      {
        runtime: 'nodejs20.x',
        role: validateInjectionFnRole.arn,
        handler: 'index.handler',
        code: new pulumi.asset.AssetArchive({
          '.': new pulumi.asset.FileArchive(
            path.join(
              __dirname,
              '..',
              'lambdas',
              'validate-task',
            ),
          ),
        }),
        environment: {
          variables: {
            TASK_TOKEN_PARAMETER_NAME: injectionTaskTokenSsmParam.name,
          },
        },
      },
      { parent: this },
    )

    // Create assumed role for validate remediation Lambda
    const validateRemediationFnRole = new aws.iam.Role(
      `${name}-validate-remediation-fn-role`,
      {
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
      },
      { parent: this },
    )

    // Grant permissions to validate remediation Lambda role
    const validateRemediationFnPolicy = new aws.iam.RolePolicy(
      `${name}-validate-remediation-fn-policy`,
      {
        role: validateRemediationFnRole.id,
        policy: {
          Version: '2012-10-17',
          Statement: [
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
          ],
        },
      },
      { parent: this },
    )

    // Lambda that validates remediation occurred and callback with task token
    const validateRemediationFn = new aws.lambda.Function(
      `${name}-validate-remediation-fn`,
      {
        runtime: 'nodejs20.x',
        role: validateRemediationFnRole.arn,
        handler: 'index.handler',
        code: new pulumi.asset.AssetArchive({
          '.': new pulumi.asset.FileArchive(
            path.join(
              __dirname,
              '..',
              'lambdas',
              'validate-task',
            ),
          ),
        }),
        environment: {
          variables: {
            TASK_TOKEN_PARAMETER_NAME: remediationTaskTokenSsmParam.name,
          },
        },
      },
      { parent: this },
    )

    // Transforms route53 resolver C2 domain query logs to cloudwatch metrics
    const injectionLogMetricFilter = new aws.cloudwatch.LogMetricFilter(
      `${name}-injection-log-metric-filter`,
      {
        logGroupName: resolverQueryLogGroup.name,
        pattern: `{ $.query_name = "${c2Domain ?? 'guarddutyc2activityb.com'}." }`,
        metricTransformation: {
          name: `${name}-malicious-dns-queries`,
          namespace: 'ChaosExperiments/Ec2C2Dns',
          value: '1',
        },
      },
      { parent: this },
    )

    // Triggers successful injection Lambda on alarm and successful remediation Lambda on ok
    const injectionMetricAlarm = new aws.cloudwatch.MetricAlarm(
      `${name}-metric-alarm`,
      {
        metricName: injectionLogMetricFilter.metricTransformation.name,
        namespace: 'ChaosExperiments/Ec2C2Dns',
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
        evaluationPeriods: 1,
        period: 60, // check every 60 seconds
        statistic: 'SampleCount',
        threshold: 1,
        actionsEnabled: true,
        treatMissingData: 'notBreaching',
        alarmDescription: 'Monitors count of C2 domain DNS queries',
        alarmActions: [validateInjectionFn.arn],
        okActions: [validateRemediationFn.arn],
      },
      { parent: this },
    )

    // Grants permission to Cloudwatch Alarm to invoke validate injection function
    const alarmInjectionFnPermission = new aws.lambda.Permission(`${name}-alarm-injection-fn-permission`, {
      function: validateInjectionFn.name,
      action: 'lambda:InvokeFunction',
      principal: 'lambda.alarms.cloudwatch.amazonaws.com',
      sourceAccount: callerIdentity.accountId,
      sourceArn: injectionMetricAlarm.arn,
    }, { parent: this })

    // Grants permission to Cloudwatch Alarm to invoke validate remediation function
    const alarmRemediationFnPermission = new aws.lambda.Permission(
      `${name}-alarm-remediation-fn-permission`,
      {
        function: validateRemediationFn.name,
        action: 'lambda:InvokeFunction',
        principal: 'lambda.alarms.cloudwatch.amazonaws.com',
        sourceAccount: callerIdentity.accountId,
        sourceArn: injectionMetricAlarm.arn,
      },
      { parent: this },
    )

    // Create assumed role for validate detection Lambda
    const validateDetectionFnRole = new aws.iam.Role(
      `${name}-validate-detection-fn-role`,
      {
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
      },
      { parent: this },
    )

    // Grant permissions to validate detection Lambda role
    const validateDetectionFnPolicy = new aws.iam.RolePolicy(
      `${name}-validate-detection-fn-policy`,
      {
        role: validateDetectionFnRole.id,
        policy: {
          Version: '2012-10-17',
          Statement: [
            {
              Action: ['ssm:GetParameter'],
              Effect: 'Allow',
              Resource: pulumi.interpolate`arn:aws:ssm:${region.name}:${callerIdentity.accountId}:parameter${detectionTaskTokenSsmParam.name}`,
            },
            {
              Action: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
              Effect: 'Allow',
              Resource: '*',
            },
          ],
        },
      },
      { parent: this },
    )

    // Lambda that validates GuardDuty detection occurred and callback with task token
    const validateDetectionFn = new aws.lambda.Function(
      `${name}-validate-detection-fn`,
      {
        runtime: 'nodejs20.x',
        role: validateDetectionFnRole.arn,
        handler: 'index.handler',
        code: new pulumi.asset.AssetArchive({
          '.': new pulumi.asset.FileArchive(
            path.join(
              __dirname,
              '..',
              'lambdas',
              'validate-task',
            ),
          ),
        }),
        environment: {
          variables: {
            TASK_TOKEN_PARAMETER_NAME: detectionTaskTokenSsmParam.name,
          },
        },
      },
      { parent: this },
    )

    // Create assumed role for EventBridge Filter
    const injectionFilterRole = new aws.iam.Role(`${name}-injection-filter-role`, {
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
    }, { parent: this })

    // Grant lambda invoke permissions to EventBridge Filter role
    const injectionFilterRolePolicy = new aws.iam.RolePolicy(
      `${name}-injection-filter-role-policy`,
      {
        role: injectionFilterRole,
        policy: {
          Version: '2012-10-17',
          Statement: [
            {
              Action: ['lambda:InvokeFunction'],
              Effect: 'Allow',
              Resource: [
                validateDetectionFn.arn,
                pulumi.interpolate`${validateDetectionFn.arn}:*`,
              ],
            },
          ],
        },
      },
      { parent: this },
    )

    // EventBridge rule that triggers on C2 GuardDuty finding
    const detectionEbRule = new aws.cloudwatch.EventRule(`${name}-detection-eb-rule`, {
      name: `${name}-detection-eb-rule`,
      eventPattern: JSON.stringify(
        {
          'source': ['aws.guardduty'],
          'detail-type': ['GuardDuty Finding'],
          'detail': {
            type: ['Backdoor:EC2/C&CActivity.B!DNS'],
          },
        },
      ),
    }, { parent: this })

    // Grants permission to EventBridge Filter to invoke validate detection function
    const detectionEbRuleFnPermission = new aws.lambda.Permission(
      `${name}-detection-eb-rule-fn-permission`,
      {
        function: validateDetectionFn.name,
        action: 'lambda:InvokeFunction',
        principal: 'events.amazonaws.com',
        sourceAccount: callerIdentity.accountId,
        sourceArn: detectionEbRule.arn,
      },
      { parent: validateDetectionFn },
    )

    // Invokes validate detection function when rule triggers
    const detectionEbRuleTarget = new aws.cloudwatch.EventTarget(`${name}-detection-eb-rule-target`, {
      rule: detectionEbRule.name,
      arn: validateDetectionFn.arn,
    }, { parent: detectionEbRule })

    this.stateMachine = targetEc2.id.apply(instanceId => new aws.sfn.StateMachine(
      `${name}-sfn`,
      {
        roleArn: sfnRole.arn,
        definition: JSON.stringify(createStateMachine(instanceId)),
      },
      { parent: this },
    ))
  }
}
