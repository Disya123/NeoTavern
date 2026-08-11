---
title: Site de documentation
description: >-
  Comment fonctionne le site de documentation NeoTavern et comment ajouter
  ou corriger des pages
sidebar_position: 4
---

Le site de documentation publique est un projet Docusaurus dans `apps/docs`.
Cette page explique sa disposition et comment ajouter ou mettre à jour des
pages.

## Disposition

- Les pages sources anglaises vivent dans `apps/docs/docs/`, un fichier
  markdown par page, organisées dans les mêmes répertoires que la barre
  latérale affiche.
- Les traductions vivent dans
  `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/`,
  reflétant l'arbre anglais un fichier par page ; consultez
  [Traductions](./translations).
- La référence SDK sous `apps/docs/docs/api/` est générée et gitignorée ; ne
  la modifiez pas à la main.

## Ajouter une Page

1. Créez le fichier markdown dans le répertoire qui correspond à l'endroit où
   la page devrait apparaître.
2. Ajoutez un front matter avec `title`, `description` et
   `sidebar_position` :

   ```yaml
   ---
   title: Titre de la page
   description: Une phrase décrivant la page.
   sidebar_position: 3
   ---
   ```

3. Ouvrez avec un résumé d'une phrase de ce que couvre la page.
4. Utilisez `##` et `###` pour les sections ; le `title` du front matter
   fournit le H1 unique.
5. Si vous ajoutez un nouveau répertoire, créez un `_category_.json`
   dedans :

   ```json
   { "label": "Label de la catégorie", "position": 2 }
   ```

`sidebar_position` ordonne les pages dans leur répertoire ; la page Vue
d'ensemble est 1. Les sections de la barre latérale de contenu sont générées
automatiquement à partir de la structure des répertoires.

## Limites MDX

Les pages sont du Markdown simple plus des admonitions Docusaurus
uniquement :

```md
:::note
Texte à l'intérieur de l'admonition.
:::
```

Pas de déclarations `import`, pas de composants JSX personnalisés, pas
d'onglets et pas de HTML brut. Chaque page doit rester copiable telle quelle
dans chacune des huit locales de traduction. Les exemples de code utilisent
des blocs délimités avec une balise de langue.

## Référence SDK

La référence SDK est générée par TypeDoc depuis le point d'entrée de chaque
package :

- `packages/plugin-sdk/src/index.ts` -> `apps/docs/docs/api/plugin-sdk/`
- `packages/theme-sdk/src/index.ts` -> `apps/docs/docs/api/theme-sdk/`
- `packages/provider-sdk/src/index.ts` -> `apps/docs/docs/api/provider-sdk/`
- `packages/contracts/src/index.ts` -> `apps/docs/docs/api/contracts/`

La référence se régénère à chaque build du site, donc les modifications des
pages générées sont perdues. Pour corriger une page de référence, corrigez le
TSDOC dans le source du package à la place. La vue d'ensemble à
`apps/docs/docs/api/index.md` est écrite à la main et reste commitée.

## Exécuter le Site

```bash
pnpm docs:site        # serveur de dev local avec rechargement à chaud
pnpm docs:site:build  # build de production : toutes les locales plus la référence SDK
```

Le build de production est la porte — les liens cassés et les liens markdown
cassés le font échouer — exécutez-le donc avant de pousser des changements
de contenu.

## Règles de Liens

Les liens internes doivent pointer vers des pages qui existent dans le site.
Préférez les chemins absolus du site depuis la page d'accueil
(`/getting-started/`) et les chemins relatifs depuis les pages plus
profondes (`../developers/` depuis une page sous `contributing/`). Les liens
externes sont limités à la documentation Docusaurus et au dépôt NeoTavern.

## Docs Développeur Internes

Le dépôt conserve aussi une documentation développeur interne dans `docs/`
à la racine du dépôt, validée par `pnpm docs:check` et `pnpm docs:build`.
C'est un ensemble de documents séparé de ce site public ; ne confondez pas
les deux arbres.
