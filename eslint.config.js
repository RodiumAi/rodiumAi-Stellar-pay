import { defineConfig, globalIgnores } from 'eslint/config';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', '**/node_modules/', 'contracts/']),
  {
    files: ['**/*.ts'],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      security.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.ts'],
          defaultProject: 'tsconfig.tools.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports only (context §5).',
        },
        {
          selector: "Property[key.name='rejectUnauthorized'][value.value=false]",
          message: 'TLS certificate verification must never be disabled (context §12.1).',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use crypto.randomBytes / crypto.getRandomValues (context §12.3).',
        },
      ],
    },
  },
  {
    // Tool configs (vitest, eslint) are loaded by their tools via default export.
    files: ['*.config.ts', '*.config.js'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
