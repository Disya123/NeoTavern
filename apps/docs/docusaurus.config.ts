import type { Config } from '@docusaurus/types';
import type {
  SidebarItemsGenerator,
  SidebarItem,
  SidebarItemCategory,
} from '@docusaurus/plugin-content-docs/lib/sidebars/types';

const KIND_LABELS: Record<string, string> = {
  classes: 'Classes',
  functions: 'Functions',
  interfaces: 'Interfaces',
  'type-aliases': 'Type Aliases',
  variables: 'Variables',
};

// Auto-generated sections (api/ from TypeDoc, architecture/ from the synced
// `docs/` mirror) repeat the same kind folders (classes/, functions/, ...)
// and folder names (plugin-sdk, theme-sdk, ...) under different parents.
// Docusaurus derives sidebar translation keys from the category label, so
// those duplicates would collide. Give every category a unique key derived
// from its label path and capitalize the kind labels.
const sidebarItemsGenerator: SidebarItemsGenerator = async ({
  defaultSidebarItemsGenerator,
  item,
  ...args
}) => {
  const items = await defaultSidebarItemsGenerator({ item, ...args });
  const root = `/${item.dirName}`;
  const transform = (nodes: SidebarItem[], path: string): SidebarItem[] =>
    nodes.map((node) => {
      if (node.type !== 'category') {
        return node;
      }
      const category = node as SidebarItemCategory;
      const nextPath = `${path}/${category.label}`;
      const prettyLabel = KIND_LABELS[category.label] ?? category.label;
      return {
        ...category,
        label: prettyLabel,
        key: nextPath,
        items: transform(category.items, nextPath),
      };
    });
  return transform(items, root);
};

const algolia =
  process.env.ALGOLIA_APP_ID && process.env.ALGOLIA_API_KEY && process.env.ALGOLIA_INDEX_NAME
    ? {
        appId: process.env.ALGOLIA_APP_ID,
        apiKey: process.env.ALGOLIA_API_KEY,
        indexName: process.env.ALGOLIA_INDEX_NAME,
        contextualSearch: true,
      }
    : undefined;

const typedocPlugin = (
  name: string,
  entry: string,
  out: string,
): [string, Record<string, unknown>] => [
  'docusaurus-plugin-typedoc',
  {
    id: name,
    entryPoints: [entry],
    tsconfig: `../../packages/${name}/tsconfig.json`,
    out,
    readme: 'none',
    excludePrivate: true,
    excludeInternal: true,
    hideGenerator: true,
    outputFileStrategy: 'members',
  },
];

const config: Config = {
  title: 'NeoTavern',
  tagline: 'Local-first AI chat and roleplay platform — documentation for users and developers',
  favicon: '/img/favicon.svg',

  url: 'https://docs.neotavern.com',
  baseUrl: '/',
  organizationName: 'Disya123',
  projectName: 'NeoTavern',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onDuplicateRoutes: 'warn',
  onBrokenAnchors: 'warn',

  markdown: {
    format: 'md',
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh-Hans', 'ja'],
    localeConfigs: {
      en: { label: 'English' },
      'zh-Hans': { label: '简体中文' },
      ja: { label: '日本語' },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          sidebarItemsGenerator,
          editUrl: 'https://github.com/Disya123/NeoTavern/edit/main/apps/docs/',
          showLastUpdateTime: true,
          showLastUpdateAuthor: false,
        },
        blog: false,
        pages: false,
        debug: false,
      },
    ],
  ],

  plugins: [
    typedocPlugin('plugin-sdk', '../../packages/plugin-sdk/src/index.ts', 'docs/api/plugin-sdk'),
    typedocPlugin('theme-sdk', '../../packages/theme-sdk/src/index.ts', 'docs/api/theme-sdk'),
    typedocPlugin(
      'provider-sdk',
      '../../packages/provider-sdk/src/index.ts',
      'docs/api/provider-sdk',
    ),
    typedocPlugin('contracts', '../../packages/contracts/src/index.ts', 'docs/api/contracts'),
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'NeoTavern',
      items: [
        { type: 'doc', docId: 'getting-started/index', label: 'Getting Started' },
        { type: 'doc', docId: 'user-guide/chat', label: 'User Guide' },
        { type: 'doc', docId: 'developers/index', label: 'Developers' },
        {
          type: 'dropdown',
          label: 'SDK Reference',
          position: 'left',
          items: [
            { to: '/api/', label: 'Overview' },
            { to: '/api/plugin-sdk/', label: 'Plugin SDK' },
            { to: '/api/theme-sdk/', label: 'Theme SDK' },
            { to: '/api/provider-sdk/', label: 'Provider SDK' },
            { to: '/api/contracts/', label: 'Contracts' },
          ],
        },
        { type: 'localeDropdown', position: 'right' },
        { href: 'https://github.com/Disya123/NeoTavern', position: 'right', label: 'GitHub' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting Started', to: '/getting-started/' },
            { label: 'User Guide', to: '/user-guide/chat' },
            { label: 'Developers', to: '/developers/' },
            { label: 'FAQ', to: '/faq' },
          ],
        },
        {
          title: 'SDK Reference',
          items: [
            { label: 'Plugin SDK', to: '/api/plugin-sdk/' },
            { label: 'Theme SDK', to: '/api/theme-sdk/' },
            { label: 'Provider SDK', to: '/api/provider-sdk/' },
            { label: 'Contracts', to: '/api/contracts/' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: 'https://github.com/Disya123/NeoTavern' },
            {
              label: 'Changelog',
              href: 'https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} NeoTavern contributors.`,
    },
    docs: {
      sidebar: {
        autoCollapseCategories: true,
        hideable: true,
      },
    },
    ...(algolia ? { algolia } : {}),
  },
};

export default config;
