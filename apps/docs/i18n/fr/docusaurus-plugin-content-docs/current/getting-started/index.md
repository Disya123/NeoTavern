---
title: Qu'est-ce que NeoTavern
description: Une introduction à NeoTavern, une plateforme locale-first de chat et de roleplay IA.
sidebar_position: 1
---

NeoTavern est une plateforme locale-first de chat et de roleplay IA qui
fonctionne sur votre propre ordinateur. Vous créez ou importez des
personnages, vous leur parlez via n'importe quel modèle IA que vous
connectez, et vous conservez chaque message, fiche de personnage et paramètre
sur votre machine.

## Conçu Local-First par Défaut

- Vos données vivent dans un répertoire de données local sur votre ordinateur.
  Pas de compte, pas de synchronisation cloud obligatoire et pas de
  télémétrie par défaut.
- Vous pouvez parcourir votre bibliothèque, modifier des personnages et
  consulter les paramètres hors ligne. Seule la génération a besoin d'un
  fournisseur accessible.
- Avant que quoi que ce soit ne soit envoyé à un service IA externe pour la
  première fois, l'application vous montre exactement quel fournisseur
  recevra la requête.

## Comment Ça Fonctionne

- L'application de bureau est disponible pour Windows, macOS et Linux. Elle
  embarque Node.js et SQLite, vous n'installez donc jamais de runtime
  vous-même.
- L'application démarre son propre backend local, un sidecar Node.js intégré
  qui écoute sur `127.0.0.1:8000` par défaut et s'arrête avec la fenêtre.
- Une PWA réactive permet aux téléphones et tablettes de se connecter à un
  backend qui fonctionne sur votre PC ou votre serveur domestique.

## Ce Dont Vous Avez Besoin

- Un OS desktop 64 bits pris en charge. Aucun terminal, Git ou gestionnaire
  de paquets n'est requis à aucun moment.
- Un fournisseur pour générer les réponses : un serveur de modèle local ou
  une API distante avec votre clé. Le fournisseur Echo intégré vous permet de
  vérifier tout le flux hors ligne, sans aucun service externe.
- Facultatif mais utile : une sauvegarde de données SillyTavern existante
  pour migrer vos personnages, conversations, lorebooks et personas.

## Où Aller Ensuite

- [Installation](getting-started/installation) — télécharger et configurer l'application sur
  votre OS.
- [Démarrage rapide](getting-started/quick-start) — connecter un fournisseur et envoyer votre
  premier message.
- [Mise à jour](getting-started/upgrading) — comment fonctionnent les mises à jour et
  pourquoi vos données restent en sécurité.
- [Dépannage](getting-started/troubleshooting) — solutions aux problèmes courants
  d'installation et d'exécution.
- [Guide utilisateur](user-guide/) — pages détaillées sur le chat, les
  personnages, les lorebooks, la mémoire, les thèmes et les plugins.
- [FAQ](faq) — réponses courtes aux questions fréquentes.
