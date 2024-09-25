import { cwd } from 'node:process'
import { join } from 'node:path'
import fs from 'node:fs/promises'

import { defineCommand } from 'citty'
import inquirer from 'inquirer'
import { confirm } from '@inquirer/prompts'
import { execa } from 'execa'

import { bold, greenBright } from 'colorette'
import consola from 'consola'

import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js'
import type { ConfigFile } from '../config.js'

export default defineCommand({
  meta: {
    name: 'init',
    description: 'Initialize / scaffold the Rojak Pulumi stack.',
  },
  args: {
    region: {
      type: 'string',
      default: 'ap-southeast-1',
    },
  },
  async run(ctx) {
    let configFile: ConfigFile | null = null
    try {
      configFile = JSON.parse(await fs.readFile('rojak.config.json', 'utf-8')) as ConfigFile
    }
    catch { }

    if (!configFile) {
      const config = await inquirer.prompt<{ projectName: string, environmentName: string, teamName: string }>([
        {
          type: 'input',
          name: 'projectName',
          message: 'What is your project name?',
          validate(input) {
            return !!input.length
          },
        },
        {
          type: 'input',
          name: 'environmentName',
          message: 'What is your environment name (leave blank if you intend to use one S3 bucket for multiple environments)?',
        },
        {
          type: 'input',
          name: 'teamName',
          message: 'What is your team name?',
          validate(input) {
            return !!input.length
          },
        },
      ])

      consola.start('Bootstrapping Pulumi...')

      await execa('mkdir', ['-p', '__rojak'])

      const bootstrapStack = await LocalWorkspace.createOrSelectStack({
        stackName: 'rojak',
        projectName: 'rojak',
        async program() {
          const provider = new aws.Provider('main', {
            defaultTags: {
              tags: {
                env: config.environmentName,
                project: config.projectName,
                pulumi: 'true',
                team: config.teamName,
              },
            },
            // @ts-expect-error String -> Region type conversion
            region: ctx.args.region,
          })

          const stateNameParts = [config.projectName]
          if (config.environmentName)
            stateNameParts.push('-', config.environmentName)
          const stateName = stateNameParts.join('')

          // A private S3 bucket to store Pulumi states/locks/history etc.
          const bucket = new aws.s3.BucketV2(
            `${stateName}-private-bucket`,
            {},
            { provider },
          )

          const bucketSSEConfig = new aws.s3.BucketServerSideEncryptionConfigurationV2(
            `${stateName}-sse-config`,
            {
              bucket: bucket.id,
              rules: [
                {
                  applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' },
                  bucketKeyEnabled: true,
                },
              ],
            },
            { parent: bucket },
          )

          const ownershipControls = new aws.s3.BucketOwnershipControls(
            `${stateName}-ownership-controls`,
            {
              bucket: bucket.id,
              rule: { objectOwnership: 'BucketOwnerEnforced' },
            },
            { parent: bucket },
          )

          const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
            `${stateName}-public-access-block`,
            {
              bucket: bucket.id,
              blockPublicAcls: true,
              blockPublicPolicy: true,
              ignorePublicAcls: true,
              restrictPublicBuckets: true,
            },
            { parent: bucket },
          )

          // A key to encrypt/decrypt secrets in Pulumi
          const key = new aws.kms.Key(`${stateName}-key`, {})
          // Use alias to make the key readable in AWS UI
          const alias = new aws.kms.Alias(
            `${stateName}-key-alias`,
            {
              name: `alias/${stateName}-pulumi-key`,
              targetKeyId: key.keyId,
            },
            {
              parent: key,
              // must delete before replace, otherwise the specified alias name above will cause conflict
              deleteBeforeReplace: true,
            },
          )

          const currentRegion = pulumi.output(aws.getRegion())

          return {
            s3Uri: pulumi.interpolate`s3://${bucket.id}`,
            keyUri: pulumi.interpolate`awskms://${alias.name}?region=${currentRegion.name}`,
          }
        },
      }, {
        envVars: {
          PULUMI_CONFIG_PASSPHRASE: '',
        },
        projectSettings: {
          name: `rojak`,
          runtime: 'nodejs',
          backend: {
            url: `file://${join(cwd(), '__rojak')}`,
          },
        },
      })

      consola.success('Successfully initialized stack')
      consola.start('Installing Pulumi plugins')

      await bootstrapStack.workspace.installPlugin('aws', 'v6.47.0')

      consola.success('Pulumi plugins installed')
      consola.start('Previewing Pulumi update')

      // Using 'always' because this script is ran in dev machines
      await bootstrapStack.preview({ color: 'always', onOutput: consola.withTag('Pulumi Preview').log })

      const updateConfirmation = await confirm({ message: 'Apply stack?', default: false })
      if (!updateConfirmation) {
        consola.info('Exiting... bye bye')
        return
      }

      const res = await bootstrapStack.up({ color: 'always', onOutput: consola.withTag('Pulumi Up').log })

      configFile = {
        s3Uri: {
          value: res.outputs.s3Uri.value,
          secret: res.outputs.s3Uri.secret,
        },
        keyUri: {
          value: res.outputs.keyUri.value,
          secret: res.outputs.keyUri.secret,
        },
      }

      fs.writeFile('rojak.config.json', JSON.stringify(res.outputs))
      await execa('rm', ['-rf', '__rojak'])
    }

    consola.box([
      greenBright(bold('Finished initializing Rojak Chaos Experiments!')),
      '',
      'Run `up --help` to list available experiments.',

    ].join('\n'))
  },
})
