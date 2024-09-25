import consola from 'consola'
import { defineCommand } from 'citty'
import { bold, green } from 'colorette'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { execa } from 'execa'

import { confirm } from '@inquirer/prompts'

import init from './commands/init.js'
import up from './commands/up.js'
import down from './commands/down.js'
import takeover from './commands/takeover.js'
import stats from './commands/stats.js'
import start from './commands/start.js'

export const main = defineCommand({
  subCommands: {
    init,
    up,
    down,
    takeover,
    stats,
    start,
  },
  async setup() {
    consola.start('Fetching AWS credentials...')

    try {
      const client = new STSClient({})
      const command = new GetCallerIdentityCommand({})
      const { Account, UserId } = await client.send(command)

      if (!Account || !UserId)
        throw new Error('Failed to fetch valid AWS credentials')

      consola.success(`Successfully fetched valid AWS Credentials`)
      consola.success(`You are logged in as ${bold(green(UserId))} in AWS Account ID ${bold(green(Account))}`)

      const confirmation = await confirm({ message: 'Are you sure you want to use this AWS account?', default: false })
      if (!confirmation) {
        consola.info('Exiting, bye bye!')
        process.exit()
      }
    }
    catch (err) {
      consola.fail(`Failed to detect valid AWS credentials`)
      consola.fail('Make sure you\'ve configured your AWS CLI by running `aws configure sso` and exported `AWS_PROFILE` to the environment')
      await execa('rm', ['-rf', '.rojak'])
      throw err
    }
  },
})
