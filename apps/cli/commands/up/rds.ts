import fs from 'node:fs/promises'
import { defineCommand } from 'citty'
import { confirm, input } from '@inquirer/prompts'
import consola from 'consola'
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js'
import { RdsSuccessfulBruteForce } from '@opengovsg/rojak-rds'
import type { ConfigFile } from '../../config'

export default defineCommand({
  meta: {
    name: 'rds',
    description: 'Simulates successful brute-forcing of your RDS database.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Force Pulumi deployment',
      alias: ['f'],
    },
    vpcId: {
      type: 'string',
      description: 'The VPC to connect the brute force Lambda to.',
    },
    subnetId: {
      type: 'string',
      description: 'The subnet to connect the brute force Lambda to. Must reside in the VPC provided.',
    },
    host: {
      type: 'string',
      description: 'The database hostname.',
    },
    port: {
      type: 'string',
      description: 'The database port number.',
    },
    user: {
      type: 'string',
      description: 'The username to simulate successful brute force.',
    },
    password: {
      type: 'string',
      description: 'The password to simulate successful brute force.',
    },
    bruteForceCount: {
      type: 'string',
      description: 'Number of times to attempt connecting to RDS.',
    },
  },
  async run(ctx) {
    ctx.args.vpcId ??= await input({
      message: 'What is the VPC ID your RDS instance resides in?',
    })

    if (ctx.args.vpcId) {
      ctx.args.subnetId ??= await input({
        message: 'What is the subnet ID your RDS instance resides in?',
      })
    }

    ctx.args.host ??= await input({
      message: 'What is the hostname of your RDS instance?',
    })
    ctx.args.port ??= await input({
      message: 'What is the port of your RDS instance?',
    })

    ctx.args.user ??= await input({
      message: 'What is the username of your RDS instance?',
    })
    ctx.args.password ??= await input({
      message: 'What is the password of your RDS instance?',
    })

    ctx.args.bruteForceCount ??= await input({
      message: 'How many times should login be attempted?',
      validate(value) {
        return !Number.isNaN(Number.parseInt(value))
      },
    })

    const configFile = JSON.parse(await fs.readFile('rojak.config.json', 'utf-8')) as ConfigFile

    const chaosStack = await LocalWorkspace.createOrSelectStack({
      stackName: 'rds',
      projectName: 'rojak',
      async program() {
        const { stateMachine } = new RdsSuccessfulBruteForce('rojak-rds', ctx.args)
        return { provisioned: true, stateMachine }
      },
    }, {
      envVars: {
        PULUMI_CONFIG_PASSPHRASE: '',
      },
      projectSettings: {
        name: 'rojak',
        runtime: 'nodejs',
        backend: {
          url: configFile.s3Uri.value,
        },
      },
    })

    consola.success('Successfully initialized stack')
    consola.start('Installing Pulumi plugins')

    await chaosStack.workspace.installPlugin('aws', 'v6.47.0')

    consola.success('Pulumi plugins installed')
    consola.start('Previewing Pulumi update')

    await chaosStack.preview({ color: 'always', onOutput: consola.withTag('Pulumi Preview').log, refresh: true })

    const upConfirmation = await confirm({ message: 'Apply chaos stack?', default: false })
    if (!upConfirmation) {
      consola.info('Exiting... bye bye')
      return
    }

    if (ctx.args.force)
      await chaosStack.cancel()

    await chaosStack.up({ color: 'always', onOutput: consola.withTag('Pulumi Up').log })
  },
})
