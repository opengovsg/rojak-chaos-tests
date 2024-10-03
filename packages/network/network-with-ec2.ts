import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import { NetworkDisruptConnectivity, type NetworkDisruptConnectivityArgs } from './network-disrupt-connectivity'

export interface NetworkDisruptConnectivityWithEc2Args extends Omit<NetworkDisruptConnectivityArgs, 'monitoringUrl'> {
}

export class NetworkDisruptConnectivityWithEc2 extends pulumi.ComponentResource {
  public readonly stateMachine: pulumi.Output<aws.sfn.StateMachine>

  constructor(
    name: string,
    args: NetworkDisruptConnectivityWithEc2Args,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    const fullName = `${name}-network-with-ec2-chaos-experiment`

    super('@opengovsg/rojak-chaos-experiments:NetworkDisruptConnectivityWithEc2', fullName, {}, opts)

    const ami = pulumi.output(
      aws.ec2.getAmi({
        mostRecent: true,
        filters: [
          {
            name: 'architecture',
            values: ['x86_64'],
          },
          {
            name: 'name',
            values: ['amzn2-ami-kernel-*-gp2'],
          },
          {
            name: 'virtualization-type',
            values: ['hvm'],
          },
        ],
        owners: ['137112412989'], // AWS's owner ID in AMI
      }),
    ).id

    const subnet = pulumi.output(aws.ec2.getSubnet({
      id: args.vpcId.toString(),
    }))

    const ec2SecurityGroup = new aws.ec2.SecurityGroup(`${name}-ec2-security-group`, {
      vpcId: subnet.vpcId,
    }, { parent: this })

    const ec2 = new aws.ec2.Instance(`${name}-ec2`, {
      ami,
      instanceType: aws.ec2.InstanceType.T2_Micro,
      subnetId: args.vpcId,
      vpcSecurityGroupIds: [ec2SecurityGroup.id],
      userData: `
          #!/bin/bash
          echo "Hello, World!" > index.html
          nohup python3 -m http.server 80 &
        `,
    }, { parent: this })

    const experiment = new NetworkDisruptConnectivity(`${name}-experiment`, {
      ...args,
      monitoringUrl: `http://${ec2.privateIp}/`,
    }, { parent: this })

    this.stateMachine = experiment.stateMachine
  }
}
