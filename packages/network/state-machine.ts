export function createStateMachine(experimentTemplateId: string, faultDuration: number, monitorLambdaArn: string) {
  return {
    Comment: 'State machine for the network chaos experiment',
    StartAt: 'Parallel',
    States: {
      Parallel: {
        Type: 'Parallel',
        Branches: [
          {
            StartAt: 'StartMonitorLambda',
            States: {
              StartMonitorLambda: {
                Type: 'Task',
                Resource: 'arn:aws:states:::aws-sdk:lambda:invoke',
                OutputPath: '$.Payload',
                Parameters: {
                  'Payload.$': '$',
                  'FunctionName': `${monitorLambdaArn}:$LATEST`,
                },
                End: true,
              },
            },
          },
          {
            StartAt: 'StartExperiment',
            States: {
              StartExperiment: {
                Type: 'Task',
                Parameters: {
                  ClientToken: Math.random().toString(36),
                  ExperimentTemplateId: experimentTemplateId,
                },
                Resource: 'arn:aws:states:::aws-sdk:fis:startExperiment',
                Next: 'WaitForInjection',
              },
              WaitForInjection: {
                Type: 'Task',
                Parameters: {
                  'Name': '/chaosexperiments/network/disruption/injection/tasktoken',
                  'Value.$': '$$.Task.Token',
                  'Overwrite': true,
                },
                Resource: 'arn:aws:states:::aws-sdk:ssm:putParameter.waitForTaskToken',
                TimeoutSeconds: faultDuration + 60,
                Catch: [
                  {
                    ErrorEquals: [
                      'States.Timeout',
                    ],
                    Comment: 'System never down',
                    Next: 'Success',
                  },
                ],
                Next: 'WaitForRemediation',
              },
              WaitForRemediation: {
                Type: 'Task',
                Parameters: {
                  'Name': '/chaosexperiments/network/disruption/remediation/tasktoken',
                  'Value.$': '$$.Task.Token',
                  'Overwrite': true,
                },
                Resource: 'arn:aws:states:::aws-sdk:ssm:putParameter.waitForTaskToken',
                TimeoutSeconds: faultDuration + 60,
                Catch: [
                  {
                    ErrorEquals: [
                      'States.Timeout',
                    ],
                    Comment: 'Service never up',
                    Next: 'Fail',
                  },
                ],
                Next: 'Success',
              },
              Fail: {
                Type: 'Fail',
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
  }
}
