import fs from 'node:fs/promises'
import { confirm, input, select } from '@inquirer/prompts'
import { defineCommand } from 'citty'
import { DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2'
import { GetResolverQueryLogConfigCommand, ListResolverQueryLogConfigAssociationsCommand, Route53ResolverClient } from '@aws-sdk/client-route53resolver'
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { LocalWorkspace } from '@pulumi/pulumi/automation/index.js'
import consola from 'consola'
import { Ec2C2DnsCallback } from '@opengovsg/rojak-ec2'
import type { ConfigFile } from '../../config.js'
import type { VpcInfo } from '../../common/vpc-info.js'

export default defineCommand({
  meta: {
    name: 'ec2',
    description: 'Simulates a compromised EC2 instance in your VPC calling back to a known malicious command-and-control domain.',
  },
  args: {
    vpcId: {
      type: 'string',
      description: 'The VPC to connect the brute force Lambda to.',
    },
    subnetId: {
      type: 'string',
      description: 'The subnet to connect the brute force Lambda to. Must reside in the VPC provided.',
    },
    c2Domain: {
      type: 'string',
      description: 'The C2 callback domain',
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
    const subnetIds: string[] = []
    do {
      const describeSubnetsCommand = new DescribeSubnetsCommand({
        Filters: [{
          Name: 'vpc-id',
          Values: [ctx.args.vpcId],
        }],
      })
      const { Subnets, NextToken } = await ec2Client.send(describeSubnetsCommand)
      for (const subnet of Subnets!) {
        if (subnet.SubnetId) {
          subnetIds.push(subnet.SubnetId)
        }
      }

      nextToken = NextToken
    } while (nextToken)
    ctx.args.subnetId ??= await select({
      message: 'What is the subnet to simulate malicious C2 DNS callback in?',
      choices: subnetIds.map(subnetId => ({ value: subnetId })),
    })
    ctx.args.c2Domain ??= await input({
      message: 'What is the callback domain you want to invoke?',
      default: 'guarddutyc2activityb.com',
    })

    // Check if route53 resolver query log config is already associated with VPC (only 1)
    const route53ResolverClient = new Route53ResolverClient({})
    const listResolverQueryLogConfigAssociationsCommand = new ListResolverQueryLogConfigAssociationsCommand({
      MaxResults: 1,
      Filters: [
        {
          Name: 'ResourceId',
          Values: [
            ctx.args.vpcId,
          ],
        },
      ],
    })
    const { ResolverQueryLogConfigAssociations } = await route53ResolverClient.send(listResolverQueryLogConfigAssociationsCommand)

    if (!ResolverQueryLogConfigAssociations) throw new Error('Expected resolver query log config associations to be defined.')

    // If resolver query log config already exists, get the log group name to monitor
    if (ResolverQueryLogConfigAssociations.length > 0) {
      const getResolverQueryLogConfigCommand = new GetResolverQueryLogConfigCommand({
        ResolverQueryLogConfigId: ResolverQueryLogConfigAssociations[0].ResolverQueryLogConfigId,
      })
      const { ResolverQueryLogConfig } = await route53ResolverClient.send(getResolverQueryLogConfigCommand)
      if (!ResolverQueryLogConfig?.DestinationArn) throw new Error('Expected resolver query log config destination ARN to be defined.')

      const DestinationArn = ResolverQueryLogConfig.DestinationArn

      const cloudWatchLogsClient = new CloudWatchLogsClient({})
      const describeLogGroupsCommand = new DescribeLogGroupsCommand({
        logGroupNamePattern: DestinationArn.split(':').at(-1),
        limit: 1,
      })
      const { logGroups } = await cloudWatchLogsClient.send(describeLogGroupsCommand)
      if (!logGroups) throw new Error('Expected log groups to be defined.');
      if (logGroups.length > 0) {
        if (!logGroups[0].logGroupName) {
          throw new Error('Expected first log group to have name.')
        }

        ctx.args.resolverQueryLogGroupName = logGroups[0].logGroupName
      }
      else {
        // TODO: Handle this case gracefully
        throw new Error('A Route53 Resolver Query Log configuration already exists that does not log to a CloudWatch Log Group!')
      }
    }

    const configFile = JSON.parse(await fs.readFile('rojak.config.json', 'utf-8')) as ConfigFile

    const chaosStack = await LocalWorkspace.createOrSelectStack({
      stackName: 'ec2',
      projectName: 'rojak',
      async program() {
        const { stateMachine } = new Ec2C2DnsCallback('rojak-ec2', ctx.args)
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

    await chaosStack.up({ color: 'always', onOutput: consola.withTag('Pulumi Up').log })
  },
})
