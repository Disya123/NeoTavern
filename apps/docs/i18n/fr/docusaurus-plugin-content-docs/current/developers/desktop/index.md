---
title: Vue d'ensemble du desktop
description: >-
  Comment l'application de bureau est livrée — un shell Tauri 2 avec un
  sidecar Node.js intégré.
sidebar_position: 1
---

L'application de bureau est une distribution native de NeoTavern : un shell
Tauri 2 qui exécute le backend Fastify comme un sidecar Node.js intégré.

## Une Application, Aucune Configuration

La distribution desktop est autonome. Node.js, SQLite et les ressources web
de production sont embarqués dans le package, donc le premier lancement ne
nécessite ni terminal, ni Git, ni npm, ni configuration manuelle de base de
données. Vous installez l'application, vous la lancez, et la webview s'ouvre
une fois l'API locale prête.

Les pièces de runtime sont :

- **Shell Tauri 2** — la fenêtre native et le cycle de vie de l'application.
- **Sidecar Node.js** — un binaire Node.js 24 autonome qui exécute le
  backend Fastify localement sur `127.0.0.1`.
- **SQLite** — la base de données locale, créée automatiquement dans le
  répertoire de données au premier lancement.

## Formats Pris en Charge

Le build desktop cible les formats que la plupart des utilisateurs attendent :

- Installeur Windows (NSIS et MSI).
- Version portable Windows (un ZIP avec un drapeau portable).
- Package macOS (`.app`, plus DMG).
- AppImage Linux et une archive.

Chaque format est produit sur son runner de plateforme native, car la
distribution embarque des addons natifs comme `better-sqlite3` et Sharp.
Consultez [Packaging](packaging.md) pour les détails des formats et le
comportement au premier lancement.

## Garanties de Cycle de Vie

Le shell et le sidecar sont une seule unité. Fermer la fenêtre arrête le
backend — l'application ne laisse jamais de processus Node.js orphelin
derrière. Une sortie inattendue du backend termine le shell avec une erreur
au lieu d'une fenêtre silencieusement cassée. Consultez
[Shell Tauri](tauri-shell.md) et [Sidecar Node](node-sidecar.md) pour les
mécanismes.

## Emplacement des Données

Les builds installés stockent les données utilisateur dans le répertoire
de données locales de l'application de la plateforme, jamais à l'intérieur
du bundle. La version portable est l'exception : avec le drapeau portable
présent, les données vivent dans un dossier local `data/` à côté de
l'application. La gestion des données elle-même est couverte dans la section
[Données et stockage](../data/index.md).

## Étapes Suivantes

- [Shell Tauri](tauri-shell.md) — la fenêtre native et son cycle de vie.
- [Sidecar Node](node-sidecar.md) — le processus backend intégré.
- [Packaging](packaging.md) — formats de distribution et premier lancement.
