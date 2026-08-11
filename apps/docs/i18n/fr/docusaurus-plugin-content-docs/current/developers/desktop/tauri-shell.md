---
title: Shell Tauri
description: Le shell natif Tauri 2 et comment fermer la fenêtre arrête le backend.
sidebar_position: 2
---

Le shell desktop est construit sur Tauri 2. Il possède la fenêtre native,
lance le backend et garantit que les deux s'arrêtent ensemble.

## Le Rôle du Shell

Le shell fait trois choses :

1. **Génère le sidecar** — il démarre le processus backend Node.js autonome
   et attend que l'API locale soit prête avant d'ouvrir la webview. Vous ne
   voyez jamais une fenêtre à moitié chargée pointant vers un serveur mort.
2. **Héberge la webview** — l'application web de production s'exécute dans
   la webview Tauri et parle au backend via `127.0.0.1` sur un port libre
   aléatoire.
3. **Possède le cycle de vie** — les événements de fenêtre et de processus
   sont câblés pour que le backend et le shell sortent toujours comme une
   seule unité.

## Cycle de Vie de la Fenêtre

- **Fermeture** — fermer la fenêtre déclenche un arrêt propre du sidecar. Le
  backend est invité à s'arrêter proprement, et l'application attend avant de
  sortir. Aucun processus Node.js orphelin n'est laissé derrière.
- **Crash du backend** — si le sidecar sort de façon inattendue, le shell se
  termine avec une erreur au lieu d'afficher une fenêtre qui ne peut rien
  faire. Les sorties normales sont marquées séparément pour qu'un arrêt
  propre ne soit jamais confondu avec un crash.
- **Redémarrage** — relancer l'application régénère le sidecar de zéro.
  L'état vit dans le répertoire de données, pas dans le processus, donc les
  redémarrages sont sans perte.

## La Fenêtre Est l'API

Comme le shell attend l'API avant d'afficher du contenu, le premier lancement
semble immédiat : la fenêtre s'ouvre sur une application prête. Le backend
n'écoute que sur `127.0.0.1` sur un port éphémère, donc rien n'est exposé au
réseau.

## Intégration de l'Updater

Les builds de release intègrent l'updater Tauri. Le shell peut vérifier les
mises à jour du cœur, vérifier le manifeste et la signature minisign,
installer l'artefact de la plateforme et redémarrer. L'updater remplace le
cœur séparément du répertoire de données utilisateur, et les rétrogradations
non signées sont rejetées. Les builds faits sans endpoint de mise à jour et
sans clé publique sont entièrement fonctionnels mais signalent que les mises
à jour ne sont pas configurées.

## Builds de Développement

Pour le développement, le même shell peut s'exécuter contre un serveur de
dev et un backend démarré localement. La garantie de production — le sidecar
sort avec la fenêtre — s'applique aux builds empaquetés ; `pnpm desktop:dev`
câble le shell à vos processus de dev en cours d'exécution à la place.

Pour savoir comment le sidecar est empaqueté et géré, consultez
[Sidecar Node](node-sidecar.md).
