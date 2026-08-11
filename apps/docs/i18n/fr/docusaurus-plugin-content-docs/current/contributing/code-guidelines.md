---
title: Règles de code
description: Les règles que chaque contribution de code NeoTavern doit suivre
sidebar_position: 3
---

Les contributions de code NeoTavern suivent un ensemble partagé de règles :
TypeScript strict, un contrat d'erreurs explicite, la documentation comme
partie du changement et des cibles de performance mesurables.

## TypeScript

- Le mode strict est activé pour tout le code ; gardez-le activé.
- Les `any` injustifiés, `@ts-ignore`, les assertions non nulles et les
  casts `as unknown as` sont interdits.
- Aux frontières du système — analyse, requêtes, fichiers, entrée de plugin —
  utilisez `unknown` et validez explicitement avant de faire confiance aux
  données.
- Les interfaces publiques exposent des types exportés. Ne dupliquez jamais à
  la main les types backend et frontend : les types d'API partagés vivent
  dans `packages/contracts` et sont importés de là.
- Utilisez ESM partout.
- Préférez les petites fonctions avec des entrées et sorties explicites aux
  grandes fonctions avec état.

## Erreurs d'API

Chaque erreur d'API utilise une enveloppe stable et lisible par machine :

```json
{
  "code": "CHARACTER_NOT_FOUND",
  "params": { "characterId": "0193..." },
  "traceId": "01J4..."
}
```

- `code` est un identifiant d'erreur stable et lisible par machine — ne le
  changez pas une fois publié.
- `params` porte un contexte structuré sur lequel un client ou un plugin peut
  agir.
- `traceId` corrèle l'erreur avec les logs du serveur.
- Le texte orienté utilisateur n'est jamais composé sur le backend : le
  frontend localise le code et les params en texte d'interface.

## La Documentation Fait Partie de l'Implémentation

La documentation fait partie de l'implémentation, pas une traîne qui vient
après le code. Tout changement qui affecte le comportement utilisateur ou
développeur met à jour les fichiers pertinents de `docs/` dans le même
changement. C'est obligatoire pour :

- l'architecture et les frontières de packages ;
- l'API REST, SSE, WebSocket et les schémas de contrats ;
- le Plugin SDK, le Theme SDK et la couche de compatibilité héritée ;
- les permissions, le bac à sable et le modèle de sécurité ;
- le schéma SQLite, les migrations, la sauvegarde et la restauration ;
- l'import, l'export, les fichiers et le cache de vignettes ;
- le pipeline de prompts, les formats d'instruction, la tokenisation et le
  décalage de contexte ;
- les adaptateurs de fournisseurs ;
- l'empaquetage desktop, le sidecar Tauri, la PWA et les mises à jour ;
- les paramètres utilisateur, i18n et l'accessibilité ;
- les changements cassants, les dépréciations et les guides de migration.

Règles supplémentaires :

- Chaque nouvelle `app` ou `package` livre un `README.md` couvrant le but,
  les points d'entrée publics, les dépendances, les commandes de dev et les
  contraintes.
- Les exports TypeScript publics et les points d'extension du SDK reçoivent
  du TSDoc quand le nom seul n'explique pas le contrat.
- Les changements visibles par l'utilisateur sont ajoutés à `CHANGELOG.md` ;
  les changements cassants reçoivent aussi un guide de migration.
- Ne documentez pas les fonctionnalités non implémentées comme prêtes —
  marquez-les « expérimental » ou « prévu ».
- Gardez une source de vérité par contrat et liez-y ; ne copiez pas le même
  contrat à plusieurs endroits.

## i18n

- Pas de chaînes codées en dur visibles par l'utilisateur dans le code
  d'interface. Toutes les chaînes passent par les espaces de noms i18next.
- Formatez les pluriels, dates, nombres et unités avec `Intl`, pas par
  concaténation de chaînes.
- Les changements de langue sans rechargement de page ; mettez à jour `lang`
  et `dir` sur `<html>`.
- Prenez en charge les mises en page RTL.
- Les plugins et thèmes utilisent des espaces de noms isolés pour ne pas
  entrer en collision avec l'application.
- Le backend renvoie des codes d'erreur ; le frontend les localise.
- Ajoutez des vérifications de pseudo-locale pour les nouveaux écrans et
  vérifiez les interfaces avec des traductions longues.

## Cibles de Performance

Ne régresserez pas ces cibles sans une décision explicite :

| Cible                                                         | Budget         |
| ------------------------------------------------------------- | -------------- |
| Démarrage à interface prête (PC de référence)                 | 4 s            |
| Mémoire backend au repos                                      | 180 Mo         |
| Première page de 100 000 personnages                          | 300 ms         |
| Ouvrir un chat de 10 000 messages jusqu'aux derniers messages | 700 ms         |
| Mises à jour d'interface en streaming                         | 30 par seconde |
| Bundle frontend initial (gzip, avant les chunks paresseux)    | 2 Mo           |

Mesurez avant et après l'optimisation. N'ajoutez pas de cache sans stratégie
d'invalidation.

## Tests

Chaque changement ajoute un test au niveau approprié : tests unitaires
Vitest, tests d'intégration Fastify `inject()`, tests de bout en bout
Playwright, régression visuelle pour les thèmes et mises en page de shell,
tests d'accessibilité, tests de migration, tests de contrat de plugins et la
suite de compatibilité héritée. Couvrez les entrées d'erreur et corrompues,
l'annulation de requêtes, la ré-importation, les migrations et le retour en
arrière, la restauration de sauvegarde, le nettoyage de cache, la
désactivation de plugin, le mode sans échec, les grands catalogues et les
longues conversations, le décalage de contexte à la frontière du budget de
jetons, le rendu de format d'instruction et la génération et l'invalidation
de vignettes.

## Définition de Terminé

Avant de pousser : `pnpm format`, `pnpm lint` avec zéro avertissement,
`pnpm typecheck`, `pnpm test`, et `pnpm test:e2e` pour les changements
d'interface. Confirmez que les docs, exemples et guides de migration associés
sont mis à jour et que les liens de documentation se résolvent.
