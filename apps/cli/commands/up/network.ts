import fs from 'node:fs/promises'
import { defineCommand } from 'citty'
import { checkbox, confirm, input, select } from '@inquirer/prompts'
import consola from 'consola'
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js'
import { DescribePrefixListsCommand, DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2'
import type { Fault } from '@opengovsg/rojak-network'
import { NetworkDisruptConnectivity, NetworkDisruptConnectivityWithEc2 } from '@opengovsg/rojak-network'
import type { ConfigFile } from '../../config'
import type { VpcInfo } from '../../common/vpc-info'

export default defineCommand({
  meta: {
    name: 'network',
    description: 'Simulates network disruption in various AWS resources.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Force Pulumi deployment',
      alias: ['f'],
    },
    fault: {
      type: 'string',
      description: 'The kind of fault to introduce',
    },
    duration: {
      type: 'string',
      description: 'Duration for the fault',
    },
    vpcId: {
      type: 'string',
      description: 'The ID of the VPC to introduce the fault to',
    },
    azs: {
      type: 'string',
      description: 'Comma separated list of availability zones to introduce the fault to',
    },
    monitoringUrl: {
      type: 'string',
      description: 'URL to monitor for downtime. Will be ignored if EC2 is specified.',
    },
    ec2: {
      type: 'boolean',
      description: 'Spin up EC2 web server to monitor on specified subnet ID.',
    },
    prefixListId: {
      type: 'string',
      description: '[Prefix list] The ID of the prefix list to introduce the fault to',
    },
    parameters: {
      type: 'string',
      description: 'JSON string of parameters for the fault',
    },
  },
  async run(ctx) {
    const ec2Client = new EC2Client({})
    let nextToken: string | undefined
    const vpcInfos: VpcInfo[] = []
    do {
      const describeVpcsCommand = new DescribeVpcsCommand({
        NextToken: nextToken,
      })
      const { Vpcs, NextToken } = await ec2Client.send(describeVpcsCommand)
      for (const vpc of Vpcs!) {
        if (vpc.VpcId) {
          vpcInfos.push({
            id: vpc.VpcId,
            name: vpc.Tags?.find(tag => tag.Key === 'Name')?.Value ?? '',
          })
        }
      }
      nextToken = NextToken
    } while (nextToken)

    if (vpcInfos.length === 0) {
      throw new Error('No VPCs exist in your AWS account!')
    }

    ctx.args.vpcId ??= await select({
      message: 'What is the VPC to inject fault in?',
      choices: vpcInfos.map((vpcInfo) => {
        return {
          name: vpcInfo.id,
          description: vpcInfo.name,
          value: vpcInfo.id,
        }
      }),
    })

    nextToken = undefined
    const availabilityZones = new Set()
    do {
      const describeSubnetsCommand = new DescribeSubnetsCommand({
        Filters: [{
          Name: 'vpc-id',
          Values: [ctx.args.vpcId],
        }],
      })
      const { Subnets, NextToken } = await ec2Client.send(describeSubnetsCommand)
      for (const subnet of Subnets!) {
        if (subnet.AvailabilityZone) {
          availabilityZones.add(subnet.AvailabilityZone)
        }
      }

      nextToken = NextToken
    } while (nextToken)

    ctx.args.azs ??= (await checkbox({
      message: 'Which availability zones do you want to inject fault in?',
      choices: Array.from(availabilityZones.values()).map(az => ({ value: az })),
      validate(e) {
        return e.length !== 0
      },
    })).join(',')

    ctx.args.duration ??= await input({
      message: 'What is the duration in minutes to inject fault for?',
      validate(e) {
        return !Number.isNaN(Number.parseInt(e))
      },
      default: '5',
    })

    if (!ctx.args.ec2 && !ctx.args.monitoringUrl) {
      ctx.args.monitoringUrl = await input({
        message: 'What is the URL to monitor for downtime?',
        validate(e) {
          try {
            const url = new URL(e)
            return true
          }
          catch (err) {
            return false
          }
        },
      })
    }

    const fault: Fault['fault'] = ctx.args.fault as Fault['fault'] ?? await select<Fault['fault']>({
      message: 'What is the type of fault to inject?',
      choices: [
        {
          name: 'All',
          description: 'Denies all traffic entering and leaving the subnet.',
          value: 'all',
        },
        {
          name: 'Availability zone',
          description: 'Denies intra-VPC traffic to and from subnets in other Availability Zones.',
          value: 'availability-zone',
        },
        {
          name: 'DynamoDB',
          description: 'Denies traffic to and from the Regional endpoint for DynamoDB in the current Region.',
          value: 'dynamodb',
        },
        {
          name: 'Prefix list',
          description: 'Denies traffic to and from the specified prefix list.',
          value: 'prefix-list',
        },
        {
          name: 'S3',
          description: 'Denies traffic to and from the Regional endpoint for Amazon S3 in the current Region.',
          value: 's3',
        },
        {
          name: 'VPC',
          description: 'Denies traffic entering and leaving the VPC.',
          value: 'vpc',
        },
      ],
    })

    if (fault === 'prefix-list') {
      nextToken = undefined
      const prefixListIds: string[] = []
      do {
        const describePrefixListsCommand = new DescribePrefixListsCommand()
        const { PrefixLists, NextToken } = await ec2Client.send(describePrefixListsCommand)
        for (const prefixList of PrefixLists!) {
          if (prefixList.PrefixListId) {
            prefixListIds.push(prefixList.PrefixListId)
          }
        }

        nextToken = NextToken
      } while (nextToken)
      ctx.args.prefixListId ??= await select({
        message: 'What is the prefix list to introduce the fault to?',
        choices: prefixListIds.map((prefixListId) => {
          return {
            name: prefixListId,
            value: prefixListId,
          }
        }),
      })
    }

    const azs = ctx.args.azs.split(',')

    const configFile = JSON.parse(await fs.readFile('rojak.config.json', 'utf-8')) as ConfigFile

    const chaosStack = await LocalWorkspace.createOrSelectStack({
      stackName: 'network',
      projectName: 'rojak',
      async program() {
        let stateMachine

        if (ctx.args.ec2) {
          const e = new NetworkDisruptConnectivityWithEc2('rojak-network', {
            ...ctx.args,
            duration: Number.parseInt(ctx.args.duration),
            fault: {
              fault,
              parameters: {
                ...(ctx.args.parameters ? JSON.parse(ctx.args.parameters) : {}),
                prefixListId: ctx.args.prefixListId ?? undefined,
              },
            },
            azs,
          })

          stateMachine = e.stateMachine
        }
        else {
          const e = new NetworkDisruptConnectivity('network', {
            ...ctx.args,
            duration: Number.parseInt(ctx.args.duration),
            fault: {
              fault,
              parameters: {
                ...(ctx.args.parameters ? JSON.parse(ctx.args.parameters) : {}),
                prefixListId: ctx.args.prefixListId ?? undefined,
              },
            },
            azs,
          })

          stateMachine = e.stateMachine
        }

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

    await chaosStack.workspace.installPlugin('aws', 'v6.34.1')

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
