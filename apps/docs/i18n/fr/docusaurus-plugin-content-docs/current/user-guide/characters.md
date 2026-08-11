---
title: Personnages
description: >-
  La galerie de personnages, les fiches de personnage et l'import ou
  l'export de fiches dans NeoTavern.
sidebar_position: 3
---

Cette page explique comment trouver, créer, modifier et partager des
personnages dans NeoTavern. Un personnage est un participant à vos
conversations, adossé à une fiche de personnage qui stocke tout ce que l'IA
sait d'eux.

## La Galerie de Personnages

La section Personnages est votre navigateur de bibliothèque. Elle prend en
charge une vue en grille et une vue en liste compacte, toutes deux
virtualisées pour rester rapides avec des dizaines de milliers de fiches. Les
vignettes sont utilisées pour les aperçus ; les images originales ne se
chargent que lorsque vous ouvrez une fiche.

La recherche prend en charge un langage de requête simple : `tag:NSFW
author:Name "phrase exacte" -tag:beta`. Les filtres de tag et d'auteur se
combinent avec les termes de recherche, et les résultats sont classés par
pertinence à chaque fois que vous saisissez une requête. Le tri comprend
alphabétique, plus récent, plus ancien, favoris, récemment utilisé, plus ou
moins de conversations, plus ou moins de contenu et aléatoire.

## Créer et Modifier des Personnages

Ouvrez n'importe quelle fiche et choisissez Modifier. L'éditeur est divisé en
groupes clairs :

- **Identité** — nom, avatar et tags.
- **Description** — qui est le personnage.
- **Premier message** — le message d'accueil, plus d'éventuels messages
  d'accueil alternatifs.
- **Scénario** — le cadre à partir duquel le roleplay commence.
- **Exemples** — des exemples de dialogue qui façonnent le style du
  personnage.
- **Lore** — les lorebooks liés à ce personnage.
- **Images** — une galerie d'images, dont l'une est l'avatar principal.
- **Avancé** — personnalité, notes du créateur, remplacements de prompt, note
  du personnage avec profondeur et rôle, loquacité et métadonnées du
  créateur.

Seul le nom est requis pour créer un personnage. Les messages de validation
apparaissent à côté du champ et dans une liste d'erreurs finale, et les
champs obligatoires sont étiquetés avec du texte, pas seulement de la
couleur.

## Fiches de Personnage

Une fiche de personnage est la représentation portable d'un personnage. Ses
champs incluent le nom, la description, la personnalité, le scénario, le
premier message (message d'accueil), les messages d'accueil alternatifs, les
tags et l'avatar. Les fiches portent aussi les notes du créateur, et les
champs inconnus des fiches importées sont conservés plutôt que supprimés, de
sorte qu'aucune métadonnée n'est perdue quand vous faites voyager une fiche
via un autre outil.

## Importer et Exporter des Fiches

- **Importer** accepte les fiches de personnage PNG et JSON (V1 et V2), et
  cela fonctionne depuis la galerie, depuis une conversation ou pendant la
  configuration du premier lancement. L'import peut être répété sans risque —
  l'exécuter deux fois ne crée jamais de doublons.
- **Exporter** écrit la fiche en PNG ou JSON, exactement comme vous le
  choisissez, avec un instantané de version de l'état actuel.
- Les avatars et les images de galerie sont téléversés comme fichiers ; une
  image remplacée n'est jamais supprimée avant que la nouvelle ne soit
  enregistrée avec succès.

Si une fiche de votre bibliothèque est endommagée, NeoTavern affiche un
aperçu sûr avec la raison et vous permet d'exporter l'original pour pouvoir
le réparer ailleurs.
