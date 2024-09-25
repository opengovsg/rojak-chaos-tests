import { antfu } from '@antfu/eslint-config'

export default antfu({
  stylistic: true,
}, {
  rules: {
    'unused-imports/no-unused-vars': 'off',
    'node/prefer-global/process': 'off',
    'no-console': 'off',
  },
})
