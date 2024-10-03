import path from 'node:path'
import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { createStateMachine } from './state-machine'

export class IamCloudTrailDisabled extends pulumi.ComponentResource {
  public stateMachine: pulumi.Output<aws.sfn.StateMachine>

  constructor(
    name: string,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    const fullName = `${name}-iam-cloudtrail-disabled`
    const region = pulumi.output(aws.getRegion())
    const callerIdentity = pulumi.output(aws.getCallerIdentity({}))
    const targetCloudtrailName = `${name}-target-cloudtrail`
    const controlCloudtrailName = `${name}-control-cloudtrail`

    super(
      '@opengovsg/rojak-chaos-experiments:IamCloudTrailDisabled',
      fullName,
      {},
      opts,
    )

    // MARK: Attacker

    const attackerUser = new aws.iam.User(`${name}-attacker-user`, {
      path: '/system/',
    }, { parent: this })

    const attackerAccessKey = new aws.iam.AccessKey(`${name}-attacker-access-key`, {
      user: attackerUser.name,
    }, { parent: attackerUser })

    const attackerPolicy = new aws.iam.UserPolicy(`${name}-attacker-policy`, {
      name: `${name}-attacker-policy`,
      user: attackerUser.name,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: [
              'cloudtrail:StopLogging',
            ],
            Effect: 'Allow',
            Resource: '*',
          },
        ],
      },
    }, { parent: attackerUser })

    // MARK: Target CloudTrail

    const targetCloudtrailBucket = new aws.s3.BucketV2(`${name}-target-cloudtrail-bucket`, {
      bucketPrefix: `${name}-target-cloudtrail-bucket`,
      forceDestroy: true,
    }, { parent: this })

    const targetCloudtrailBucketPolicy = new aws.s3.BucketPolicy(`${name}-target-cloudtrail-bucket-policy`, {
      bucket: targetCloudtrailBucket.id,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AWSCloudTrailAclCheck',
            Effect: 'Allow',
            Principal: {
              Service: 'cloudtrail.amazonaws.com',
            },
            Action: ['s3:GetBucketAcl'],
            Resource: [targetCloudtrailBucket.arn],
            Condition: {
              StringEquals: {
                'AWS:SourceArn': pulumi.interpolate`arn:aws:cloudtrail:${region.name}:${callerIdentity.accountId}:trail/${targetCloudtrailName}`,
              },
            },
          },
          {
            Sid: 'AWSCloudTrailWrite',
            Effect: 'Allow',
            Principal: {
              Service: 'cloudtrail.amazonaws.com',
            },
            Action: [
              's3:PutObject',
            ],
            Resource: [pulumi.interpolate`arn:aws:s3:::${targetCloudtrailBucket.bucket}/AWSLogs/${callerIdentity.accountId}/*`],
            Condition: {
              StringEquals: {
                's3:x-amz-acl': 'bucket-owner-full-control',
                'AWS:SourceArn': pulumi.interpolate`arn:aws:cloudtrail:${region.name}:${callerIdentity.accountId}:trail/${targetCloudtrailName}`,
              },
            },
          },
        ],
      },
    }, { parent: targetCloudtrailBucket })

    const targetCloudtrail = new aws.cloudtrail.Trail(`${name}-target-cloudtrail`, {
      name: targetCloudtrailName,
      s3BucketName: targetCloudtrailBucket.id,
      eventSelectors: [
        {
          readWriteType: 'All',
          includeManagementEvents: true,
        },
      ],
    }, { parent: this })

    // MARK: Control CloudTrail
    // Ensures that injection and remediation events are logged and sent to EventBridge

    const controlCloudtrailBucket = new aws.s3.BucketV2(`${name}-control-cloudtrail-bucket`, {
      bucketPrefix: `${name}-control-cloudtrail-bucket`,
      forceDestroy: true,
    }, { parent: this })

    const controlCloudtrailBucketPolicy = new aws.s3.BucketPolicy(`${name}-control-cloudtrail-bucket-policy`, {
      bucket: controlCloudtrailBucket.id,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AWSCloudTrailAclCheck',
            Effect: 'Allow',
            Principal: {
              Service: 'cloudtrail.amazonaws.com',
            },
            Action: ['s3:GetBucketAcl'],
            Resource: [controlCloudtrailBucket.arn],
            Condition: {
              StringEquals: {
                'AWS:SourceArn': pulumi.interpolate`arn:aws:cloudtrail:${region.name}:${callerIdentity.accountId}:trail/${controlCloudtrailName}`,
              },
            },
          },
          {
            Sid: 'AWSCloudTrailWrite',
            Effect: 'Allow',
            Principal: {
              Service: 'cloudtrail.amazonaws.com',
            },
            Action: [
              's3:PutObject',
            ],
            Resource: [pulumi.interpolate`arn:aws:s3:::${controlCloudtrailBucket.bucket}/AWSLogs/${callerIdentity.accountId}/*`],
            Condition: {
              StringEquals: {
                's3:x-amz-acl': 'bucket-owner-full-control',
                'AWS:SourceArn': pulumi.interpolate`arn:aws:cloudtrail:${region.name}:${callerIdentity.accountId}:trail/${controlCloudtrailName}`,
              },
            },
          },
        ],
      },
    }, { parent: controlCloudtrailBucket })

    const controlCloudtrail = new aws.cloudtrail.Trail(`${name}-control-cloudtrail`, {
      name: controlCloudtrailName,
      s3BucketName: controlCloudtrailBucket.id,
      eventSelectors: [
        {
          readWriteType: 'All',
          includeManagementEvents: true,
        },
      ],
      isMultiRegionTrail: true, // Necessary to log IAM events which are on us-east-1
    }, { parent: this })

    // MARK: SSM Parameters

    const injectionTaskTokenSsmParam = new aws.ssm.Parameter(`${name}-injection-task-token-ssm-param`, {
      name: '/chaosexperiments/iam/cloudtraildisabled/injection/tasktoken',
      type: aws.ssm.ParameterType.String,
      value: 'PLACEHOLDER',
    }, { parent: this })

    const detectionTaskTokenSsmParam = new aws.ssm.Parameter(`${name}-detection-task-token-ssm-param`, {
      name: '/chaosexperiments/iam/cloudtraildisabled/detection/tasktoken',
      type: aws.ssm.ParameterType.String,
      value: 'PLACEHOLDER',
    }, { parent: this })

    const remediationTaskTokenSsmParam = new aws.ssm.Parameter(`${name}-remediation-task-token-ssm-param`, {
      name: '/chaosexperiments/iam/cloudtraildisabled/remediation/tasktoken',
      type: aws.ssm.ParameterType.String,
      value: 'PLACEHOLDER',
    }, { parent: this })

    // MARK: Injection Function

    const injectionLogGroup = new aws.cloudwatch.LogGroup(`${name}-injection-log-group`, {}, { parent: this })

    const injectionRole = new aws.iam.Role(`${name}-injection-fn-role`, {
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

    const injectionFn = new aws.lambda.Function(`${name}-injection-fn`, {
      runtime: 'nodejs20.x',
      role: injectionRole.arn,
      handler: 'index.handler',
      loggingConfig: {
        logFormat: 'JSON',
        logGroup: injectionLogGroup.name,
        applicationLogLevel: 'DEBUG',
      },
      environment: {
        variables: {
          COMPROMISED_AWS_ACCESS_KEY_ID: attackerAccessKey.id,
          COMPROMISED_AWS_SECRET_ACCESS_KEY: attackerAccessKey.secret,
          CLOUDTRAIL_NAME: targetCloudtrail.name,
        },
      },
      code: new pulumi.asset.AssetArchive({
        '.': new pulumi.asset.FileArchive(
          path.join(
            __dirname,
            '..',
            'lambdas',
            'injection',
          ),
        ),
      }),
    }, { parent: this })

    // MARK: Validate Injection

    const validateInjectionFnRole = new aws.iam.Role(`${name}-validate-injection-fn-role`, {
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [{
          Action: 'sts:AssumeRole',
          Principal: {
            Service: 'lambda.amazonaws.com',
          },
          Effect: 'Allow',
          Condition: {
            ArnLike: {
              'aws:sourceArn': pulumi.interpolate`arn:aws:lambda:${region.name}:${callerIdentity.accountId}:function:*`,
            },
            StringEquals: {
              'aws:SourceAccount': pulumi.output(callerIdentity.accountId),
            },
          },
        }],
      },
    }, { parent: this })

    const validateInjectionFnPolicy = new aws.iam.RolePolicy(`${name}-validate-injection-fn-policy`, {
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
    }, { parent: this })

    const validateInjectionFn = new aws.lambda.Function(`${name}-validate-injection-fn`, {
      runtime: 'nodejs20.x',
      role: validateInjectionFnRole.arn,
      handler: 'index.handler',
      code: new pulumi.asset.AssetArchive({
        '.': new pulumi.asset.FileArchive(path.join(__dirname, '..', `lambdas`, 'validate-task')),
      }),
      environment: {
        variables: {
          TASK_TOKEN_PARAMETER_NAME: injectionTaskTokenSsmParam.name,
        },
      },
    }, { parent: this })

    const injectionEbRuleRole = new aws.iam.Role(`${name}-injection-eb-rule-role`, {
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

    const injectionEbRuleRolePolicy = new aws.iam.RolePolicy(`${name}-injection-eb-rule-role-policy`, {
      role: injectionEbRuleRole,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: ['lambda:InvokeFunction'],
            Effect: 'Allow',
            Resource: [
              validateInjectionFn.arn,
              pulumi.interpolate`${validateInjectionFn.arn}:*`,
            ],
          },
        ],
      },
    }, { parent: injectionEbRuleRole })

    const injectionEbRule = new aws.cloudwatch.EventRule(`${name}-injection-eb-rule`, {
      name: `${name}-injection-eb-rule`,
      eventPattern: targetCloudtrail.name.apply(name => JSON.stringify(
        {
          'source': ['aws.cloudtrail'],
          'detail-type': ['AWS API Call via CloudTrail'],
          'detail': {
            eventSource: ['cloudtrail.amazonaws.com'],
            eventName: ['StopLogging'],
            requestParameters: {
              name: [name],
            },
          },
        },
      ),
      ),
    }, { parent: this })

    const injectionEbRuleFnPermission = new aws.lambda.Permission(`${name}-injection-eb-rule-fn-permission`, {
      function: validateInjectionFn.name,
      action: 'lambda:InvokeFunction',
      principal: 'events.amazonaws.com',
      sourceArn: injectionEbRule.arn,
    }, { parent: validateInjectionFn })

    const injectionEbRuleTarget = new aws.cloudwatch.EventTarget(`${name}-injection-eb-rule-target`, {
      rule: injectionEbRule.name,
      arn: validateInjectionFn.arn,
    }, { parent: injectionEbRule })

    // MARK: Validate Detection

    const validateDetectionFnRole = new aws.iam.Role(`${name}-validate-detection-fn-role`, {
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [{
          Action: 'sts:AssumeRole',
          Principal: {
            Service: 'lambda.amazonaws.com',
          },
          Effect: 'Allow',
          Condition: {
            ArnLike: {
              'aws:sourceArn': pulumi.interpolate`arn:aws:lambda:${region.name}:${callerIdentity.accountId}:function:*`,
            },
            StringEquals: {
              'aws:SourceAccount': pulumi.output(callerIdentity.accountId),
            },
          },
        }],
      },
    }, { parent: this })

    const validateDetectionFnPolicy = new aws.iam.RolePolicy(`${name}-validate-detection-fn-policy`, {
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
    }, { parent: this })

    const validateDetectionFn = new aws.lambda.Function(`${name}-ebf-fn`, {
      runtime: 'nodejs20.x',
      role: validateDetectionFnRole.arn,
      handler: 'index.handler',
      code: new pulumi.asset.AssetArchive({
        '.': new pulumi.asset.FileArchive(path.join(__dirname, '..', `lambdas`, 'validate-task')),
      }),
      environment: {
        variables: {
          TASK_TOKEN_PARAMETER_NAME: detectionTaskTokenSsmParam.name,
        },
      },
    }, { parent: this })

    const detectionEbRuleRole = new aws.iam.Role(`${name}-detection-eb-rule-role`, {
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

    const detectionEbRuleRolePolicy = new aws.iam.RolePolicy(`${name}-detection-eb-rule-role-policy`, {
      role: detectionEbRuleRole,
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
    }, { parent: detectionEbRuleRole })

    const detectionEbRule = new aws.cloudwatch.EventRule(`${name}-detection-eb-rule`, {
      name: `${name}-detection-eb-rule`,
      eventPattern: JSON.stringify(
        {
          'source': ['aws.guardduty'],
          'detail-type': ['GuardDuty Finding'],
          'detail': {
            type: ['Stealth:IAMUser/CloudTrailLoggingDisabled'],
          },
        },
      ),
    }, { parent: this })

    const detectionEbRuleFnPermission = new aws.lambda.Permission(`${name}-detection-eb-rule-fn-permission`, {
      function: validateDetectionFn.name,
      action: 'lambda:InvokeFunction',
      principal: 'events.amazonaws.com',
      sourceArn: detectionEbRule.arn,
    }, { parent: validateDetectionFn })

    const detectionEbRuleTarget = new aws.cloudwatch.EventTarget(`${name}-detection-eb-rule-target`, {
      rule: detectionEbRule.name,
      arn: validateDetectionFn.arn,
    }, { parent: detectionEbRule })

    // MARK: Validate Remediation

    // Create cross-region event routing because IAM events are on us-east-1
    const awsUsEast1 = new aws.Provider('aws-us-east-1', { region: 'us-east-1' })

    const crossRegionEbRuleRole = new aws.iam.Role(`${name}-cross-region-eb-rule-role`, {
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
    }, { parent: this, provider: awsUsEast1 })

    const crossRegionEbRuleRolePolicy = new aws.iam.RolePolicy(`${name}-cross-region-eb-rule-role-policy`, {
      role: crossRegionEbRuleRole,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: ['events:PutEvents'],
            Effect: 'Allow',
            Resource: [
              pulumi.interpolate`arn:aws:events:${region.name}:${callerIdentity.accountId}:event-bus/*`,
            ],
          },
        ],
      },
    }, { parent: crossRegionEbRuleRole, provider: awsUsEast1 })

    const crossRegionEbRule = new aws.cloudwatch.EventRule(`${name}-cross-region-eb-rule`, {
      name: `${name}-cross-region-eb-rule`,
      eventPattern: attackerAccessKey.id.apply(id => JSON.stringify(
        {
          detail: {
            eventSource: ['iam.amazonaws.com'],
            eventName: ['UpdateAccessKey'],
            requestParameters: {
              accessKeyId: [id],
              status: ['Inactive'],
            },
          },
        },
      ),
      ),
    }, { parent: this, provider: awsUsEast1 })

    const defaultEventBus = aws.cloudwatch.getEventBusOutput({
      name: 'default',
    })

    const crossRegionEbRuleTarget = new aws.cloudwatch.EventTarget(`${name}-cross-region-eb-rule-target`, {
      rule: crossRegionEbRule.name,
      arn: defaultEventBus.arn,
      roleArn: crossRegionEbRuleRole.arn,
    }, { parent: crossRegionEbRule, provider: awsUsEast1 })

    const validateRemediationFnRole = new aws.iam.Role(`${name}-validate-remediation-fn-role`, {
      assumeRolePolicy: {
        Version: '2012-10-17',
        Statement: [{
          Action: 'sts:AssumeRole',
          Principal: {
            Service: 'lambda.amazonaws.com',
          },
          Effect: 'Allow',
          Condition: {
            ArnLike: {
              'aws:sourceArn': pulumi.interpolate`arn:aws:lambda:${region.name}:${callerIdentity.accountId}:function:*`,
            },
            StringEquals: {
              'aws:SourceAccount': pulumi.output(callerIdentity.accountId),
            },
          },
        }],
      },
    }, { parent: this })

    const validateRemediationFnPolicy = new aws.iam.RolePolicy(`${name}-validate-remediation-fn-policy`, {
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
    }, { parent: this })

    const validateRemediationFn = new aws.lambda.Function(`${name}-validate-remediation-fn`, {
      runtime: 'nodejs20.x',
      role: validateRemediationFnRole.arn,
      handler: 'index.handler',
      code: new pulumi.asset.AssetArchive({
        '.': new pulumi.asset.FileArchive(path.join(__dirname, '..', `lambdas`, 'validate-task')),
      }),
      environment: {
        variables: {
          TASK_TOKEN_PARAMETER_NAME: remediationTaskTokenSsmParam.name,
        },
      },
    }, { parent: this })

    const remediationEbRuleRole = new aws.iam.Role(`${name}-remediation-eb-rule-role`, {
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

    const remediationEbRuleRolePolicy = new aws.iam.RolePolicy(`${name}-remediation-eb-rule-role-policy`, {
      role: remediationEbRuleRole,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: ['lambda:InvokeFunction'],
            Effect: 'Allow',
            Resource: [
              validateRemediationFn.arn,
              pulumi.interpolate`${validateRemediationFn.arn}:*`,
            ],
          },
        ],
      },
    }, { parent: remediationEbRuleRole })

    const remediationEbRule = new aws.cloudwatch.EventRule(`${name}-remediation-eb-rule`, {
      name: `${name}-remediation-eb-rule`,
      eventPattern: attackerAccessKey.id.apply(id => JSON.stringify(
        {
          detail: {
            eventSource: ['iam.amazonaws.com'],
            eventName: ['UpdateAccessKey'],
            requestParameters: {
              accessKeyId: [id],
              status: ['Inactive'],
            },
          },
        },
      ),
      ),
    }, { parent: this })

    const remediationEbRuleFnPermission = new aws.lambda.Permission(`${name}-remediation-eb-rule-fn-permission`, {
      function: validateRemediationFn.name,
      action: 'lambda:InvokeFunction',
      principal: 'events.amazonaws.com',
      sourceArn: remediationEbRule.arn,
    }, { parent: validateRemediationFn })

    const remediationEbRuleTarget = new aws.cloudwatch.EventTarget(`${name}-remediation-eb-rule-target`, {
      rule: remediationEbRule.name,
      arn: validateRemediationFn.arn,
    }, { parent: remediationEbRule })

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
            Action: ['fis:GetExperiment'],
            Effect: 'Allow',
            Resource: '*', // experiment ID is not known ahead of time
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
          {
            Action: ['lambda:InvokeFunction'],
            Effect: 'Allow',
            Resource: [
              validateDetectionFn.arn,
              pulumi.interpolate`${injectionFn.arn}:*`,
            ],
          },
        ],
      },
    }, { parent: sfnRole })

    this.stateMachine = injectionFn.arn.apply(fnArn => new aws.sfn.StateMachine(`${name}-sfn`, {
      roleArn: sfnRole.arn,
      definition: JSON.stringify(createStateMachine(fnArn)),
    }, { parent: this }))
  }
}
