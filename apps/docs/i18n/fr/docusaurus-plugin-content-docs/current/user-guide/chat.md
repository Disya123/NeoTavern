---
title: Discussion
description: >-
  Comment fonctionne le chat dans NeoTavern — streaming, swipes,
  régénération, édition et arrêt.
sidebar_position: 2
---

Cette page couvre la vue de chat : composer et envoyer des messages, regarder
les réponses arriver en streaming et utiliser les actions de message que
NeoTavern fournit.

## Envoyer des Messages

La zone de saisie se trouve en bas de la zone de discussion. Saisissez un
message et appuyez sur `Entrée` pour l'envoyer ; appuyez sur `Maj+Entrée`
pour une nouvelle ligne. Votre message apparaît instantanément, et la réponse
arrive en streaming dans la vue par lots d'au plus 30 mises à jour
d'interface par seconde. Vous pouvez faire défiler l'historique pendant
qu'une réponse arrive en streaming — le défilement automatique ne vous suit
que tant que vous restez en bas, et une action « nouveau message » apparaît
après un défilement manuel vers le haut.

Pendant qu'une réponse est générée, le bouton principal de la zone de saisie
devient **Arrêter**. L'arrêt conserve le texte reçu jusqu'ici comme une
réponse incomplète explicitement marquée. Une connexion coupée propose une
reconnexion et ne crée jamais de message en double.

Votre brouillon est enregistré par conversation, donc changer de conversation
et revenir ne perd jamais ce que vous étiez en train de saisir.

## Swipes (Messages Alternatifs)

Chaque message de l'assistant peut contenir plusieurs réponses alternatives,
appelées swipes. Un paginateur sous le message affiche le compte sous la
forme `N/M` avec des flèches précédent/suivant ; cliquer sur les flèches fait
défiler les variantes sans en perdre aucune. L'historique des swipes est
conservé et non destructif.

## Régénérer

L'action Régénérer réécrit le **dernier** message de l'assistant sur place :
une nouvelle réponse arrive en streaming dans la bulle existante, et le texte
précédent devient une autre variante dans le paginateur de swipes. Si la
génération échoue ou est arrêtée, l'ancien texte reste intact sur le disque.

## Modifier des Messages

Ouvrez l'action Modifier sur un message pour changer son texte. L'éditeur
en ligne enregistre avec `Ctrl+Entrée` (ou `Cmd+Entrée` sur macOS) et annule
avec `Échap`. Les modifications sont non destructives : le contenu précédent
est archivé dans l'historique de modification du message, d'où vous pouvez le
restaurer à tout moment. Si le message a changé ailleurs pendant que vous le
modifiiez, l'éditeur conserve votre brouillon et affiche un avis de conflit
au lieu d'écraser silencieusement.

## Actions de Message

La barre d'actions de chaque message est toujours visible, pas seulement au
survol :

- Copier le texte brut du message.
- Modifier le message.
- Régénérer la dernière réponse de l'assistant.
- Faire défiler les variantes (swipes).
- Créer un **point de contrôle** ou une **branche** : un instantané de la
  conversation figé à ce message, copié dans une conversation enfant. Utilisez
  les points de contrôle pour explorer des intrigues sans toucher à la
  conversation principale.
- Supprimer le message. La suppression déplace les conversations vers un état
  corbeille plutôt que de les détruire instantanément.

Les plugins peuvent ajouter leurs propres actions à la même barre, sous
réserve des permissions que vous leur avez accordées. Consultez
[Extensions](extensions).

## Contrôle au Clavier

Tout le flux de chat fonctionne au clavier : `Tab` et `Maj+Tab` déplacent le
focus, `Échap` ferme le panneau ou la boîte de dialogue le plus haut, et le
paginateur de swipes, les liens de points de contrôle et les actions de
message sont tous des contrôles focusables. Consultez
[Raccourcis clavier](keyboard-shortcuts) pour la liste complète.
