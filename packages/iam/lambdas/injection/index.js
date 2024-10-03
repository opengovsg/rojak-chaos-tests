const { CloudTrailClient, StopLoggingCommand } = require('@aws-sdk/client-cloudtrail')

async function handler(event, context, callback) {
  const client = new CloudTrailClient({
    credentials: {
      accessKeyId: process.env.COMPROMISED_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.COMPROMISED_AWS_SECRET_ACCESS_KEY,
    },
  })

  const command = new StopLoggingCommand({
    Name: process.env.CLOUDTRAIL_NAME,
  })

  await client.send(command)
}

exports.handler = handler
