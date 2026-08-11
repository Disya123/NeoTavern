---
title: Design tokens
description: >-
  Le contrat de design tokens sémantiques et ce que les composants ne
  peuvent pas coder en dur.
sidebar_position: 3
---

Les design tokens sont les variables sémantiques qui portent toutes les
valeurs visuelles de l'application. Les composants les référencent ; les
thèmes les remplacent ; rien n'est codé en dur.

## Le Contrat de Jetons

Chaque jeton est une propriété personnalisée CSS préfixée par `--st-`, et
chaque nom de jeton fait partie du contrat versionné dans `@neotavern/theme-sdk`.
L'hôte livre des valeurs par défaut pour les modes clair et sombre, donc
chaque jeton se résout toujours même quand un thème n'en définit aucun.

Les groupes de jetons canoniques sont :

- **Couleurs de texte** — `color-text-primary`, `color-text-secondary`,
  `color-text-muted`, `color-text-inverse`, `color-text-link`.
- **Surfaces** — `color-surface-primary`, `color-surface-secondary`,
  `color-surface-tertiary`, `color-surface-overlay`, `color-surface-canvas`,
  `color-surface-elevated`.
- **Accent et statut** — `color-accent`, `color-accent-hover`,
  `color-accent-text`, `color-accent-soft`, `color-accent-soft-text`,
  `color-border`, `color-border-strong`, `color-success`, `color-warning`,
  `color-danger`, `color-info`.
- **Markdown des messages de chat** — `color-message-quote`,
  `color-message-emphasis`, `color-message-code`, `color-message-code-bg`.
- **Typographie** — `font-ui`, `font-mono`, `font-size-2xs` jusqu'à
  `font-size-2xl`, `line-height-body`, `font-weight-normal` jusqu'à
  `font-weight-bold`.
- **Espacements** — `space-2xs` jusqu'à `space-3xl`.
- **Rayons et bordures** — `radius-control`, `radius-card`,
  `radius-overlay`, `radius-panel`, `radius-round`, `radius-inset`,
  `border-width`.
- **Élévation** — `shadow-card`, `shadow-soft`, `shadow-focus`,
  `shadow-overlay`.
- **Couches (z-index)** — `layer-base`, `layer-raised`, `layer-panel`,
  `layer-plugin-overlay`, `layer-plugin-chrome`, `layer-dropdown`,
  `layer-modal`, `layer-notification`.
- **Mouvement** — `motion-duration-fast`, `motion-duration-normal`,
  `motion-duration-slow`, `motion-easing-standard`, `effect-glass-blur`.
- **Tailles de contrôles** — `control-height`, `control-height-large`,
  `control-height-sm`, `control-height-xs`, `control-height-2xs`,
  `control-hit-min`, `switch-width`, `switch-height`, `switch-thumb-size`,
  `menu-min-width`, `dialog-max-width`, `dialog-max-height`,
  `textarea-min-height`, `spinner-size`.
- **Tailles de panneaux et de contenu** — `size-panel-max-height`,
  `size-content-max-height`, `size-chat-column-max`.
- **Limites de fenêtre** — `overlay-width-limit`, `overlay-height-limit`,
  `dialog-sheet-height`.
- **Barres de défilement** — `scrollbar-width`, `scrollbar-radius`,
  `scrollbar-track-bg`, `scrollbar-thumb-bg`, `scrollbar-thumb-hover-bg`,
  `scrollbar-fade-duration`, `scrollbar-fade-easing`,
  `scrollbar-hide-delay`.
- **Tailles du shell de l'application** — `shell-rail-width`,
  `shell-panel-width`, `shell-panel-min-width`, `shell-panel-max-width`.
- **Zone de discussion** — `chat-wallpaper-image`, `chat-wallpaper-position`,
  `chat-wallpaper-size`, `chat-wallpaper-overlay`, `chat-wallpaper-blur`,
  `custom-wallpaper-overlay-alpha`.
- **Métriques typographiques du chat** — `chat-markdown-column-width`,
  `chat-message-block`, `chat-message-inline`.
- **Boutons réglables par l'utilisateur** — `custom-glass-blur`,
  `custom-ui-opacity`.

## Remplacer les Jetons

Un thème remplace n'importe quel sous-ensemble des noms. Les valeurs sont
validées : elles doivent être des valeurs CSS sûres et non vides, et les
constructions comme `{`, `}` et `;` sont rejetées.

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#e38a62",
      "shadow-card": "0 1px 2px rgba(0, 0, 0, 0.35)"
    }
  }
}
```

Si l'utilisateur choisit un fond de conversation, l'application définit une
propriété personnalisée limitée pour l'image de fond sur la racine de
l'espace de travail ; la position, la taille, le voile et le flou restent des
jetons du thème.

## Règles de Résolution

Les jetons se résolvent dans cet ordre, le dernier gagnant :

1. Valeurs par défaut intégrées pour le mode actif.
2. La chaîne de thèmes parents, racine d'abord.
3. Le thème lui-même.

Le mode sombre retombe sur les jetons clairs du thème quand aucun
remplacement sombre n'existe, donc un thème uniquement clair fonctionne
aussi en mode sombre. Les fonctions `resolveTokens` et
`buildThemeVariables` de `@neotavern/theme-sdk` implémentent cela, et l'hôte écrit
le résultat comme variables CSS sur `document.documentElement`.

## Ce Que les Composants Ne Peuvent Pas Coder en Dur

Le contrat de style interdit les valeurs codées en dur partout dans
l'interface intégrée, et les mêmes règles s'appliquent à ce sur quoi un
thème ne doit pas s'appuyer :

- `font-weight` numérique, `font-size` en px et `border-radius` brut en px.
- Valeurs `z-index` numériques — utilisez les jetons `layer-*`.
- Tailles de contrôles comme `40px`, `44px`, `52px`, `32px` et `36px`.
- `!important` dans le CSS de thème, sauf dans la couche de préférences
  d'accessibilité.
- Règles de mise en page : les coordonnées, les schémas de grille et de flex,
  les points de rupture et l'ordre des zones ne font pas partie du contrat de
  jetons. Les points de rupture viennent du registre
  (`VIEWPORT_BREAKPOINTS` et `CONTAINER_BREAKPOINTS`), et déplacer les zones
  du shell est hors périmètre pour v1.

La géométrie de contenu comme le schéma de grille des listes de fiches est
une exception explicite : elle n'est pas couverte par le contrat de jetons.
Tout ce dont un thème a besoin pour restyler est disponible via les jetons,
les hooks et la mise en page de shell déclarative. La
[référence du Theme SDK](../../api/theme-sdk/) générée documente la liste exacte
`TokenName`.
