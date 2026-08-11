---
title: Sidecar Node
description: Le backend Fastify comme sidecar Node.js intégré, du démarrage à l'arrêt propre.
sidebar_position: 3
---

Le backend de NeoTavern est un serveur Fastify, et dans l'application de
bureau il s'exécute comme un sidecar Node.js intégré : un binaire Node.js 24
autonome empaqueté à côté du shell.

## Pourquoi un Sidecar

Empaqueter le backend comme un processus séparé garde le shell mince et le
backend réel :

- Le backend est la même application Fastify 5 qu'une installation
  auto-hébergée exécute, donc le comportement desktop et serveur reste
  identique.
- Node.js et SQLite sont compilés dans la distribution, c'est pourquoi le
  premier lancement n'a besoin d'aucun `npm install` ni d'aucun terminal.
- Une frontière de processus signifie qu'un crash ou un blocage dans le
  backend ne peut pas abattre la boucle d'événements du shell, et le shell
  peut appliquer les garanties de cycle de vie.

## Démarrage

Au lancement, le shell génère l'exécutable sidecar et attend la disponibilité
avant d'ouvrir la webview. Le backend :

- n'écoute que sur un port libre aléatoire sur `127.0.0.1` ;
- crée la base de données SQLite et exécute les migrations de schéma en
  attente dans le répertoire de données, en prenant une sauvegarde avant les
  migrations en attente ;
- sert les ressources web de production et l'API.

Le premier lancement est entièrement automatique : répertoire de données,
base de données, thèmes intégrés et le personnage de démarrage sont
configurés sans aucune interaction utilisateur.

## Arrêt Propre

L'arrêt est coopératif et ordonné :

1. Le shell reçoit l'événement de fermeture et dit au backend de s'arrêter.
2. Le backend cesse d'accepter de nouvelles connexions, termine le travail en
   cours dans son délai et ferme proprement la base de données.
3. Le sidecar sort et le shell sort.

Une terminaison inattendue du backend est détectée par le shell et signalée
comme une sortie d'erreur, jamais laissée à orpheliner silencieusement un
processus backend. L'application ne laisse donc jamais un processus
`neotavern-server` errant derrière après la fermeture de la fenêtre.

## Empaquetage et Vérification

Le sidecar est construit par plateforme cible. Les addons natifs
(`better-sqlite3`, Sharp) et les ressources web de production sont préparés
sur le même runner cible et empaquetés avec l'exécutable ; déplacer des
ressources préparées entre systèmes d'exploitation n'est pas pris en charge.
Une porte de fumée exécute le sidecar empaqueté sans tête sur chaque
plateforme dans le CI, vérifiant le vrai exécutable Node, SQLite, Sharp, la
SPA empaquetée, les diagnostics et l'absence de processus restants.

## Variante Portable

La version portable Windows exécute la même disposition de sidecar :
l'exécutable principal, l'exécutable sidecar, un marqueur `portable.flag` et
un dossier `resources/`. Le drapeau bascule la racine de données vers un
dossier local `data/` à côté de l'application. Le shell normalise les
chemins de ressources Windows avant de les remettre au binaire Node
empaqueté.

Pour les formats et l'expérience au premier lancement, consultez
[Packaging](packaging.md) ; pour le shell qui gère ce processus, consultez
[Shell Tauri](tauri-shell.md).
