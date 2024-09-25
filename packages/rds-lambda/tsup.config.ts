import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'tsup'
import archiver from 'archiver'
import fs from 'fs-extra'
import { $ } from 'execa'

export default defineConfig({
  entry: ['./lambda.ts'],
  format: ['esm', 'cjs'],
  shims: true,
  async onSuccess() {
    const tmpPath = await fs.mkdtemp(path.join(os.tmpdir(), 'opengovsg-rojak-rds-lambda'))
    await $({ stdout: 'inherit' })`pnpm deploy --ignore-scripts -P --filter=@opengovsg/rojak-rds-lambda ${tmpPath}`

    await fs.copy(path.join(process.cwd(), 'dist'), tmpPath)
    await fs.copy(path.join(process.cwd(), 'passwords.txt'), path.join(tmpPath, 'passwords.txt'))
    await fs.remove(path.join(tmpPath, 'assets'))

    const zipOutput = fs.createWriteStream(path.join(process.cwd(), 'assets/lambda.zip'))
    const archive = archiver.create('zip')

    await new Promise<void>((resolve, reject) => {
      zipOutput.on('close', () => {
        console.log(`${archive.pointer()} total bytes`)
        console.log('archiver has been finalized and the output file descriptor has closed.')
        resolve()
      })

      archive.on('error', (err) => {
        reject(err)
      })

      archive.pipe(zipOutput)

      archive.directory(tmpPath, false)

      archive.finalize()
    })
  },
})
