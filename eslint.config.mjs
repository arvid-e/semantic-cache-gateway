// @ts-check
import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  // Global Ignores
  {
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**'],
  },

  // 2. Tell ESLint that Node.js built-ins (like URL, process, etc.) are valid globals
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Base JavaScript rules
  js.configs.recommended,

  // TypeScript Specific Block
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: new URL('.', import.meta.url).pathname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Prettier override
  eslintConfigPrettier
)
