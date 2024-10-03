import fs from 'node:fs/promises'
import { defineCommand } from 'citty'
import type { Stack } from '@pulumi/pulumi/automation/index.js'
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js'
import { GetExecutionHistoryCommand, ListExecutionsCommand, SFNClient } from '@aws-sdk/client-sfn'

import { consola } from 'consola'
import { bold, red, underline } from 'colorette'
import type { StackNames } from '../common/stack-names.js'
import { stackNames } from '../common/stack-names.js'
import type { ConfigFile } from '../config.js'

function toMinutesSecondsString(ms: number) {
  return `${Math.floor(ms / 1000 / 60)} minutes ${Math.floor(ms / 1000 % 6)} seconds`
}

export default defineCommand({
  meta: {
    name: 'stats',
    description: 'Get chaos test results.',
  },
  async run() {
    const configFile = JSON.parse(await fs.readFile('rojak.config.json', 'utf-8')) as ConfigFile

    const stacks: Partial<Record<StackNames, Stack>> = {}

    for (const stackName of stackNames) {
      try {
        stacks[stackName] = await LocalWorkspace.selectStack({
          projectName: 'rojak',
          stackName,
          async program() { },
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
      }
      catch {
      }
    }

    const stats: Partial<Record<StackNames, { startDate: Date, detectionDate?: Date, remediationDate?: Date }>> = {}

    for (const stackName in stacks) {
      const stack = stacks[stackName as StackNames]!
      const outputs = await stack.outputs()

      if (!outputs.provisioned)
        continue

      if (!outputs.stateMachine)
        continue

      const sfnArn = outputs.stateMachine.value.arn

      const sfnClient = new SFNClient({})

      const executions = await sfnClient.send(new ListExecutionsCommand({
        stateMachineArn: sfnArn,
      }))

      const latest = executions.executions?.[0]

      const executionTimeline = await sfnClient.send(new GetExecutionHistoryCommand({
        executionArn: latest?.executionArn,
      }))

      const injectionStartedEvent = executionTimeline.events?.find(e => e.type === 'TaskStateExited' && e.stateExitedEventDetails?.name === 'WaitForInjection')
      if (!injectionStartedEvent)
        throw new Error('Could not find injection started event.')

      const injectionDetectedEvent = executionTimeline.events?.find(e => e.type === 'TaskStateExited' && e.stateExitedEventDetails?.name === 'WaitForDetection')

      const injectionRemediatedEvent = executionTimeline.events?.find(e => e.type === 'TaskStateExited' && e.stateExitedEventDetails?.name === 'WaitForRemediation')

      stats[stackName as StackNames] = {
        startDate: injectionStartedEvent.timestamp!,
        detectionDate: injectionDetectedEvent?.timestamp,
        remediationDate: injectionRemediatedEvent?.timestamp,
      }
    }

    consola.box(Object.keys(stats).map((key) => {
      const stat = stats[key as StackNames]

      return [
        underline(bold(`Statistics for ${key}`)),
        '',
        bold('Time to detection: ') + (stat?.detectionDate ? `${toMinutesSecondsString(stat?.detectionDate.getTime() - stat.startDate.getTime())}` : red('Not detected or measured')),
        bold('Time to remediation: ') + (stat?.remediationDate ? `${toMinutesSecondsString(stat?.remediationDate.getTime() - stat.startDate.getTime())}` : red('Not remediated')),
      ].join('\n')
    }).flatMap(e => e).join('\n\n'))
  },
})
