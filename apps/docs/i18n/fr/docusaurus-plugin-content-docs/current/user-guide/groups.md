---
title: Groupes
description: Comment NeoTavern gère les conversations multi-personnages et les chats de groupe.
sidebar_position: 4
---

Cette page explique ce que sont les groupes et comment NeoTavern gère les
conversations multi-personnages aujourd'hui.

## Ce Qu'est un Groupe

Un groupe est une conversation unique à laquelle plusieurs personnages
participent. Là où un chat régulier a un personnage plus votre persona, un
chat de groupe alterne entre les personnages pour que chaque réponse puisse
venir d'un participant différent.

## Les Groupes dans NeoTavern Aujourd'hui

Le modèle de chat central de NeoTavern est un personnage par conversation,
avec votre persona superposé par-dessus. Une fonctionnalité dédiée de chat de
groupe qui vous permet de créer une conversation et d'en changer les membres
dans l'application est **prévue** ; elle n'est pas disponible dans la version
actuelle, donc cette page décrit ce qui fonctionne aujourd'hui à la place.

## Chats de Groupe Importés

Quand vous migrez une sauvegarde SillyTavern via Paramètres → Données, les
chats de groupe sont traités en toute sécurité :

- Les définitions de groupe et leurs transcriptions sont importées comme des
  conversations régulières, portant l'enregistrement de groupe d'origine dans
  les métadonnées de la conversation.
- La transcription conserve chaque nom de participant, message et variante de
  swipe, si bien que l'historique multi-personnages reste lisible et que vous
  pouvez continuer la conversation.
- Les catégories non prises en charge sont listées explicitement dans le
  rapport d'import au lieu d'être silencieusement supprimées.

## Travailler avec Plusieurs Personnages Maintenant

Tant que les groupes natifs sont prévus, ces fonctionnalités couvrent les
flux de travail multi-personnages courants :

- **Conversations séparées par personnage.** Chaque personnage conserve son
  propre historique de conversation, et le panneau Conversations limite la
  liste au personnage actuel.
- **Un monde partagé via les lorebooks.** Liez un lorebook à plusieurs
  personnages pour que des connaissances de monde cohérentes atteignent
  chaque conversation. Consultez [Lorebooks](lorebook).
- **Branches d'intrigue.** Utilisez les points de contrôle et les branches
  pour explorer des chemins divergents avec n'importe quel personnage sans
  perdre la conversation principale. Consultez [Discussion](chat).
- **Personas.** Changez votre propre persona par conversation pour modifier
  la façon dont vous vous présentez dans chaque échange.

Si vous avez besoin d'une véritable conversation multi-personnages, gardez à
l'esprit l'approche du chat de groupe importé : elle préserve votre
historique de groupe existant, et la fonctionnalité native prévue s'appuiera
sur les mêmes données.
