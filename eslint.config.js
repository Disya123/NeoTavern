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
      // Android local host project (Kotlin/Gradle — not linted by this config).
      'apps/android/**',
      'crates/target/**',
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
      '.scratch/**',
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
    // Contracts' own tests may import the compiled dist: the heavy-battery
    // bench child (_bench-child.mjs) is spawned by a parent test and MUST
    // resolve the built package, not the source tree.
    files: ['packages/contracts/test/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['@neotavern/*', '!@neotavern/shared', '!@neotavern/contracts'] },
      ],
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
          patterns: [
            '@neotavern/*',
            '!@neotavern/shared',
            '!@neotavern/contracts',
            '!@neotavern/gestures',
          ],
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
  // Legacy UI surface gate (ARC-02/ARC-03, ТЗ 10/10 rev2 §13.1): forbid NEW
  // direct /api/v2 and legacyRaw() usage in production UI code. Existing sites
  // carry an eslint-disable-next-line comment and are tracked in
  // docs/architecture/ui-legacy-surface.md. The plugin sandbox (plugins/**)
  // and the legacy API client shim (api/{client,backend,events,generate}.ts)
  // are the legacy-compat plane and are excluded (ADR-0039, ADR-0038).
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: {
      '@neotavern': {
        rules: {
          'no-legacy-api-surface': {
            meta: {
              type: 'problem',
              docs: {
                description:
                  'Forbid direct /api/v2 and legacyRaw() usage in production UI (ARC-02/ARC-03)',
              },
              messages: {
                legacy:
                  'Direct legacy API usage is forbidden in production UI (ARC-02/ARC-03). Migrate to the Product Wire client; existing sites are tracked in docs/architecture/ui-legacy-surface.md.',
              },
            },
            create(context) {
              function report(node) {
                context.report({ node, messageId: 'legacy' });
              }
              return {
                Literal(node) {
                  if (typeof node.value === 'string' && node.value.includes('/api/v2')) {
                    report(node);
                  }
                },
                TemplateLiteral(node) {
                  for (const quasi of node.quasis) {
                    if (
                      quasi &&
                      quasi.value &&
                      typeof quasi.value.raw === 'string' &&
                      quasi.value.raw.includes('/api/v2')
                    ) {
                      report(node);
                      return;
                    }
                  }
                },
                ImportSpecifier(node) {
                  if (
                    node.imported &&
                    node.imported.type === 'Identifier' &&
                    node.imported.name === 'legacyRaw'
                  ) {
                    report(node);
                  }
                },
                Identifier(node) {
                  if (
                    node.name === 'legacyRaw' &&
                    node.parent &&
                    node.parent.type !== 'ImportSpecifier'
                  ) {
                    report(node);
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: { '@neotavern/no-legacy-api-surface': 'error' },
  },
  // Exemptions: test/spec files, the plugin sandbox bridge (ADR-0039) and the
  // legacy API client shim (tracked in docs/architecture/ui-legacy-surface.md).
  // AutoConnectSync.tsx / LegacyBridgeSync.tsx / pages/ChatPage.tsx are exempt
  // because their committed blobs are CRLF (gitattributes mandates LF), so any
  // edit renormalizes the whole file in the diff; they remain covered by the
  // `pnpm ui:api:check` scanner gate (scripts/check-ui-api.mjs --check). This
  // CRLF exemption is registered in docs/architecture/exceptions.json
  // (ARC-09, id M1-crlf-blob-eslint-exemption) with owner and deadline.
  {
    files: [
      'apps/web/src/**/*.{test,spec}.{ts,tsx}',
      'apps/web/src/plugins/**/*.{ts,tsx}',
      'apps/web/src/api/client.ts',
      'apps/web/src/api/backend.ts',
      'apps/web/src/api/events.ts',
      'apps/web/src/api/generate.ts',
      'apps/web/src/api/legacyExtensionSettings.ts',
      'apps/web/src/components/AutoConnectSync.tsx',
      'apps/web/src/components/LegacyBridgeSync.tsx',
      'apps/web/src/pages/ChatPage.tsx',
    ],
    rules: { '@neotavern/no-legacy-api-surface': 'off' },
  },
  prettier,
);
