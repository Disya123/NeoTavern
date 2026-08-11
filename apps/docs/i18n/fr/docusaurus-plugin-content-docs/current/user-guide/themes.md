---
title: Thèmes
description: Installer, changer et créer des thèmes dans NeoTavern, plus le mode sans échec.
sidebar_position: 8
---

Cette page explique comment fonctionnent les thèmes dans NeoTavern : ce qu'ils
peuvent changer, comment les installer et les changer, et comment le mode
sans échec vous protège.

## Ce Qu'un Thème Change

Un thème a trois niveaux :

- **Design tokens** — couleurs, polices, espacements, rayons, ombres et
  durées d'animation.
- **Skin des composants** — l'apparence des boutons, panneaux et autres
  contrôles.
- **Mise en page du shell** — l'agencement des régions nommées : navigation,
  navigateur de personnages, zone d'affichage du chat, panneaux latéraux et
  couche modale.

Cela signifie que les thèmes sont des refontes visuelles complètes, pas de
simples échanges de couleurs. Un thème peut restyler l'application comme une
console de jeu, un visual novel ou un client mobile sans changer aucune
logique de chat. Changer le thème, le skin des composants ou la mise en page
du shell ne nécessite jamais de redémarrage.

## Thèmes Intégrés

Le premier lancement prépare un ensemble de thèmes intégrés, notamment
AMOLED, GitHub Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night et
Catppuccin Mocha. Le gestionnaire de Thèmes s'ouvre toujours avec ces thèmes
disponibles, vous pouvez donc changer de style immédiatement.

## Installer des Thèmes

Un package de thème est un fichier `.sttheme` — un ZIP avec un manifeste
`theme.json` et du CSS, jusqu'à 25 Mo. Installez-le via le gestionnaire de
Thèmes :

1. Ouvrez Thèmes depuis la barre de navigation ou l'onglet Paramètres →
   Thèmes.
2. Installez le package. Le serveur valide les chemins, les types de
   fichiers, les tailles et le manifeste avant que quoi que ce soit ne soit
   écrit, et rejette les chemins de traversée, les liens symboliques et le
   CSS interdit.
3. Aperçu du thème avant de l'appliquer. Depuis l'aperçu, vous pouvez
   accepter le thème, revenir en arrière ou ouvrir ses paramètres.
4. Activez-le. L'installation n'active jamais un thème par elle-même.

Les mises à jour d'un thème installé le remplacent atomiquement et
conservent son état d'activation. Si un thème ne se charge pas, le shell
restaure automatiquement la dernière mise en page fonctionnelle.

## Thèmes Personnalisés

Les thèmes sont des packages, pas des bidouillages : un thème n'a aucun accès
à vos conversations, clés API ou système de fichiers. Le Theme SDK documente
les hooks stables — `data-component`, `data-part`, `data-role` et
`data-state` — que les thèmes stylent, et le contrat de shell qui définit les
régions nommées. Les remplacements CSS personnalisés se chargent en dernier
dans la cascade. Consultez la référence du
[Theme SDK](../developers/theme-sdk/) pour créer le vôtre.

## Mode Sans Échec et Récupération

Le mode sans échec désactive tous les thèmes et plugins tiers et est
accessible avant leur chargement, donc un thème cassé ne peut jamais vous
verrouiller dehors. Après une boucle de crash, l'application propose un
lancement sécurisé automatiquement. L'action intégrée **Réinitialiser
l'interface** restaure le thème par défaut sans modifier de fichiers à la
main, et aucun thème n'est autorisé à masquer cette action.

Consultez [Paramètres](settings) pour l'onglet Général où vivent les options
de thème actif et de style de message.
