import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'apps/web/dist/**',
      'apps/desktop/src-tauri/gen/**',
      'apps/desktop/src-tauri/resources/**',
      'apps/desktop/src-tauri/target/**',
      'data/**',
      'backups/**',
      'cache/**',
      'logs/**',
      'files/**',
      'playwright-report/**',
      'test-results/**',
      '.tmp-desktop-smoke/**',
      '.tmp-desktop-bundle-smoke/**',
      'playwright.config.ts',
      '**/vite.config.ts',
      '**/drizzle.config.ts',
      'apps/docs/.docusaurus/**',
      '.zcode/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.{test,spec}.ts', '**/test/**', '**/e2e/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Layer boundaries (docs/architecture: dependencies only go down; no app
  // imports from packages, no cycles). Enforced by tooling, not discipline
  // (ARCH-16).
  {
    files: ['packages/shared/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@neotavern/*'] }] },
  },
  {
    files: ['packages/contracts/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['@neotavern/*', '!@neotavern/shared'] }],
    },
  },
  {
    files: [
      'packages/db/**',
      'packages/provider-sdk/**',
      'packages/plugin-sdk/**',
      'packages/theme-sdk/**',
      'packages/i18n/**',
      'packages/ui/**',
      'packages/legacy-compat/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // @neotavern/gestures is a dependency-leaf (no @st2 imports inside), so
          // consuming it from any package still keeps dependencies "down".
          patterns: ['@neotavern/*', '!@neotavern/shared', '!@neotavern/contracts', '!@neotavern/gestures'],
        },
      ],
    },
  },
  {
    files: ['apps/server/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['@neotavern/web', '**/apps/web/**'] }],
    },
  },
  {
    files: ['apps/web/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['@neotavern/server', '@neotavern/db', '**/apps/server/**'] },
      ],
    },
  },
  prettier,
);
