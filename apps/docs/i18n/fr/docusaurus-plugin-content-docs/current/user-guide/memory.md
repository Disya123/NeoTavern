---
title: Mémoire et rappel
description: Mémoire de conversation, entrées de mémoire, rappel vectoriel et RAG dans NeoTavern.
sidebar_position: 6
---

Cette page explique les fonctionnalités de mémoire qui aident le modèle à se
souvenir sur de longues conversations : la mémoire de conversation glissante,
les entrées de mémoire activées par mots-clés et le rappel vectoriel.

## Mémoire de Conversation

Chaque conversation conserve un résumé glissant que le pipeline maintient au
fur et à mesure que la conversation grandit. Quand la stratégie de
décalage de contexte `summarize` est active, l'historique exclu le plus
ancien est condensé en un résumé extractif local inséré avant l'entrée
utilisateur actuelle — ainsi le modèle garde l'essentiel des premiers
événements même après que les messages bruts quittent le budget de jetons.
Le résumé est stocké avec la conversation et survit aux rechargements.

Vous pouvez voir exactement ce que contient le prompt actuel avant
d'envoyer : un aperçu de contexte en direct montre le tokeniseur sélectionné,
la limite de contexte et l'espace de réponse réservé, les blocs exclus, les
blocs résumés et la stratégie appliquée. Consultez [Paramètres](settings)
pour le sélecteur de stratégie.

## Entrées de Mémoire

Les entrées de mémoire sont des fragments de connaissances durables qui
persistent entre les conversations, indépendamment de toute conversation
unique. Chaque entrée possède :

- **Portée** — `global` ou liée à un personnage.
- **Mots-clés d'activation** — une correspondance de sous-chaîne insensible à
  la casse contre le contexte de la conversation.
- **Contenu** — le texte injecté quand l'entrée se déclenche.

C'est le modèle RAG classique : la récupération est déclenchée par la
correspondance de mots-clés, et les fragments injectés répondent au besoin de
faits stables du modèle — détails de personnage, règles du monde ou points
d'intrigue en cours — sans gonfler chaque prompt. Comme les entrées de
lorebook, les blocs de mémoire sont classés par pertinence dans le pipeline
de prompts et comptent dans le budget de jetons.

## Rappel Vectoriel

Le rappel vectoriel est la stratégie de décalage de contexte
`vector-recall`. Au lieu de couper le contexte purement par ancienneté, elle
classe les blocs de lorebook et de mémoire par pertinence sémantique par
rapport à l'entrée actuelle et supprime d'abord les moins pertinents, puis
élague l'historique plus ancien. Le résultat : le modèle conserve le matériau
qui compte pour le message actuel même quand il n'est pas le plus récent.

La stratégie est sélectionnée par paramètres de génération, et les plugins
peuvent ajouter d'autres stratégies via le SDK. Chaque stratégie respecte
toujours le budget de jetons final contrôlé par l'hôte — les plugins ne
peuvent pas le contourner.

## Choisir une Stratégie

Les stratégies disponibles sont `truncate` (supprimer les groupes non
protégés les plus anciens), `summarize` (condenser l'historique exclu),
`vector-recall` (conserver les blocs très pertinents, élaguer par pertinence
et ancienneté) et `manual` (exclure des messages spécifiques du prompt sans
les supprimer de l'historique). Le mode manuel expose une action sur chaque
message pour l'exclure ou le restaurer, et les paires appel-d'outil/résultat
d'outil sont toujours traitées ensemble. Consultez [Discussion](chat) pour
les contrôles au niveau du message et [Lorebooks](lorebook) pour le modèle
d'activation par mots-clés associé.
