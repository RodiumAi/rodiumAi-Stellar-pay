import { defineConfig, globalIgnores } from 'eslint/config';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

const restrictedSyntax = [
  {
    selector: 'ExportDefaultDeclaration',
    message: 'Use named exports only (context §5).',
  },
  {
    selector: "Property[key.name='rejectUnauthorized'][value.value=false]",
    message: 'TLS certificate verification must never be disabled (context §12.1).',
  },
];

const randomRestriction = {
  object: 'Math',
  property: 'random',
  message: 'Use crypto.randomBytes / crypto.getRandomValues (context §12.3).',
};

const moneyMessage = 'Money is bigint stroops only; no floating point (context §5 Money).';

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
      'no-restricted-syntax': ['error', ...restrictedSyntax],
      'no-restricted-properties': ['error', randomRestriction],
    },
  },
  {
    files: ['packages/core/src/money/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Number', message: moneyMessage },
        { name: 'parseFloat', message: moneyMessage },
        { name: 'parseInt', message: moneyMessage },
      ],
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntax,
        { selector: "MemberExpression[property.name='toFixed']", message: moneyMessage },
        // Numeric literals with a decimal point or exponent; string raws start with a quote.
        { selector: 'Literal[raw=/^[0-9]*[.][0-9]|^[0-9]+[eE]/]', message: moneyMessage },
      ],
      'no-restricted-properties': ['error', randomRestriction],
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
