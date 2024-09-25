export interface ConfigFile {
  s3Uri: {
    value: string
    secret: boolean
  }
  keyUri: {
    value: string
    secret: boolean
  }
}
