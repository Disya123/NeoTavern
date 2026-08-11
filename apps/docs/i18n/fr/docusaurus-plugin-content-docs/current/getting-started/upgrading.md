---
title: Mise à jour
description: >-
  Comment fonctionnent les mises à jour de NeoTavern et pourquoi vos
  données restent en sécurité pendant une mise à jour.
sidebar_position: 4
---

Cette page explique comment les mises à jour de NeoTavern sont livrées, ce qui
arrive à vos données pendant une mise à jour et où lire ce qui a changé.

## Comment Fonctionnent les Mises à Jour

NeoTavern traite l'application principale, les plugins et les thèmes comme
des unités séparées, et chacune se met à jour indépendamment :

- **Les mises à jour du cœur** remplacent l'application elle-même, en
  laissant votre répertoire de données intact.
- **Les mises à jour de plugins et de thèmes** passent par leurs gestionnaires
  respectifs dans l'application et ne s'activent jamais automatiquement sans
  votre avis.
- Chaque installation est atomique : la nouvelle version remplace l'ancienne
  en une seule étape, et la version précédente est conservée pour qu'une mise
  à jour échouée puisse être annulée.
- L'intégrité du paquet est vérifiée par somme de contrôle, et le catalogue
  officiel peut ajouter des signatures par-dessus.

Vous n'avez jamais besoin de Git, npm ou d'un terminal pour mettre à jour. Si
vous avez installé l'application normalement, vous la mettez à jour de la
même façon que vous l'avez installée.

## Sécurité des Données Pendant les Mises à Jour

- Les mises à jour ne modifient jamais directement vos fichiers utilisateur :
  personnages, conversations, lorebooks, personas et paramètres ne sont pas
  touchés par l'installeur.
- Quand une mise à jour inclut une migration de schéma de base de données,
  une sauvegarde est créée avant que la migration ne s'exécute, et les
  migrations sont transactionnelles et idempotentes.
- Votre base de données SQLite fonctionne en mode WAL, donc l'application
  reste utilisable et vos écritures restent durables pendant une migration ou
  une mise à jour.
- Si une mise à jour de plugin ou de thème échoue, l'application garde la
  version précédente fonctionnelle au lieu de laisser un paquet à moitié
  installé.

## Vérifier ce Qui a Changé

Le [changelog](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md)
liste chaque changement avec son impact. Avant de mettre à jour, parcourez les
entrées les plus récentes : les changements cassants sont accompagnés d'un
guide de migration, et les fonctionnalités encore expérimentales ou prévues
sont marquées explicitement.

## Mettre à Jour les Plugins et les Thèmes

Ouvrez la section Plugins et Thèmes. Chaque élément installé affiche sa
version, son état et si une mise à jour est disponible. Si une mise à jour
demande de nouvelles permissions, l'application redemande votre consentement
explicite avant de les appliquer — les permissions ne sont jamais étendues
silencieusement par une mise à jour.

## Revenir en Arrière

Comme la version précédente est conservée pendant les mises à jour du cœur,
vous pouvez la réinstaller si une nouvelle version se comporte mal. Votre
répertoire de données est lisible en arrière, et une sauvegarde créée avant
toute migration risquée vous permet de restaurer un état connu-bon depuis
l'interface. Consultez
[Données et sauvegardes](../user-guide/data-and-backups).
