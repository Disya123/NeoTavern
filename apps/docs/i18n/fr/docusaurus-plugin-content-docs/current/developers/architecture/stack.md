---
title: Pile technologique
description: >-
  La pile approuvée de NeoTavern : Node.js 24, Fastify 5, React 19, Vite 8,
  TypeScript strict, SQLite avec Drizzle et Tauri 2.
sidebar_position: 3
---

NeoTavern fonctionne sur une pile délibérément conventionnelle : Node.js 24
LTS, Fastify 5, React 19, Vite 8, TypeScript strict, SQLite avec Drizzle ORM
et un shell desktop Tauri 2.

## Runtime et Langage

- **Node.js 24 LTS** — le runtime du backend et du sidecar desktop embarqué.
  Le code reste compatible avec Node.js 22 quand c'est pratique.
- **TypeScript strict** — activé partout. Les `any` injustifiés, `as unknown
as`, `@ts-ignore` et les assertions non nulles sont interdits. Les
  frontières du système utilisent `unknown` et une validation explicite.
- **ESM uniquement** — toutes les applications et packages utilisent des
  modules ES.

## Backend

- **Fastify 5** — le framework d'API. Chaque module backend est un plugin
  Fastify isolé.
- **TypeBox + Fastify Type Provider** — chaque entrée et sortie d'API a un
  JSON Schema, généré depuis `@neotavern/contracts`.
- **SSE** — la génération en streaming s'exécute via Server-Sent Events.
  WebSocket est réservé aux canaux bidirectionnels réels.
- **AbortSignal** — chaque opération longue accepte un `AbortSignal` et
  expire proprement quand le client se déconnecte.

## Frontend

- **React 19** — une application à page unique, sans rendu côté serveur.
- **Vite 8** — le bundler et le serveur de développement. Vite est uniquement
  un outil de build, pas une API de plugins applicatifs.
- **React Router** — le routage, avec un espace de travail de chat unique et
  des surfaces système rendues par-dessus.
- **TanStack Query** — le seul store pour l'état du serveur.
- **Zustand** — uniquement l'état d'interface transitoire : le panneau actif,
  les préférences de thème et de langue, le personnage épinglé et des
  brouillons limités à la session.
- **Radix Primitives** — des composants headless accessibles enveloppés par
  `@neotavern/ui`.

## Données

- **SQLite via better-sqlite3** — le fichier de base de données unique, ouvert
  avec WAL, `foreign_keys = ON`, `busy_timeout` et des déclarations
  préparées.
- **Drizzle ORM** — schéma typé, dépôts et migrations.
- **FTS5** — recherche plein texte sur les personnages, conversations et
  messages.

## Style

- **CSS Modules + propriétés personnalisées + couches en cascade + requêtes
  de conteneur** — la boîte à outils de style. Les thèmes remplacent les
  design tokens et les règles de couche sans lutter contre la spécificité.

## Templating et Localisation

- **Handlebars** — les modèles de format d'instruction, rendus dans un
  environnement en bac à sable sans accès au système de fichiers ni à
  l'exécution de code.
- **i18next** — toutes les chaînes visibles par l'utilisateur, avec des
  espaces de noms et des ressources par locale.

## Desktop

- **Tauri 2** — le shell desktop, avec le serveur Node.js livré comme binaire
  sidecar autonome.
- **tauri-plugin-shell et tauri-plugin-updater** — gestion des processus et
  mises à jour signées.

## Outillage

- **Espaces de travail pnpm** — le gestionnaire de packages du monorepo.
- **Vitest** — tests unitaires et d'intégration.
- **Playwright** — tests de bout en bout, y compris les tests de fumée du
  shell desktop.

## Ce Qui Est Délibérément Absent

- Pas de PostgreSQL, Redis, Docker ni aucun autre service que vous devez
  installer ou exécuter.
- Pas de SSR ni de serveur Node pour le frontend au-delà du processus d'API.
- Pas de `node:vm` comme bac à sable de sécurité pour les plugins — les
  plugins backend non fiables s'exécutent dans un processus restreint séparé
  à la place.

Consultez [Vue d'ensemble du monorepo](overview) pour voir comment les pièces
s'assemblent et [Packages](packages) pour savoir qui possède quoi.
