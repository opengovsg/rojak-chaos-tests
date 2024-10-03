# Rojak Chaos Experiments 🥗

Resilience and security chaos testing for developers! Rojak has helped with the security preparedness of multiple products at
OGP, including ActiveSG, FormSG, GoGovSG and Healthcare Appointment System by using consistently measurable outcomes
for security chaos engineering and reducing time to detection and time to remediation by 3x for real life security incidents.

## Usage

There are two ways to use Rojak chaos experiments

### Standalone (CLI)

Use this method if you do not use Pulumi to manage your infrastructure. This will provision a temporary Pulumi stack for you which contains all the resources.

A `rojak.config.js` file will be created which stores the Pulumi stack configuration. If this file is detected on subsequent runs, the same stack will be used.

```bash
# Using NPM

npx @opengovsg/rojak-cli init # Scaffold infra
npx @opengovsg/rojak-cli up rds # Provision RDS chaos tests
npx @opengovsg/rojak-cli up network # Provision network chaos tests
npx @opengovsg/rojak-cli up iam # Provision IAM chaos tests
npx @opengovsg/rojak-cli up ec2 # Provision EC2 chaos tests

npx @opengovsg/rojak-cli stats # View run statistics (coming soon!)
npx @opengovsg/rojak-cli down # Take down infra
```

To start chaos experiments, visit the AWS Console > Step Functions and trigger a `New execution` for the desired test.

`aws logs get-log-events --log-group-name /aws/fis/ec2-c2-dns-chaos-experiment --log-stream-name experiment-outputs --output text > results.log` to output the latest chaos experiment logs. This will be used to calculate your time to detect and contain the injection.

### Integrated (coming soon)

Use this method if you already use Pulumi to manage your infrastructure. You must have [Pulumi installed](https://www.pulumi.com/docs/install/).

## Development

```bash
pnpm i # Install dependencies

pnpm build:lambda # Build Lambda functions

pnpm dev:cli init # Run CLI
```
