---
title: Sauvegardes
description: >-
  Le modèle de sauvegarde : instantanés SQLite en ligne, restauration sûre
  avec une sauvegarde de sécurité, et ce que couvrent les sauvegardes.
sidebar_position: 4
---

Les sauvegardes sont des instantanés SQLite en ligne créés via l'API de
sauvegarde SQLite, sûres à exécuter avec le WAL et restaurables sans outils
externes.

## Modèle de Sauvegarde

Une sauvegarde est un instantané cohérent de la base de données SQLite, créé
pendant que le serveur fonctionne :

- `POST /api/v2/backups` crée l'instantané via l'API de sauvegarde SQLite,
  qui est sûre avec le WAL et ne bloque pas les lecteurs.
- `GET /api/v2/backups` liste les sauvegardes existantes ; le contenu du
  cache et les logs ne sont pas inclus.

Chaque enregistrement de sauvegarde affiche sa date, sa taille, sa version de
schéma, sa source et son état. L'interface affiche les mêmes informations, et
créer une sauvegarde n'interrompt jamais la lecture des données locales.

## Ce Que Couvrent les Sauvegardes

Une sauvegarde couvre toute la base de données structurée : personnages,
personas, conversations et messages, lorebooks, presets, configurations de
fournisseurs, état des plugins et paramètres. Elle n'inclut pas :

- `cache/thumbnails/` — régénérable, et exclu par conception ;
- les logs — exclus par conception ;
- les répertoires d'étape d'import — temporaires par conception.

Les originaux dans `files/` sont adressés par contenu et jamais touchés par
la maintenance du cache, donc ils ne font pas partie de l'instantané
lui-même.

## Restauration

`POST /api/v2/backups/:id/restore` suit une séquence sûre :

1. Créer et faire tourner une **sauvegarde de sécurité** de l'état actuel.
2. Valider l'instantané sélectionné avec `PRAGMA quick_check`.
3. Le copier dans la base de données en direct via l'API de sauvegarde en
   ligne SQLite.

La connexion et les dépôts restent ouverts : la réponse porte
`restartRequired: false`, et les lectures et écritures suivantes continuent
de fonctionner sans redémarrage. La restauration ne nécessite jamais d'outils
SQLite externes. Un instantané ou une copie échoué renvoie `RESTORE_FAILED`,
et la sauvegarde de sécurité est conservée, donc l'état actuel n'est jamais
perdu dans une restauration échouée.

Dans l'interface, la restauration exige une confirmation explicite, n'est
jamais signalée comme réussie avant que la vérification d'intégrité ne passe,
et propose un retour automatique à la copie de sécurité si quelque chose tourne
mal. Supprimer une sauvegarde vous avertit si c'est la dernière copie
fonctionnelle.

## Les Sauvegardes Comme Filet de Sécurité

Les mêmes mécanismes d'instantané protègent les opérations dangereuses :

- Le runner de migrations crée une sauvegarde pré-migration pour les bases de
  données peuplées avant les migrations qui reconstruisent ou remodèlent des
  tables.
- L'exécution d'import crée une sauvegarde de sécurité avant d'écrire
  n'importe quelle donnée sélectionnée, donc un import échoué ou interrompu
  peut toujours être annulé.
- La restauration photographie toujours l'état actuel d'abord, comme décrit
  ci-dessus.

## Voir Aussi

- [Stockage SQLite](sqlite) pour la base de données elle-même.
- [Fichiers et images](files-and-images) pour ce qui vit en dehors de la base
  de données.
- Le flux orienté utilisateur est documenté dans le
  [Guide utilisateur](../../user-guide/data-and-backups).
