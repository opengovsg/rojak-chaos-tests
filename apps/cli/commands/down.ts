import * as fs from 'node:fs/promises'
import { defineCommand } from 'citty'
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js'
import consola from 'consola'
import { confirm } from '@inquirer/prompts'
import { stackNames } from '../common/stack-names.js'
import type { ConfigFile } from '../config.js'

export default defineCommand({
  meta: {
    name: 'down',
    description: 'Take down Rojak stack.',
  },
  args: {
    force: {
      type: 'boolean',
      alias: 'f',
    },
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
        consola.info(`Stack ${stackName} does not exist!`)
      }
    }

    const installTasks = stacks.map(async (stack) => {
      await stack.workspace.installPlugin('aws', 'v6.47.0')
    })

    await Promise.all(installTasks)

    const previewTasks = stacks.map(async (stack) => {
      await stack.preview({ color: 'always', onOutput: consola.withTag('Pulumi Down').log, refresh: true })
    })

    await Promise.all(previewTasks)

    const confirmation = await confirm({ message: 'Confirm' })
    if (!confirmation) {
      consola.info('Stopping')
      return
    }

    const downTasks = stacks.map(async (stack) => {
      if (ctx.args.force)
        await stack.cancel()

      await stack.destroy({ color: 'always', onOutput: consola.withTag('Pulumi Destroy').log })
    })

    await Promise.all(downTasks)
  },
})
