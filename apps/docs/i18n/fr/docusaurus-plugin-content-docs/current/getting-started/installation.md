---
title: Installation
description: Comment installer NeoTavern sur Windows, macOS et Linux.
sidebar_position: 2
---

Cette page explique comment installer NeoTavern sur Windows, macOS et Linux.
Téléchargez la version adaptée à votre plateforme depuis la
[page des releases GitHub](https://github.com/Disya123/NeoTavern/releases).

## Cibles d'Installation

- **Installeur Windows.** Un exécutable d'installation qui installe
  l'application et ajoute des raccourcis. Recommandé pour la plupart des
  utilisateurs Windows.
- **Version portable Windows.** Un dossier autonome qui fonctionne sans rien
  installer. Elle conserve toutes les données dans son propre répertoire,
  vous pouvez donc l'emporter sur une clé USB.
- **Package macOS.** Un bundle `.app` standard. Glissez-le dans Applications
  et lancez-le depuis là.
- **AppImage et archive Linux.** L'AppImage fonctionne sur la plupart des
  distributions desktop. L'archive est un simple dossier que vous pouvez
  placer n'importe où et lancer d'un double clic.

Les quatre cibles sont fonctionnellement identiques. Choisissez celle qui
correspond à la façon dont vous gérez les logiciels sur votre machine.

## Exigences Système

- Un OS desktop 64 bits : Windows 10 ou plus récent, macOS, ou une
  distribution Linux grand public.
- Assez de mémoire et d'espace disque pour votre bibliothèque. Le backend au
  repos utilise environ 180 Mo de RAM sur une machine de référence, et
  l'application atteint une interface prête en environ quatre secondes sur
  cette même machine.
- Aucune installation séparée de Node.js, Python, SQLite ou navigateur. Tout
  ce dont l'application a besoin est embarqué.

## Ce Qui Est Embarqué

La distribution intègre Node.js 24 LTS et SQLite, et la coquille desktop
exécute le backend local comme un processus sidecar intégré. Cela signifie
que :

- Le premier lancement n'exécute jamais `npm install` et ne nécessite jamais
  de terminal.
- Le backend n'écoute que sur `127.0.0.1`. L'accès LAN ou distant n'est
  jamais activé silencieusement ; il exige une adhésion explicite.
- Fermer la fenêtre de l'application arrête proprement le sidecar, donc aucun
  processus backend n'est laissé derrière.

## Après l'Installation

Le premier lancement crée votre répertoire de données, prépare une petite
bibliothèque de démarrage et ouvre l'écran d'accueil. Consultez
[Démarrage rapide](quick-start) pour les étapes suivantes.

Si quelque chose se passe mal pendant l'installation ou le premier lancement,
consultez [Dépannage](troubleshooting).
