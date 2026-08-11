---
title: Mode sans échec
description: >-
  Comment le mode sans échec désactive les thèmes et plugins tiers, et
  pourquoi la réinitialisation fonctionne toujours.
sidebar_position: 6
---

Le mode sans échec est le mécanisme de récupération de la couche visuelle :
il désactive les thèmes et plugins tiers pour que l'interface revienne
toujours à un état fonctionnel.

## Ce Que Fait le Mode Sans Échec

Le mode sans échec est activé avec `?safe=1` dans l'URL. Il est géré avant
que n'importe quel code de package ne se charge :

- Le CSS des thèmes tiers et les remplacements de jetons ne sont pas ajoutés
  au document.
- Les points d'entrée des plugins tiers ne s'exécutent jamais, y compris les
  points d'entrée hérités.
- Le thème intégré et le runtime de plugin intégré restent actifs.

L'interface retombe sur les jetons clairs et sombres intégrés, qui sont
toujours présents. Quitter le mode sans échec restaure l'état de thème et de
plugin actif précédemment enregistré — en sortir ne change pas votre
sélection.

## Pourquoi un Thème Cassé ne Peut Pas Bloquer la Récupération

Plusieurs garanties protègent l'utilisateur d'un thème cassé :

- **Aperçu avant application** — les thèmes sont prévisualisés avant
  l'activation, et installer un package ne l'active jamais automatiquement.
- **Le mode sans échec précède les packages** — `?safe=1` est traité avant
  que le registre de thèmes ne soit consulté, donc même un thème dont le CSS
  fait planter le rendu n'est jamais chargé.
- **Le bouton de réinitialisation** — l'action de réinitialisation revient au
  thème intégré, retire les liens CSS de runtime et efface les remplacements
  `--st-*` en ligne. Supprimer le thème actif réinitialise aussi la sélection
  de thème enregistrée.
- **Les thèmes ne peuvent pas cacher les Paramètres** — la barre de
  navigation garde toujours l'élément Paramètres accessible, car les éléments
  système omis sont restaurés dans l'ordre standard. En mode sans échec,
  l'ordre intégré de la barre est utilisé et la bascule de menu reste
  disponible.
- **Pas d'exécution de code** — les thèmes ne contiennent aucun JavaScript du
  tout. Ils sont du CSS, des jetons et une mise en page déclarative, donc il
  n'y a aucun code de thème qui pourrait s'exécuter avant que le mode sans
  échec ne prenne effet.

## Restrictions des Packages de Thème

Un package de thème ne reçoit jamais d'accès aux conversations, aux clés API
ou au système de fichiers. Ses feuilles de style sont validées contre les
constructions interdites (`@import`, URL distantes, URL `javascript:`,
`expression()`, `!important` et autres) avant d'être acceptées, et ses jetons
doivent être des valeurs CSS sûres. Il n'y a pas de point d'entrée
exécutable dans le Theme SDK.

## Mode Sans Échec pour les Plugins

Le même interrupteur désactive les plugins tiers. Les bacs à sable de
plugins, l'isolation des processus et le nettoyage imposé par l'hôte sont la
couche de runtime ; le mode sans échec est l'interrupteur ceinture-et-
bretelles qui empêche le code non fiable de se charger en premier lieu.
Consultez [Bac à sable des plugins](../plugin-sdk/sandboxing.md) pour les
détails côté plugin.

## Vérifier le Mode Sans Échec Programmatiquement

Le package `@neotavern/theme-sdk` exporte `getSafeModeFromSearch(search)`, qui
analyse la chaîne de recherche de l'URL et renvoie si `?safe=1` est présent.
L'hôte l'utilise comme la porte unique avant de charger le CSS des packages
et les remplacements de jetons, et la même fonction est disponible pour les
hôtes alternatifs.

Pour les zones de shell qui restent disponibles en mode sans échec,
consultez [Contrat de shell](shell-contract.md).
