export function createStateMachine(fnArn: string) {
  return {
    Comment: 'State machine for the IAM chaos experiment',
    StartAt: 'StartChaosTest',
    States: {
      StartChaosTest: {
        Type: 'Parallel',
        Branches: [
          {
            StartAt: 'StartInjection',
            States: {
              StartInjection: {
                Type: 'Task',
                Resource: 'arn:aws:states:::lambda:invoke',
                OutputPath: '$.Payload',
                Parameters: {
                  'Payload.$': '$',
                  'FunctionName': `${fnArn}:$LATEST`,
                },
                Retry: [
                  {
                    ErrorEquals: [
                      'Lambda.ServiceException',
                      'Lambda.AWSLambdaException',
                      'Lambda.SdkClientException',
                      'Lambda.TooManyRequestsException',
                    ],
                    IntervalSeconds: 1,
                    MaxAttempts: 3,
                    BackoffRate: 2,
                  },
                  {
                    ErrorEquals: [
                      'States.Timeout',
                      'Lambda.Unknown',
                    ],
                    IntervalSeconds: 1,
                    Comment: 'Retry on timeout for 1 hour',
                    MaxAttempts: 3,
                  },
                ],
                TimeoutSeconds: 905,
                Catch: [
                  {
                    ErrorEquals: [
                      'States.Timeout',
                    ],
                    Next: 'Fail',
                  },
                ],
                End: true,
              },
              Fail: {
                Type: 'Fail',
              },
            },
          },
          {
            StartAt: 'WaitForInjection',
            States: {
              WaitForInjection: {
                Type: 'Task',
                Resource: 'arn:aws:states:::aws-sdk:ssm:putParameter.waitForTaskToken',
                HeartbeatSeconds: 600,
                Parameters: {
                  'Name': '/chaosexperiments/iam/cloudtraildisabled/injection/tasktoken',
                  'Value.$': '$$.Task.Token',
                  'Overwrite': true,
                },
                ResultPath: '$.result',
                Next: 'StartOutcomeMeasurement',
              },
              StartOutcomeMeasurement: {
                Type: 'Parallel',
                Branches: [
                  {
                    StartAt: 'WaitForDetection',
                    States: {
                      WaitForDetection: {
                        Type: 'Task',
                        Parameters: {
                          'Name': '/chaosexperiments/iam/cloudtraildisabled/detection/tasktoken',
                          'Value.$': '$$.Task.Token',
                          'Overwrite': true,
                        },
                        Resource: 'arn:aws:states:::aws-sdk:ssm:putParameter.waitForTaskToken',
                        End: true,
                      },
                    },
                  },
                  {
                    StartAt: 'WaitForRemediation',
                    States: {
                      WaitForRemediation: {
                        Type: 'Task',
                        Resource: 'arn:aws:states:::aws-sdk:ssm:putParameter.waitForTaskToken',
                        HeartbeatSeconds: 1800,
                        Parameters: {
                          'Name': '/chaosexperiments/iam/cloudtraildisabled/remediation/tasktoken',
                          'Value.$': '$$.Task.Token',
                          'Overwrite': true,
                        },
                        ResultPath: '$.result',
                        Next: 'Success',
                      },
                      Success: {
                        Type: 'Succeed',
                      },
                    },
                  },
                ],
                End: true,
              },
            },
          },
        ],
        End: true,
      },
    },
  }
}
