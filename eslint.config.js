import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.next/**', 'apps/web/out/**', '**/next-env.d.ts', 'data/**', 'skills/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts', 'packages/db/drizzle.config.ts', 'apps/api/auth.cli.ts', 'apps/web/next.config.ts', 'scripts/web-csp.mjs', '.pnpmfile.mjs', 'scripts/check-deps.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-throw-literal': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSAsExpression.expression[typeAnnotation.type="TSUnknownKeyword"]',
          message: 'Double assertion through `unknown` is banned. Parse with a schema instead.',
        },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
)
