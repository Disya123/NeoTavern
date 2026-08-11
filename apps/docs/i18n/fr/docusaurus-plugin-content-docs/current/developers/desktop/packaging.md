---
title: Packaging
description: >-
  Formats de distribution pour Windows, macOS et Linux, et l'expérience
  au premier lancement.
sidebar_position: 4
---

NeoTavern est distribué comme packages natifs par plateforme, chacun portant
le sidecar Node.js, SQLite, les addons natifs et les ressources web de
production.

## Formats de Distribution

Le build desktop produit :

- **Installeur Windows** — des installeurs NSIS et MSI avec un mode
  d'installation par utilisateur. L'installeur enregistre l'application et
  place les données utilisateur dans le répertoire de données locales de
  l'application de la plateforme.
- **Version portable Windows** — un ZIP contenant l'exécutable, le sidecar,
  un marqueur `portable.flag` et `resources/`, plus un fichier de somme de
  contrôle `.sha256`. Avec le drapeau présent, les données vivent dans un
  dossier local `data/` à côté de l'application au lieu du répertoire de
  données locales de l'application.
- **Package macOS** — un bundle `.app`, empaqueté dans un DMG sur le runner
  macOS.
- **Linux** — une AppImage et une archive.

Chaque format est construit et testé en fumée sur son propre runner de
plateforme native, car la distribution embarque des addons natifs. La copie
d'artefacts préparés entre plateformes n'est pas prise en charge.

## Ce Qui Est Embarqué

Chaque package contient tout ce dont l'application a besoin au runtime :

- Le shell Tauri 2.
- L'exécutable sidecar Node.js 24 autonome.
- SQLite via `better-sqlite3`.
- Sharp pour le traitement d'images.
- Les ressources web de production.

Comme Node.js, SQLite et les ressources sont dans le package, l'utilisateur
n'a besoin de rien d'installé au préalable — pas de Node.js, pas de npm, pas
de configuration de base de données.

## Premier Lancement

Le premier lancement est la promesse centrale du produit : ouvrez
l'application, et elle fonctionne.

1. Le shell démarre le sidecar.
2. Le backend crée le répertoire de données, initialise la base de données
   SQLite, exécute les migrations en attente (avec une sauvegarde avant les
   changements de schéma en attente), prépare les thèmes intégrés et le
   personnage de démarrage.
3. La webview s'ouvre sur l'application prête.

Il n'y a pas de terminal, pas d'assistant d'installation au-delà de celui de
la plateforme, pas de `npm install` et pas de configuration manuelle. Si
l'utilisateur a choisi un fond de conversation ou installé des plugins, rien
de tout cela ne vit dans l'exécutable — les données utilisateur sont séparées
du bundle, donc les mises à jour remplacent le cœur sans toucher aux fichiers
utilisateur.

## Mises à Jour

Les builds de release signent leurs artefacts et intègrent l'updater Tauri.
L'updater vérifie le manifeste et une signature minisign avant d'installer un
artefact de plateforme, puis redémarre le shell. Le retour en arrière
signifie publier le code précédemment examiné comme une nouvelle release
signée — les rétrogradations non signées ne sont pas autorisées. Les plugins
et thèmes se mettent à jour indépendamment via les gestionnaires de Plugins
et de Thèmes ; les fichiers utilisateur n'entrent jamais dans un artefact de
mise à jour exécutable.

## Construction

Depuis le dépôt, les commandes d'empaquetage sont :

```bash
pnpm desktop:prepare
pnpm desktop:build
pnpm desktop:portable
pnpm desktop:release
```

`desktop:prepare` construit le serveur et le web, copie les addons natifs
spécifiques à la cible et crée le sidecar avec le suffixe triple-cible Tauri.
`desktop:portable` construit en plus les installeurs NSIS/MSI et le ZIP
portable avec somme de contrôle, puis exécute un test de fumée de shell sans
tête. `desktop:release` produit des artefacts de mise à jour signés et exige
les secrets de release. Construire les installeurs nécessite Rust stable MSVC,
les outils de build C++ Windows et WebView2 sur la machine de build — aucun
de ces éléments n'est nécessaire aux utilisateurs finaux.
