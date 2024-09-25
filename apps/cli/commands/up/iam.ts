import fs from 'node:fs/promises'
import { defineCommand } from 'citty'
import { confirm } from '@inquirer/prompts'
import consola from 'consola'
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js'
import { IamCloudTrailDisabled } from '@opengovsg/rojak-iam'
import type { ConfigFile } from '../../config'

export default defineCommand({
  meta: {
    name: 'iam',
    description: 'Simulates a compromised IAM user turning off CloudTrail logging to evade detection.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Force Pulumi deployment',
      alias: ['f'],
    },
  },
  async run(ctx) {
    const configFile = JSON.parse(await fs.readFile('rojak.config.json', 'utf-8')) as ConfigFile

    const chaosStack = await LocalWorkspace.createOrSelectStack({
      stackName: 'iam',
      projectName: 'rojak',
      async program() {
        const { stateMachine } = new IamCloudTrailDisabled('rojak-iam')
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
