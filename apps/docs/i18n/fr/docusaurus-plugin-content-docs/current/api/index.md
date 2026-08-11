---
title: Référence SDK
description: >-
  Vue d'ensemble de la référence TypeDoc générée automatiquement pour les
  quatre packages SDK publics.
sidebar_position: 1
---

La Référence SDK est une référence API générée automatiquement pour les
quatre packages TypeScript publics que NeoTavern expose aux auteurs de
plugins, de thèmes et de fournisseurs.

## Ce Qui Est Généré

La référence est produite par TypeDoc depuis le point d'entrée `src/index.ts`
de chaque package à chaque build du site. Elle documente la surface exportée
exacte de :

- **Plugin SDK** — `@neotavern/plugin-sdk` : validation du manifeste, modèle de
  permissions, événements typés et les contrats d'API de plugins frontend et
  backend.
- **Theme SDK** — `@neotavern/theme-sdk` : le contrat de design tokens, la
  validation du manifeste de thème, la résolution d'héritage et la
  génération de variables CSS.
- **Provider SDK** — `@neotavern/provider-sdk` : le contrat d'adaptateur de
  fournisseur, les adaptateurs intégrés, l'estimation de jetons et le
  registre de runtime.
- **Contracts** — `@neotavern/contracts` : les schémas partagés de requêtes,
  réponses et entités dont dérivent à la fois les routes backend et les
  types frontend.

Les pages générées ne sont pas écrites à la main et ne sont pas commitées
dans le dépôt. Elles sont recréées à chaque build, donc elles correspondent
toujours au `src/` actuel des packages.

## Régénérer la Référence

Tout build Docusaurus régénère la référence dans le cadre du pipeline :

```bash
pnpm --filter @neotavern/docs build
```

Exécutez la même commande localement quand vous voulez une référence fraîche
après avoir modifié un fichier source du SDK.

## Parcourir les Packages

- [Référence du Plugin SDK](api/plugin-sdk/)
- [Référence du Theme SDK](api/theme-sdk/)
- [Référence du Provider SDK](api/provider-sdk/)
- [Référence des Contracts](api/contracts/)

Pour des guides d'utilisation au lieu de listages d'API bruts, consultez les
sections Plugin SDK, Theme SDK et Fournisseurs de cette documentation. Elles
expliquent les contrats en prose, avec des exemples, et renvoient aux pages
générées pour les signatures précises.
