---
title: Vue d'ensemble du Theme SDK
description: "Ce qu'est le Theme SDK : un remplacement complet du shell visuel, niveau par niveau."
sidebar_position: 1
---

Le Theme SDK est le contrat versionné pour remplacer tout le shell visuel de
NeoTavern — pas seulement le recolorer.

## Ce Qu'est le Theme SDK

Un thème est un package (`.sttheme`) qui contrôle l'apparence de
l'application et la façon dont ses zones principales sont composées.
Contrairement à un plugin, un thème n'a pas de JavaScript : c'est du CSS, des
jetons sémantiques et une mise en page de shell déclarative dans un
manifeste. Comme le SDK est déclaratif, un thème ne peut pas casser le
comportement de l'application ni atteindre ses données.

Le package `@neotavern/theme-sdk` fournit le contrat lui-même : les noms de jetons
canoniques, la validation du manifeste, la résolution d'héritage et la
génération de variables CSS. L'implémentation de référence de l'hôte applique
un thème en écrivant les propriétés personnalisées `--st-*` sur la racine du
document et en chargeant les feuilles de style du thème dans un ordre défini.

## Les Trois Niveaux

La thématisation est structurée en trois niveaux, et un thème peut utiliser
n'importe lequel d'entre eux :

1. **Design tokens** — variables sémantiques pour les couleurs, polices,
   espacements, rayons, ombres, couches z-index, mouvement et tailles de
   contrôles. Les composants référencent exclusivement ces jetons, donc
   remplacer un jeton restyle toute l'interface de façon cohérente.
2. **Skin des composants** — du CSS qui restyle les composants via les hooks
   stables `data-component`, `data-part`, `data-role` et `data-state`.
3. **Mise en page du shell** — composition déclarative des zones
   principales : la barre de navigation, les panneaux de gestion et
   l'espace de travail de chat.

Comme la logique de chat, le modèle de données et le comportement ne sont pas
touchés, un thème peut imiter un système d'exploitation, une console de jeu,
une interface de visual novel ou une mise en page d'application mobile sans
casser aucune fonctionnalité. Consultez [Niveaux](levels.md) pour les
détails.

## Créer Sans Étape de Build

Un thème est un ZIP avec `theme.json`, `components.css` et `shell.css`. Vous
pouvez en construire un à la main :

1. Ouvrez le gestionnaire de Thèmes et téléchargez le kit de démarrage de
   thème.
2. Décompressez-le et modifiez `theme.json`, `components.css` et
   `shell.css`.
3. Re-zippez les fichiers à la racine de l'archive et installez le package.
4. Vérifiez les modes clair et sombre, le mobile, le focus clavier, le RTL et
   le mode sans échec, puis appliquez le thème.

Aucun Node.js, npm, JavaScript ni CLI du Theme SDK n'est requis pour un
premier thème.

## Installation et Activation

Installer un package ne l'active pas. L'activation valide toute la chaîne
`extends` pour les parents manquants et les cycles, puis met à jour le thème
activé et la sélection de thème enregistrée dans une seule transaction.
Mettre à jour un package avec le même id remplace atomiquement son
répertoire et conserve l'état d'activation actuel ; en cas d'erreur de
registre, le répertoire précédent est restauré.

La distribution livre un ensemble de thèmes intégrés, comme AMOLED, GitHub
Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night, Catppuccin Mocha,
Solarized Dark et One Dark, donc le gestionnaire de Thèmes ne s'ouvre jamais
vide.

## Sécurité

Les thèmes ne peuvent pas lire les conversations, les clés API ou le système
de fichiers, et ils ne contiennent aucun code exécutable. Chaque feuille de
style est analysée à la recherche de constructions interdites, et le mode
sans échec désactive entièrement les thèmes tiers. Consultez
[Mode sans échec](safe-mode.md) pour les garanties, et la
[référence du Theme SDK](../api/theme-sdk/) générée pour l'API complète.

## Étapes Suivantes

- [Niveaux](levels.md) — jetons, skins et mises en page de shell.
- [Design tokens](design-tokens.md) — le contrat de jetons sémantiques.
- [Skin des composants](component-skin.md) — la pile de style et les hooks.
- [Contrat de shell](shell-contract.md) — zones nommées et emplacements
  stables.
- [Mode sans échec](safe-mode.md) — la récupération après un thème cassé.
