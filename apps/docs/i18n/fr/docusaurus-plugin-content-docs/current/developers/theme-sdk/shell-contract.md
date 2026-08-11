---
title: Contrat de shell
description: Les zones de shell nommées que les thèmes stylent et que les plugins remplissent.
sidebar_position: 5
---

Le contrat de shell définit les zones nommées de l'application. Les thèmes
stylent ces zones ; les plugins y ajoutent du contenu via des emplacements
stables.

## Zones de Shell Nommées

L'hôte publie chaque zone majeure avec un attribut d'emplacement stable :

| Emplacement          | Zone                                               |
| -------------------- | -------------------------------------------------- |
| `app.shell`          | La racine du shell de l'application                |
| `navigation.primary` | La barre de navigation                             |
| `chat.header`        | L'en-tête de chat                                  |
| `chat.viewport`      | La zone d'affichage défilante du chat              |
| `chat.composer`      | La zone de saisie de messages                      |
| `character.browser`  | La racine du navigateur de personnages             |
| `panel.left`         | Le panneau de contexte gauche                      |
| `status.area`        | La zone d'état de connexion                        |
| `modal.layer`        | La couche modale (plugins sous la surface système) |
| `notification.layer` | La couche de notifications                         |

Deux emplacements sont réservés mais ne font pas partie de v1 :
`navigation.secondary` et `panel.right`.

## Ce Que le Contrat Autorise

Un thème peut :

- **Styler n'importe quelle zone nommée** via son attribut `data-slot` et les
  hooks de composants qu'elle contient.
- **Arranger les zones principales** via le `shellLayout` déclaratif du
  manifeste — actuellement l'ordre de la barre de navigation (groupes `main`
  et `bottom`) et le placement des onglets de gestion (`pinned`).
- **Remplacer le fond de la zone de discussion** via les jetons
  `chat-wallpaper-*`.

Le réarrangement libre des zones — déplacer la barre sur le côté droit, par
exemple — ne fait pas partie de v1. Les emplacements sont stylés et remplis,
pas relocalisés.

## Comment les Plugins Ajoutent du Contenu

Les plugins reçoivent les API d'enregistrement du SDK et l'hôte place leur
contenu dans les emplacements stables. Par exemple, un panneau latéral
enregistré avec `slot: 'left'` se rend dans `panel.left`, et les boîtes de
dialogue de plugins s'empilent dans `modal.layer` sous la surface système.

Le contrat qui découle de cette séparation :

- Les thèmes ne dépendent jamais du DOM interne d'un plugin.
- Les plugins ne dépendent jamais de la hiérarchie React interne ni de noms
  de classes générés spécifiques.
- Les deux côtés ne se rencontrent qu'aux emplacements nommés et aux
  attributs de hooks.

## Hooks Stables à l'Intérieur des Zones

Dans les zones, les composants publient les attributs de hooks standard.
Exemples notables :

- La racine de la zone de saisie publie `data-slot="chat.composer"`, avec une
  partie barre d'outils, une partie champ et une entrée
  `data-component="textarea"`.
- Les boutons publient `data-component="button"` avec `data-part="icon"` et
  `data-part="label"` ; les actions associées vivent dans une barre d'actions
  (`data-component="action-bar"`) avec des groupes primaire et secondaire.
- Les onglets publient `data-component="tabs"` avec les parties `list`,
  `trigger` et `content` ; les panneaux de gestion utilisent la variante
  segment.
- Les messages publient `data-component="chat-message"` avec
  `data-role="user|assistant|system|tool"` et des états comme `streaming`.
- La barre de navigation publie `data-component="navigation-rail"` avec
  `data-part="main-items"`, `data-part="bottom-items"` et
  `data-item="<id>"` par entrée, plus `data-state="expanded|collapsed"`.
- Tous les panneaux de la barre partagent un en-tête commun
  (`data-component="sidebar-panel-header"`) pour qu'un thème les style une
  seule fois.

## Responsabilités de Mise en Page

L'hôte possède la mise en page critique pour le comportement : piégeage du
focus, direction logique RTL, marges de zones sûres et tailles minimales de
cibles interactives. Un thème de shell peut changer l'apparence et
l'arrangement des zones, mais doit préserver l'ordre du DOM là où il est
documenté, le défilement horizontal des listes d'actions et le comportement
clavier. Les points de rupture sont enregistrés dans le SDK
(`VIEWPORT_BREAKPOINTS` pour les largeurs de fenêtre en px,
`CONTAINER_BREAKPOINTS` pour les tailles de conteneur en rem), et les
requêtes de fonctionnalités comme `prefers-reduced-motion` ne sont pas des
points de rupture de mise en page.

Pour la couche de style qui skine ces zones, consultez
[Skin des composants](component-skin.md) ; pour la récupération quand un
shell est cassé, consultez [Mode sans échec](safe-mode.md).
