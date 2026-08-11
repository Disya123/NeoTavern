---
title: FAQ
description: >-
  Questions courantes sur les données, l'utilisation hors ligne, les
  plugins, les mises à jour et la migration
sidebar_position: 2
---

Cette page répond aux questions que les utilisateurs posent le plus souvent
à propos de NeoTavern.

## Où Sont Stockées Mes Données ?

Toutes vos données — conversations, personnages, personas, groupes, lorebooks,
mémoire et paramètres — vivent dans un répertoire de données sur votre
machine. Ce répertoire contient la base SQLite et le stockage de fichiers avec
les fiches de personnage, les images et autres ressources. Consultez
[Données et stockage](./developers/data/) et
[Données et sauvegardes](./user-guide/data-and-backups) pour la disposition
exacte et la marche à suivre pour la déplacer.

## NeoTavern Fonctionne-t-il Hors Ligne ?

Oui. NeoTavern est locale-first et utilisable hors ligne : pointez-le vers un
endpoint de modèle local et vous pouvez discuter sans aucune connexion
internet. Les fournisseurs cloud ont évidemment besoin du réseau, et
l'application vous prévient quand une connexion manque.

## Mes Données Sont-elles Envoyées vers le Cloud ?

Non. Vos conversations et vos fichiers restent sur votre machine. Le seul
trafic réseau provient des requêtes que vous configurez explicitement — les
fournisseurs que vous connectez pour la génération, la voix et les images —
et l'application n'envoie aucune télémétrie par défaut.

## Ai-je Besoin d'une Clé API ?

Uniquement pour les fournisseurs cloud que vous choisissez de connecter. Les
modèles locaux ne nécessitent aucune clé ; vous configurez chaque fournisseur
dans les Paramètres, et la clé reste dans votre profil de connexion.

## Les Plugins Sont-ils Sûrs ?

Les plugins fonctionnent sous un modèle de permissions et sont isolés dans un
bac à sable : les plugins backend s'exécutent dans un processus restreint, et
l'interface des plugins est isolée de l'application principale. Vous accordez
les permissions à l'installation, et le mode sans échec démarre l'application
sans plugins ni thèmes si quelque chose tourne mal. Consultez
[Extensions](./user-guide/extensions) et le
[Plugin SDK](./developers/plugin-sdk/).

## Puis-je Utiliser Mes Personnages Existants ?

Oui. NeoTavern importe les fiches de personnage standard, y compris les fiches
PNG avec JSON intégré, si bien que les personnages d'autres applications de
chat et de la galerie de personnages communautaire fonctionnent immédiatement.
Consultez [Personnages](./user-guide/characters).

## Puis-je Migrer Mes Plugins de l'Ère SillyTavern ?

Les plugins écrits pour l'ancien environnement SillyTavern peuvent
fonctionner via la couche de compatibilité héritée, qui fournit les globals
familiers `window.SillyTavern`, `window.eventSource` et `window.$` ainsi
qu'un hôte HTTP compatible Express. C'est un chemin de compatibilité, pas une
cible de réécriture : les nouveaux plugins doivent utiliser le
[Plugin SDK](./developers/plugin-sdk/). Consultez
[Compatibilité héritée](./developers/legacy-compat).

## Comment Fonctionnent les Mises à Jour ?

Les mises à jour s'installent sur place et préservent votre répertoire de
données. Le changelog liste ce qui a changé dans chaque version ; lisez-le
avant de mettre à jour pour repérer les changements cassants.

## Quelles Sont les Exigences Système ?

NeoTavern fonctionne sur Windows (installeur ou version portable), macOS
(package) et Linux (AppImage ou archive). L'application de bureau embarque son
propre runtime Node.js, vous n'avez donc rien d'autre à installer. Un système
d'exploitation 64 bits récent et quelques centaines de Mo de RAM libre pour le
backend suffisent pour un usage typique.

## Existe-t-il une Version Web ou Mobile ?

L'application de bureau est construite sur Tauri et est livrée avec un
compagnon PWA : l'interface web peut être installée comme une application web
progressive avec une coquille d'application hors ligne. Consultez
[Desktop](./developers/desktop/).

## Comment Sauvegarder Mes Données ?

Exportez les conversations vers des fichiers, exportez toute votre
bibliothèque, ou copiez le répertoire de données pendant que l'application
est arrêtée. Les sauvegardes sont des fichiers simples et portables ;
restaurez-les en les important ou en les remettant en place. Consultez
[Données et sauvegardes](./user-guide/data-and-backups) et
[Sauvegardes](./developers/data/backups).

## Qu'est-ce que le Mode Sans Échec ?

Le mode sans échec démarre NeoTavern sans plugins ni thèmes afin que vous
puissiez diagnostiquer les problèmes causés par du code tiers. Utilisez-le
quand l'application ne démarre pas après l'installation d'un plugin ou d'un
thème. Consultez [Dépannage](./getting-started/troubleshooting).

## Comment Signaler un Bug ou Demander une Fonctionnalité ?

Ouvrez une issue sur le [dépôt GitHub](https://github.com/Disya123/NeoTavern)
avec la version, votre OS et les étapes pour reproduire le problème. Les
demandes de fonctionnalités y sont également les bienvenues.

## Où Trouver le Changelog ?

Le changelog vit dans le dépôt à l'adresse
[CHANGELOG.md](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md).
