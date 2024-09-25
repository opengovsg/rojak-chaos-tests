import fs from 'node:fs/promises'
import pg from 'pg'

interface Config {
  host?: string
  port?: number
  user?: string
  password?: string
  region?: string
  bruteForceCount?: number
}

export async function handler() {
  const { SFNClient, SendTaskSuccessCommand } = await import('@aws-sdk/client-sfn')
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm')

  const config: Config = {
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT!),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    region: process.env.AWS_REGION,
    bruteForceCount: process.env.BRUTE_FORCE_COUNT ? Number.parseInt(process.env.BRUTE_FORCE_COUNT!) : 10_000,
  }

  console.log('init with config', config.host, config.port, config.region, config.bruteForceCount)

  if (!config.host || !config.port)
    throw new Error('Invariant')

  const passwords = (await fs.readFile('./passwords.txt', 'utf-8')).split('\n')

  let counter = 0
  let client

  const ssmClient = new SSMClient({})
  const getParameterCommand = new GetParameterCommand({
    Name: '/chaosexperiments/rds/injection/tasktoken',
  })
  const { Parameter } = await ssmClient.send(getParameterCommand)

  console.log('received parameter from ssm', Parameter)

  const sfnClient = new SFNClient({ region: config.region ?? 'ap-southeast-1' })
  const sendTaskSuccessCommand = new SendTaskSuccessCommand({
    taskToken: Parameter?.Value,
    output: JSON.stringify({ started: true }),
  })
  await sfnClient.send(sendTaskSuccessCommand)

  while (counter < config.bruteForceCount!) {
    const password = passwords[counter % passwords.length]

    counter++

    try {
      client = new pg.Client({
        host: config.host,
        port: config.port,
        user: 'postgres',
        password,
        connectionTimeoutMillis: 5000,
      })

      if (counter % 100 === 0)
        console.log('Attempting: ', counter, client.user, client.password)

      await client.connect()
      await client.query('SELECT 1;')
      console.log('Success: ', counter, client.user, client.password)

      break
    }
    catch (err: any) {
      if (err.code === 'ECONNREFUSED') {
        console.log('Failed with timeout: ', err, counter, client?.user, client?.password)
        break
      }

      if (counter % 100 === 0)
        console.log('Failed with invalid credentials: ', counter, client?.user, client?.password, err)
    }
    finally {
      await client?.end()
    }
  }

  if (!config.user || !config.password)
    return

  client = new pg.Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
  })

  console.log('Attempting: ', counter, client.user, client.password)
  await client.connect()
  await client.query('SELECT 1;')
  console.log('Success: ', counter, client.user, client.password)
}
