---
title: Fichiers et images
description: >-
  Comment les fichiers utilisateur sont stockés sur le disque : originaux
  séparés du cache, pipeline d'import d'images, vignettes et écritures
  atomiques.
sidebar_position: 3
---

Les fichiers utilisateur sont stockés sur le disque, jamais comme BLOB : les
originaux vivent dans `data/files/`, les vignettes régénérables dans
`data/cache/thumbnails/`, et chaque écriture est atomique.

## Originaux vs. Cache

La séparation est stricte :

- **Originaux** — `data/files/{avatars,backgrounds,attachments,audio,generated}/`.
  Les originaux ne sont jamais modifiés et jamais supprimés par la maintenance
  du cache.
- **Cache** — `data/cache/thumbnails/`. Les vignettes sont régénérables et
  adressées par contenu.

Vider le cache ne supprime jamais les originaux. Une vignette manquante est
régénérée automatiquement à partir de l'original.

## Le Pipeline d'Import d'Images

Importer une image suit un pipeline fixe :

1. Valider la taille, le type MIME et l'extension.
2. Calculer un hash de contenu (SHA-256).
3. Enregistrer l'original sans perte, adressé par contenu
   (`{sha256}{ext}`), ce qui déduplique par contenu.
4. Générer des vignettes basse résolution pour les galeries, listes et
   aperçus.
5. Stocker les vignettes dans `data/cache/thumbnails/`.
6. Clé de chaque vignette par le hash de l'original, la taille cible et la
   version de l'algorithme : `{hash}-{size}-v{algorithmVersion}`.
7. Ne pas régénérer une vignette dont la clé est inchangée.
8. Ne jamais charger l'original là où une vignette suffit.
9. Reconstruire le cache automatiquement quand une vignette manque.
10. Le vidage du cache ne touche jamais les originaux.

## Écritures Atomiques

Chaque écriture de fichier passe par un fichier temporaire suivi d'un
renommage. Un crash en plein milieu ne laisse jamais un fichier partiellement
écrit derrière. Cela s'applique aux originaux, aux vignettes et aux fichiers
de tokeniseur téléchargés de la même façon.

## Galerie de Personnages

Les images de galerie réutilisent la table `attachments` avec
`owner_type = character.gallery`. Les lignes de métadonnées contiennent les
URL de l'original et de sa vignette ; les octets restent dans
`files/avatars/` adressés par contenu. Retirer une image de la galerie
supprime l'enregistrement de pièce jointe, pas le fichier original —
l'action reste réversible et la déduplication est préservée.

## Fonds de Conversation

`files/backgrounds/` est la source de vérité : la liste est construite en
analysant le répertoire, donc les fonds importés de SillyTavern apparaissent
sans aucune étape de transfert. Les fichiers téléversés sont stockés adressés
par contenu et jamais modifiés.

Les vignettes de fond vivent dans `cache/thumbnails/`, avec pour clé le
SHA-256 du nom de fichier plutôt que du contenu, ce qui permet aux fichiers
importés de SillyTavern avec des noms arbitraires d'avoir aussi des
vignettes et garde téléversement, liste et suppression sur une seule clé. Un
fichier qui ne peut pas être décodé ou qui dépasse 64 Mio est listé sans
vignette ; l'original reste disponible. Supprimer un fond retire à la fois
l'original et sa vignette en cache.

## Imports de Fiches de Personnage

`POST /api/v2/characters/import` accepte les JSON de fiche de personnage
V1/V2 et les PNG avec métadonnées `chara`. L'entrée est limitée à 25 Mio et
détectée par contenu. Le SHA-256 de tout le fichier source est stocké dans
`ext._st2.importHash`, et ré-importer le même fichier renvoie
l'enregistrement existant. Les PNG sont validés par un décodeur d'images.
L'original est écrit atomiquement dans `files/avatars/` et une vignette WebP
est générée ; une vignette manquante est reconstruite à partir de l'original
à la lecture suivante.

## Maintenance du Cache

L'écran de diagnostic appelle `DELETE /api/v2/diagnostics/cache`, qui
supprime uniquement les fichiers de `cache/thumbnails/` et leurs lignes
`cache_metadata`. La racine `cache/` est conservée, donc les répertoires
d'étape de migration actifs ne sont jamais interrompus. Le résultat rapporte
le nombre et la taille des fichiers supprimés ; le ré-exécuter est sûr et
renvoie des zéros.
