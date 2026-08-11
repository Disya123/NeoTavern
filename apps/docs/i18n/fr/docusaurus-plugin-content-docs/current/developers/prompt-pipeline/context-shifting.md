---
title: Décalage de contexte
description: >-
  Comment le pipeline ajuste le contexte assemblé au budget de jetons, les
  étapes pré-requête et les stratégies truncate, summarize, vector-recall et
  manual.
sidebar_position: 5
---

Le décalage de contexte ajuste la conversation assemblée au budget de jetons
du modèle en retirant ou compressant le contexte le moins important tout en
conservant tout ce qui doit rester.

## Étapes Pré-Requête

Avant qu'une requête ne soit envoyée, le pipeline suit ces étapes :

1. Déterminer le profil de tokeniseur et la limite de contexte du modèle.
2. Réserver l'espace pour la réponse.
3. Conserver le prompt système, le personnage, les entrées de lorebook
   requises et les messages épinglés.
4. Retirer ou compresser d'abord les blocs non épinglés les plus anciens.
5. Retirer les messages d'appel d'outil et de résultat d'outil uniquement en
   paire.
6. Recompter les jetons après chaque changement.
7. Montrer à l'utilisateur ce qui a été exclu ou résumé.

Si le contexte protégé seul dépasse le budget, la génération se termine avec
l'erreur stable `TOKEN_BUDGET_EXCEEDED` au lieu d'envoyer une requête
au-dessus du budget au fournisseur.

## Comment Fonctionne le Décalage

`shiftContext(messages, countTokens, budget)` ajuste le dialogue au budget de
jetons. Il renvoie trois listes :

- `kept` — les messages qui tiennent ;
- `excluded` — les messages retirés, montrés à l'utilisateur ;
- `truncated` — les blocs qui ont été compressés plutôt que supprimés.

Les messages système et les messages épinglés sont toujours protégés. Les
blocs non épinglés les plus anciens sont retirés en premier. Les appels
d'outil et leurs résultats sont liés via `toolCallId`, `tool_call_id` ou
`callId` et retirés comme un seul groupe, même quand ils ne sont pas
adjacents.

## Stratégies Intégrées

La stratégie est sélectionnée par le paramètre `contextStrategy` et appliquée
via le `ContextStrategyRegistry` :

- **truncate** — retire les groupes non épinglés les plus anciens.
- **summarize** — construit un résumé extractif local de l'historique exclu
  et le conserve avant l'entrée utilisateur actuelle.
- **vector-recall** — supprime les blocs de lorebook et de mémoire à faible
  pertinence avant ceux à haute pertinence, puis raccourcit l'historique
  ancien.
- **manual** — exclut d'abord les messages marqués `meta.manualExcluded:
true` (y compris leurs paires appel d'outil/résultat d'outil), puis continue
  avec la réduction normale si plus d'espace est nécessaire.

## Plugins et Budget

Les plugins peuvent enregistrer des stratégies supplémentaires ;
l'enregistrement renvoie une fonction de nettoyage. Une stratégie de plugin
ne peut pas contourner le budget :

- l'hôte restaure les messages requis et rejette une stratégie qui a retiré
  du contexte protégé ;
- l'hôte recompte indépendamment le budget réel ;
- le comptage et le décalage s'exécutent avant les intercepteurs de plugins,
  et un re-comptage obligatoire avec un décalage final s'exécute après eux —
  un plugin ne peut pas ajouter de messages tardivement pour passer la limite
  en douce.

## L'Audit de Contexte

Chaque génération crée un `PromptContextAudit` avant l'appel réseau et le
termine avec un statut terminal : `completed`, `failed` ou `cancelled`.
L'audit enregistre :

- l'ID de génération, le fournisseur et le modèle ;
- chaque bloc de prompt dans l'ordre réel, avec les comptes de jetons et la
  raison stable d'inclusion ou d'exclusion ;
- la limite de contexte, la réserve de réponse et le compte final de jetons
  de prompt ;
- le profil de tokeniseur et s'il est approximatif ;
- les messages finaux du fournisseur et les diagnostics des intercepteurs de
  plugins ;
- un code d'erreur de fournisseur normalisé, sans les corps de réponse
  amont.

Seul le dernier audit complet par conversation est conservé dans la base de
données ; une nouvelle requête remplace atomiquement l'ancienne, et supprimer
la conversation supprime l'audit. L'interface le lit via
`GET /api/v2/chats/:id/context-audit`.

Un endpoint d'aperçu en direct, `POST /api/v2/context-preview`, exécute les
mêmes étapes de persona, lorebook, mémoire, modèle, tokeniseur et décalage
sans créer de messages, de branches ni d'audits.

## Voir Aussi

- [Étapes du pipeline](stages) pour savoir où le décalage se situe dans
  l'ordre des étapes.
- [Tokenisation](tokenization) pour savoir comment les jetons sont comptés.
- [Données et stockage](../data/) pour savoir où les audits sont stockés.
