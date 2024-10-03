import * as fs from 'node:fs/promises'
import { defineCommand } from 'citty'
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js'
import consola from 'consola'
import { select } from '@inquirer/prompts'
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn"
import { stackNames } from '../common/stack-names.js'
import type { ConfigFile } from '../config.js'

export default defineCommand({
  meta: {
    name: 'start',
    description: 'Start a Rojak chaos test.',
  },
  args: {
    name: {
      type: 'string',
      alias: 'n',
    },
  },
  async run(ctx) {
    const configFile = JSON.parse(await fs.readFile('rojak.config.json', 'utf-8')) as ConfigFile

    const stacks = []
    for (const stackName of ctx.args.name ? [ctx.args.name] : stackNames) {
      try {
        stacks.push(await LocalWorkspace.selectStack({
          stackName,
          projectName: 'rojak',
          async program() {
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
        }))
      }
      catch {
      }
    }

    const stackStateMachineArnMap = new Map()

    for (const stack of stacks) {
      const outputs = await stack.outputs()

      if (!outputs.stateMachine)
        continue

      stackStateMachineArnMap.set(stack.name, outputs.stateMachine.value.arn)
    }

    if (stackStateMachineArnMap.size === 0 && ctx.args.name === undefined) {
      consola.fail('No chaos tests have been deployed yet! Run `up --help` to list available tests')
      return
    }

    ctx.args.name ??= await select({
      message: 'What Rojak chaos test do you want to start?',
      choices: [...stackStateMachineArnMap.keys()].map((stackName) => {
        return {
          value: stackName,
        }
      }),
    })

    if (stackStateMachineArnMap.has(ctx.args.name)) {
      try {
        const client = new SFNClient({})
        const input = {
          stateMachineArn: stackStateMachineArnMap.get(ctx.args.name),
        }
        const command = new StartExecutionCommand(input)
        await client.send(command)
        consola.success('Successfully started chaos test! Run `stats` to check on the progress of the test.')
      } catch (err) {
        consola.fail('Failed to start chaos test!')
        throw err
      }
    } else {
      consola.fail(`${ctx.args.name} chaos test has not been deployed yet! Run \`up --help\` to list available tests`)
    }
    return
  },
})
