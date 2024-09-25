import * as fs from 'node:fs/promises'
import { defineCommand } from 'citty'
import consola from 'consola'
import { confirm } from '@inquirer/prompts'
import { $ } from 'execa'
import type { ConfigFile } from '../config.js'

export default defineCommand({
  meta: {
    name: 'takeover',
    description: 'Take over control of Pulumi.',
  },
  async run() {
    const configFile = JSON.parse(await fs.readFile('rojak.config.json', 'utf-8')) as ConfigFile

    const confirmation = await confirm({ message: 'Your current Pulumi config will be replaced! Continue?' })
    if (!confirmation) {
      consola.info('Stopping')
      return
    }

    await $({ stdout: 'inherit', stderr: 'inherit' })`pulumi login ${configFile.s3Uri.value}`
  },
})
