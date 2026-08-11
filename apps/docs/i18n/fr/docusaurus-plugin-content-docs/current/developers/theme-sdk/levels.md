---
title: Niveaux de thème
description: >-
  Les trois niveaux de thématisation — jetons, skin des composants et
  mise en page du shell.
sidebar_position: 2
---

Un thème est construit à partir de trois niveaux indépendants. Comprendre la
séparation est ce qui permet à un thème de changer l'apparence de toute
l'application sans toucher à son comportement.

## Niveau 1 : Design Tokens

Les jetons sont des propriétés personnalisées CSS sémantiques préfixées par
`--st-`. Ils couvrent les couleurs, la typographie, les espacements, les
rayons, les bordures, les ombres, les couches z-index, le mouvement, les
tailles de contrôles, les barres de défilement et la zone de discussion.

Les composants ne référencent que des jetons — ils ne codent jamais en dur
une couleur, une police ou un espacement. Remplacer un jeton dans le
manifeste du thème restyle chaque composant qui l'utilise :

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#ff00aa",
      "font-ui": "'Atkinson Hyperlegible', system-ui, sans-serif"
    }
  }
}
```

Les jetons se résolvent via une chaîne d'héritage : les valeurs par défaut
intégrées pour le mode, puis les thèmes parents, puis le thème lui-même. Un
mode sombre retombe sur les jetons clairs du thème quand aucun remplacement
sombre n'existe. Consultez [Design tokens](design-tokens.md) pour le contrat
complet.

## Niveau 2 : Skin des Composants

Le skin des composants est du CSS qui restyle les composants intégrés via des
hooks stables. L'hôte publie les attributs `data-component`, `data-part`,
`data-role` et `data-state` ; un thème style ces attributs, jamais les noms
de classes CSS-modules générés :

```css
@layer theme {
  [data-component='button'][data-variant='primary'] {
    background: var(--st-color-accent);
  }
}
```

Le skin est appliqué via des couches en cascade dans un ordre fixe, avec la
couche de remplacement utilisateur en dernier. `!important` est interdit dans
le CSS de thème, sauf dans la couche de préférences d'accessibilité.
Consultez [Skin des composants](component-skin.md) pour l'ordre des couches
et la référence des hooks.

## Niveau 3 : Mise en Page du Shell

La mise en page du shell est la composition des zones principales : la barre
de navigation, les panneaux de gestion et l'espace de travail de chat. Elle
est déclarative, exprimée dans `theme.json` — jamais en JavaScript :

```json
{
  "shellLayout": {
    "navigationRail": {
      "main": [
        "menu-toggle",
        "chats",
        "characters",
        "personas",
        "lorebooks",
        "backgrounds",
        "ai-settings",
        "plugins"
      ],
      "bottom": ["settings"]
    }
  }
}
```

Les éléments de barre valides sont `chats`, `characters`, `personas`,
`lorebooks`, `backgrounds`, `ai-settings`, `plugins`, `settings` et le
facultatif `menu-toggle`. Le groupe `main` coule depuis le haut ; `bottom`
est épinglé au bord inférieur. Les éléments que vous omettez sont réajoutés
dans l'ordre standard, donc un thème ne peut pas cacher accidentellement les
Paramètres et verrouiller l'utilisateur hors de la récupération.

## Imiter d'Autres Interfaces

Comme les niveaux sont disjoints, un thème peut imiter un paradigme
d'interface complètement différent :

- Un thème de style console change les jetons et les skins, faisant
  ressembler la barre, les panneaux et les boutons à une interface de jeu.
- Un thème de visual novel restyle la zone d'affichage du chat, les messages
  et l'en-tête de personnage pendant que la logique de chat reste intacte.
- Un thème d'application mobile utilise la mise en page de shell déclarative
  pour réordonner la barre et les panneaux.

Aucun de ces cas ne nécessite de toucher à la logique de chat, aux données ou
au comportement des plugins — c'est exactement pourquoi la surface de thème
peut être remplacée en bloc. La seule chose que v1 ne fournit pas est le
réarrangement libre des zones de shell ; les emplacements sont stylés et
remplis, pas déplacés. Consultez [Contrat de shell](shell-contract.md) pour
ce qui est dans le périmètre.
