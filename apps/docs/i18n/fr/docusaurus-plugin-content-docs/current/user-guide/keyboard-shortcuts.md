---
title: Raccourcis clavier
description: Les raccourcis clavier par défaut de NeoTavern en un coup d'œil.
sidebar_position: 11
---

Cette page liste les raccourcis clavier par défaut de NeoTavern. Toute
l'application est utilisable au clavier, et chaque fenêtre modale garde le
focus à l'intérieur d'elle-même jusqu'à ce que vous la fermiez.

## Zone de Saisie

| Action                           | Raccourci                                              |
| -------------------------------- | ------------------------------------------------------ |
| Envoyer un message               | `Entrée`                                               |
| Insérer une nouvelle ligne       | `Maj+Entrée`                                           |
| Rechercher dans la conversation  | Mettre le focus sur le champ de recherche de l'en-tête |
| Défiler jusqu'au dernier message | Action « nouveau message » après un défilement         |

L'indice de la zone de saisie affiche toujours le mode actuel, vous pouvez
donc voir d'un coup d'œil si `Entrée` envoie ou ajoute une ligne.

## Modifier des Messages

| Action                      | Raccourci                                             |
| --------------------------- | ----------------------------------------------------- |
| Enregistrer la modification | `Ctrl+Entrée` (Windows/Linux) ou `Cmd+Entrée` (macOS) |
| Annuler la modification     | `Échap`                                               |

L'édition est non destructive : le contenu précédent est archivé dans
l'historique de modification du message, et un conflit conserve votre
brouillon au lieu de l'écraser. Consultez [Discussion](chat).

## Navigation et Panneaux

| Action                                                          | Raccourci                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| Fermer le panneau, la boîte de dialogue ou le menu le plus haut | `Échap`                                                        |
| Déplacer le focus vers l'avant / l'arrière                      | `Tab` / `Maj+Tab`                                              |
| Fermer une surface consciente de la route                       | Bouton Précédent du navigateur                                 |
| Redimensionner un panneau                                       | `Flèche gauche` / `Flèche droite` quand la poignée est focusée |
| Ouvrir et fermer le menu de navigation                          | Le bouton de bascule de la barre                               |

`Échap` ferme d'abord la surface la plus haute : une boîte de dialogue
imbriquée se ferme avant le panneau derrière elle, et le focus revient au
contrôle qui l'a ouverte.

## Actions de Chat

| Action                                | Raccourci                                               |
| ------------------------------------- | ------------------------------------------------------- |
| Basculer entre les variantes de swipe | Flèches précédent / suivant du paginateur `N/M`         |
| Ouvrir un point de contrôle           | Cliquer le fanion (`Maj+clic` en crée un nouveau)       |
| Exclure ou restaurer un message       | L'action d'exclusion dans la barre (stratégie manuelle) |

Les actions de message sont toujours visibles sur desktop et groupées dans la
fiche de message compacte sur mobile ; chaque action est un contrôle
focusable, donc aucune action ne nécessite le survol ou un pointeur.

## Raccourcis des Plugins

Les plugins enregistrent leurs raccourcis via le Plugin SDK, qui résout les
collisions afin que l'enregistrement actif le plus récent gagne et libère la
liaison quand le plugin est désactivé. Les raccourcis de plugins
n'interceptent jamais les combinaisons système du navigateur, et la palette
de commandes liste le raccourci de chaque commande dans son contexte.
Consultez [Extensions et plugins](extensions).
