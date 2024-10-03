const { SFNClient, SendTaskSuccessCommand } = require('@aws-sdk/client-sfn')
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm')

async function handler(event, context, callback) {
  const ssmClient = new SSMClient({})

  const getParameterCommand = new GetParameterCommand({
    Name: process.env.TASK_TOKEN_PARAMETER_NAME,
  })
  const { Parameter } = await ssmClient.send(getParameterCommand)

  const sfnClient = new SFNClient({})
  const sendTaskSuccessCommand = new SendTaskSuccessCommand({
    taskToken: Parameter?.Value,
    output: JSON.stringify(event),
  })

  await sfnClient.send(sendTaskSuccessCommand)
}

exports.handler = handler
