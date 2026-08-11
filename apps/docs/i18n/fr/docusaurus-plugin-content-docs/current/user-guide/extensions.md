---
title: Extensions et plugins
description: Installer, activer, désactiver et désinstaller des plugins dans NeoTavern.
sidebar_position: 9
---

Cette page explique comment fonctionnent les plugins dans NeoTavern : où les
obtenir, comment fonctionnent les permissions et le consentement, et comment
l'application tient le code non fiable en échec.

## Ce Qu'est un Plugin

Un plugin ajoute du comportement à NeoTavern — actions de barre d'outils,
actions de message, commandes slash, intercepteurs de prompt, panneaux
personnalisés, raccourcis clavier, routes backend ou intégrations avec des
services externes. Les plugins s'exécutent contre le Plugin SDK stable, pas
contre les entrailles de l'application, et chaque fonctionnalité qu'ils
enregistrent est retirée quand le plugin est désactivé.

Le catalogue officiel livre certains plugins ; les packages tiers sont
installés depuis un ZIP `.stplugin` ou un lien de dépôt Git public (GitHub ou
GitLab, HTTPS uniquement). Le serveur n'exécute jamais Git ni npm : un lien
Git est téléchargé comme une archive et validé exactement comme un ZIP.

## Installer un Plugin

Ouvrez la section Plugins et installez un package :

1. Avant l'installation, l'application affiche l'auteur, la version, la
   source, la compatibilité, la signature (le cas échéant) et la liste
   complète des permissions.
2. Vous examinez et consentez explicitement aux permissions. Le package reste
   dans un état « nécessite un consentement » jusqu'à ce que vous confirmiez
   chaque permission demandée.
3. L'installation est atomique : en cas d'erreur, la version précédente reste
   installée et fonctionnelle.

Si le package déclare des dépendances npm, elles sont résolues depuis le
registre via HTTPS, vérifiées par somme de contrôle et jamais exécutées — les
scripts d'installation et les binaires natifs sont rejetés d'emblée.

## Permissions

Une permission dans le manifeste est une demande de capacité, pas un accès
automatique. Avant qu'un plugin puisse lire les conversations, modifier les
prompts, toucher vos fichiers ou atteindre le réseau, vous devez accorder la
permission correspondante, et l'écran de consentement décrit ce que fait
chacune. Deux règles comptent :

- **Les nouvelles permissions après une mise à jour exigent un nouveau
  consentement.** Une mise à jour ne peut jamais étendre silencieusement les
  droits d'un plugin.
- Les permissions peuvent être révoquées. La révocation prend effet au
  prochain appel de capacité du plugin.

## Gérer les Plugins

Le gestionnaire affiche l'état de chaque plugin : activé, désactivé, nécessite
des permissions, incompatible ou erreur. Depuis là, vous pouvez :

- **Activer ou désactiver** un plugin. La désactivation retire son interface,
  ses hooks, ses minuteries, ses routes et ses abonnements sans redémarrage,
  et le nettoyage est imposé par l'hôte.
- **Le désinstaller**, ce qui efface aussi ses enregistrements.
- **Examiner la compatibilité** des extensions de l'ère SillyTavern héritées,
  qui affichent leur niveau de compatibilité et leurs limites connues.

Une erreur dans un plugin est isolée : l'application propose de désactiver
seulement ce plugin au lieu de casser toute l'interface.

## Sécurité des Plugins

Les plugins backend non fiables s'exécutent dans un processus restreint
séparé, et l'interface des plugins en bac à sable s'exécute dans un iframe
avec un canal RPC contrôlé. Les packages de thème n'ont aucun accès aux
conversations, clés ou fichiers. Le mode sans échec désactive tous les
plugins et thèmes tiers et est accessible avant leur chargement, donc tout
comportement fautif d'un plugin peut toujours être contourné. Consultez
[Mode sans échec et récupération](themes) et la documentation du
[Plugin SDK](../developers/plugin-sdk/).
