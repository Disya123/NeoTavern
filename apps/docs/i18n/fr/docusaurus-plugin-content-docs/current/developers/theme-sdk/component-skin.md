---
title: Skin des composants
description: La pile de style pour les skins de thème, des couches en cascade aux hooks stables.
sidebar_position: 4
---

Le niveau skin des composants restyle les composants intégrés. Il s'appuie
sur une pile de style spécifique et un contrat de hooks stables.

## La Pile de Style

L'interface intégrée utilise quatre technologies ensemble :

- **CSS Modules** pour les styles limités aux composants, avec des noms de
  classes hachés qui ne sont explicitement pas un contrat public.
- **Propriétés personnalisées CSS** pour les jetons sémantiques (`--st-*`).
- **Couches en cascade** pour ordonner les sources de vérité.
- **Requêtes de conteneur** pour la mise en page qui s'adapte au propre
  conteneur du composant, avec des tailles exprimées en `rem`.

Les thèmes ciblent les attributs de hooks, jamais les noms de classes
générés.

## Ordre des Couches en Cascade

Tous les styles vivent dans un ordre de couches en cascade fixe :

```css
@layer reset, tokens, base, components, plugin-base, theme, user;
```

Les couches ultérieures gagnent sur les précédentes, donc la précédence est :

1. `reset` — le reset de base.
2. `tokens` — les définitions de jetons.
3. `base` — les valeurs par défaut au niveau des éléments.
4. `components` — les styles des composants intégrés.
5. `plugin-base` — une couche pour les styles de base fournis par les
   plugins.
6. `theme` — le skin du thème actif.
7. `user` — les remplacements propres de l'utilisateur, qui se chargent en
   dernier.

La feuille de style de remplacement utilisateur se charge toujours en
dernier, donc un thème cassé ou affirmé ne peut jamais empêcher
l'utilisateur de le remplacer. En termes de `!important` : la construction
est interdite dans le CSS de thème, sauf dans la couche de préférences
d'accessibilité, qui appartient aux modes d'accessibilité orientés
utilisateur.

## Le Contrat de Hooks

Les thèmes stylent les composants via quatre attributs, publiés par l'hôte
et versionnés comme le reste du SDK :

```html
<div
  data-component="chat-message"
  data-part="container"
  data-role="assistant"
  data-state="streaming"
></div>
```

- `data-component` — le type de composant.
- `data-part` — la partie structurelle à l'intérieur d'un composant.
- `data-role` — un rôle sémantique, comme un rôle de message.
- `data-state` — un état, comme `open`, `closed` ou `streaming`.

Le CSS de skin d'un thème ressemble alors à ceci :

```css
@layer theme {
  [data-component='button'][data-variant='primary'] > [data-part='icon'] {
    color: var(--st-color-accent-text);
  }

  [data-component='action-bar'] [data-part='group'][data-role='secondary'] {
    color: var(--st-color-text-secondary);
  }
}
```

Le package `@neotavern/theme-sdk` exporte le helper `dataHook` pour construire ces
objets d'attributs, donc les auteurs de composants et les auteurs de thèmes
se mettent d'accord sur les mêmes noms.

## Ce Qui N'est Pas un Contrat

- **Les noms de classes CSS-modules générés** — hachés, instables et pas
  partie du SDK. Un thème qui les cible casse au prochain build.
- **La hiérarchie React interne** — les thèmes ne doivent pas dépendre des
  entrailles des composants ni de l'ordre du DOM au-delà des hooks
  documentés.
- **Les valeurs de mise en page numériques** — les coordonnées, les schémas
  de grille et les points de rupture ne sont pas stylables via le contrat de
  jetons ; les points de rupture de fenêtre vivent dans le registre et les
  requêtes de conteneur doivent être écrites en `rem`.

## CSS Interdit

Les feuilles de style de thème sont analysées avant leur chargement. Les
constructions interdites sont rejetées à l'installation et à la validation :

- `@import`
- URL `javascript:` et `expression()`.
- `-moz-binding` et `behavior:`.
- URL distantes ou relatives au protocole (`url(http:`, `url(https:`,
  `url(//`).
- `data:text/html`.
- `!important` (sauf la couche de préférences d'accessibilité).

Cela garde le CSS de thème pur, local et sûr. Pour les jetons que le skin
devrait référencer, consultez [Design tokens](design-tokens.md) ; pour les
zones nommées qu'un skin peut restyler, consultez
[Contrat de shell](shell-contract.md).
