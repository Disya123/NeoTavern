---
title: Données et sauvegardes
description: >-
  Où NeoTavern stocke vos données, comment exporter et importer, et
  comment fonctionnent les sauvegardes.
sidebar_position: 10
---

Cette page explique où vivent vos données, ce que contient le répertoire de
données, et comment exporter, importer et sauvegarder votre bibliothèque.

## Le Répertoire de Données

Toutes les données utilisateur vivent dans un seul répertoire de données,
créé au premier lancement. Son emplacement exact est affiché dans
Paramètres → Données ; vous pouvez pointer le serveur vers un autre
emplacement avec la variable d'environnement `NEOTA_DATA_DIR`. La disposition :

- `app.db` — la base de données SQLite : personnages, conversations, messages,
  lorebooks, entrées de mémoire, personas, presets et paramètres. Elle
  fonctionne en mode WAL avec les clés étrangères activées et la recherche
  plein texte pour les personnages, les conversations et les messages.
- `files/` — les fichiers utilisateur originaux : avatars, fonds, pièces
  jointes, audio et images générées. Ce ne sont jamais des données dérivées.
- `cache/` — les données régénérables : vignettes, données de tokeniseur et
  téléchargements de plugins. Vider un cache ne touche jamais vos originaux.
- `backups/` — les archives de sauvegarde que vous créez depuis l'interface.
- `logs/` — les logs serveur expurgés.
- `plugins/` et `themes/` — les packages installés, chacun confiné dans son
  propre répertoire.

## Ce Qui est Stocké

Les personnages et leurs fiches, les conversations avec l'historique complet
des messages et les variantes de swipe, les lorebooks, les entrées de
mémoire, les personas, les presets de génération, les profils de connexion,
les thèmes, les plugins et vos paramètres. Les clés API sont stockées
localement dans un gestionnaire de clés chiffré et ne sont jamais écrites
dans les logs, le stockage du navigateur ou les exports de diagnostic.

## Export et Import

- **Les fiches de personnage** s'exportent en PNG ou JSON, et les
  conversations s'exportent comme des archives que vous pouvez conserver ou
  déplacer vers une autre machine. Consultez [Personnages](characters).
- **La migration SillyTavern** vit dans Paramètres → Données : choisissez un
  ZIP de sauvegarde de données complète, et l'application exécute d'abord une
  analyse en lecture seule qui rapporte les objets, les enregistrements
  imbriqués, les dommages, la taille et les conflits par catégorie —
  personnages, conversations, personas, lorebooks et presets. Rien n'est
  écrit avant que vous n'examiniez le rapport et ne confirmiez. Vous choisissez
  ensuite les catégories et une politique de conflit explicite (conserver
  l'existant, créer des copies, fusionner en toute sécurité ou remplacer
  depuis l'archive). Les secrets, plugins, thèmes et catégories non pris en
  charge sont listés comme ignorés, et répéter l'import ne crée jamais de
  doublons.

## Sauvegardes

Les sauvegardes sont créées et restaurées entièrement depuis l'interface dans
Paramètres → Données :

- **Créez** une sauvegarde à tout moment ; en créer une ne bloque pas la
  lecture de vos données.
- L'écran de sauvegarde affiche la date, la taille, la version du schéma, la
  source et l'état.
- **Restaurer** demande une confirmation, crée d'abord une sauvegarde de
  protection de l'état actuel et vous informe que l'application doit
  redémarrer ensuite.
- La restauration n'est signalée comme réussie qu'après vérification de
  l'intégrité ; si elle échoue, l'application propose un retour automatique à
  la copie de protection.

Avant toute migration de schéma dangereuse, l'application crée une
sauvegarde d'elle-même. Combiné à la base WAL, cela signifie qu'une mise à
jour ou une restauration a toujours une solution de repli connue-bonne.
Consultez [Mise à jour](../getting-started/upgrading).
