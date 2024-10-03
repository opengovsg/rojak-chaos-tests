import { defineCommand } from 'citty'

import ec2 from './up/ec2.js'
import rds from './up/rds.js'
import iam from './up/iam.js'
import network from './up/network.js'

export default defineCommand({
  meta: {
    name: 'up',
    description: 'Provision infrastructure for individual chaos tests.',
  },
  subCommands: {
    ec2,
    rds,
    iam,
    network,
  },
})
