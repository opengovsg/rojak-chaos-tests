const { SFNClient, SendTaskSuccessCommand } = require('@aws-sdk/client-sfn')
const { GetParameterCommand, SSMClient } = require('@aws-sdk/client-ssm')

const sleep = () => new Promise(resolve => setTimeout(resolve, 1000))

exports.handler = async (event, context, callback) => {
  if (!process.env.MONITOR_URL)
    throw new Error('Monitor URL is required.')

  const ssmClient = new SSMClient({})
  const sfnClient = new SFNClient({})

  let down = false

  for (let i = 0; i < 900; i++) {
    const { Parameter: { Value: serviceDownTaskToken } } = await ssmClient.send(
      new GetParameterCommand({
        Name: '/chaosexperiments/network/disruption/injection/tasktoken',
      }),
    )

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    try {
      const res = await fetch(process.env.MONITOR_URL, { signal: controller.signal })
      if (res.status < 200 || res.status >= 500)
        throw new Error(`Service is down. Status: ${res.status}`)

      console.log('Service is up.')

      if (down) {
        const { Parameter: { Value: serviceUpTaskToken } } = await ssmClient.send(
          new GetParameterCommand({
            Name: '/chaosexperiments/network/disruption/remediation/tasktoken',
          }),
        )

        await sfnClient.send(
          new SendTaskSuccessCommand({
            taskToken: serviceUpTaskToken,
            output: JSON.stringify({
              now: Date.now(),
              res: JSON.stringify(res, Object.getOwnPropertyNames(res)),
            }),
          }),
        )

        break
      }
    }
    catch (err) {
      console.error(err)

      if (!down) {
        await sfnClient.send(
          new SendTaskSuccessCommand({
            taskToken: serviceDownTaskToken,
            output: JSON.stringify({
              now: Date.now(),
              err: JSON.stringify(err, Object.getOwnPropertyNames(err)),
            }),
          }),
        )

        down = true
      }
    }
    finally {
      clearTimeout(timeoutId)
      await sleep()
    }
  }

  return { success: true }
}
