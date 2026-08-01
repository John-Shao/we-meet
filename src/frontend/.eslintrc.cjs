module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'plugin:@tanstack/eslint-plugin-query/recommended',
    'plugin:jsx-a11y/recommended',
    'prettier'
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs', 'styled-system'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    // Semi Design belongs to the management console only. Its global.scss
    // writes body-level font and colour variables, so a stray import from the
    // C 端 would leak the console's theme into the whole app (see the notes at
    // the top of vite.config.ts). Keeping this a lint rule rather than a
    // convention makes the boundary something CI enforces.
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@douyinfe/semi-ui', '@douyinfe/semi-ui/**'],
            message:
              'Semi Design is for src/features/admin only (M 端). Use the shared primitives in src/primitives instead.',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // The console is where Semi is allowed — and where it must stay.
      files: ['src/features/admin/**'],
      rules: { 'no-restricted-imports': 'off' },
    },
  ],
}
