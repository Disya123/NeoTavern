---
title: Traductions
description: >-
  Contribuez une traduction du site de documentation NeoTavern ou
  améliorez une traduction existante
sidebar_position: 5
---

Le site de documentation est livré en anglais plus huit locales, et chaque
traduction est une contribution communautaire. Cette page explique comment en
contribuer une ou corriger une existante.

## Locales Actuelles

La langue de base est l'anglais. Les locales traduites sont le russe (`ru`),
le chinois simplifié (`zh-Hans`), le japonais (`ja`), le coréen (`ko`),
l'espagnol (`es`), le français (`fr`), l'allemand (`de`) et le portugais
brésilien (`pt-BR`).

## Où Vivent les Traductions

Chaque locale reflète l'arbre anglais sous `apps/docs/i18n/` :

```
apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/<chemin>.md
```

Les chaînes d'interface — la barre de navigation, le pied de page, le slogan
et les libellés de la barre latérale — vivent dans des fichiers JSON sous
`apps/docs/i18n/<locale>/docusaurus-theme-classic/`, générés par la commande
write-translations.

## Exhaustivité

Chaque page anglaise devrait avoir une contrepartie traduite au même chemin
relatif. Les pages non traduites retombent automatiquement sur l'anglais,
donc les progrès partiels sont visibles immédiatement — mais visez une
couverture complète et ne soumettez jamais de fichiers à moitié traduits.

## Quoi Traduire

- Titres, corps de texte, légendes et texte alternatif.
- Le `title` et la `description` du front matter ; gardez `sidebar_position`
  identique.
- Les libellés des `_category_.json`.

## Quoi Laisser Intact

- Liens, blocs de code, code en ligne et syntaxe d'admonition
  (`:::note` ... `:::`), octet pour octet.
- Le nom du produit : NeoTavern n'est jamais traduit.
- Les identifiants d'API, noms de fichiers, commandes et drapeaux restent
  dans leur forme anglaise.

## Terminologie

Utilisez le libellé d'interface propre de l'application là où il existe ;
sinon, utilisez le terme communautaire standard dans votre langue. Là où un
terme communautaire standard existe déjà, préférez-le — n'inventez jamais un
nouveau mot.

## Corriger une Traduction

Modifiez le fichier de votre locale au même chemin relatif et ouvrez une pull
request. Quand la source anglaise d'une page change, mettez à jour la
traduction de cette page dans le même changement.

## Ajouter une Nouvelle Locale

1. Ajoutez le code de locale et son libellé d'affichage à `i18n.locales` et
   `localeConfigs` dans `apps/docs/docusaurus.config.ts`.
2. Préparez le dossier de locale :

   ```bash
   pnpm docs:translations -- --locale <code>
   ```

3. Traduisez chaque page sous
   `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/` et les
   fichiers JSON générés.
4. Ouvrez une pull request contenant à la fois le changement de configuration
   et les nouveaux fichiers.

Les codes de locale suivent les conventions standard, par exemple `zh-Hans`
pour le chinois simplifié et `pt-BR` pour le portugais brésilien.
