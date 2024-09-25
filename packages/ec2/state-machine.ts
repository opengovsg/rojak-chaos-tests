export function createStateMachine(instanceId: string) {
  return {
    Comment: 'State machine for the EC2 command and control (C2) server DNS callback chaos experiment',
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
                Parameters: {
                  InstanceIds: [instanceId],
                },
                Resource: 'arn:aws:states:::aws-sdk:ec2:startInstances',
                End: true,
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
                  'Name': '/chaosexperiments/ec2/c2dns/injection/tasktoken',
                  'Value.$': '$$.Task.Token',
                  'Overwrite': true,
                },
                ResultPath: '$.result',
                Next: 'StartOutcomeMeasurement',
                Catch: [
                  {
                    ErrorEquals: ['States.ALL'],
                    Next: 'FailedInjectionCleanup',
                  },
                ],
              },
              FailedInjectionCleanup: {
                Type: 'Task',
                Parameters: {
                  InstanceIds: [instanceId],
                },
                Resource: 'arn:aws:states:::aws-sdk:ec2:stopInstances',
                End: true,
              },
              StartOutcomeMeasurement: {
                Type: 'Parallel',
                Branches: [
                  {
                    StartAt: 'WaitForDetection',
                    States: {
                      WaitForDetection: {
                        Type: 'Task',
                        Resource: 'arn:aws:states:::aws-sdk:ssm:putParameter.waitForTaskToken',
                        HeartbeatSeconds: 1800,
                        Parameters: {
                          'Name': '/chaosexperiments/ec2/c2dns/detection/tasktoken',
                          'Value.$': '$$.Task.Token',
                          'Overwrite': true,
                        },
                        ResultPath: '$.result',
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
                          'Name': '/chaosexperiments/ec2/c2dns/remediation/tasktoken',
                          'Value.$': '$$.Task.Token',
                          'Overwrite': true,
                        },
                        ResultPath: '$.result',
                        Next: 'Success',
                        Catch: [
                          {
                            ErrorEquals: ['States.ALL'],
                            Next: 'FailedRemediationCleanup',
                          },
                        ],
                      },
                      FailedRemediationCleanup: {
                        Type: 'Task',
                        Parameters: {
                          InstanceIds: [instanceId],
                        },
                        Resource: 'arn:aws:states:::aws-sdk:ec2:stopInstances',
                        End: true,
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
