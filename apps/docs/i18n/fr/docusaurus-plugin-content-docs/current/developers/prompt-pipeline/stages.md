---
title: Étapes du pipeline
description: >-
  Les 14 étapes fixes du pipeline de prompts et les règles que suit chaque
  hook de plugin : priorité, délai, annulation, permissions et isolation.
sidebar_position: 2
---

La génération passe par 14 étapes fixes, de l'entrée utilisateur à
l'enregistrement du message, et chaque hook de plugin suit les mêmes règles
de priorité, délai, annulation, permissions et isolation des erreurs.

## L'Ordre des Étapes

L'ordre est fixe et identique pour chaque génération :

```text
Entrée utilisateur
→ Macros
→ Données personnage/persona
→ Lorebook
→ Mémoire/RAG
→ Comptage de jetons
→ Décalage de contexte
→ Intercepteurs de plugins
→ Rendu du format d'instruction
→ Sérialisation du fournisseur
→ Requête
→ Réponse en streaming
→ Hooks de post-traitement
→ Enregistrement du message
```

## Étape par Étape

1. **Entrée utilisateur** — le message brouillon et les options de génération
   de cette requête sont capturés.
2. **Macros** — `{{user}}`, `{{char}}` et les variables personnalisées sont
   résolues par `replaceMacros`. Les macros inconnues sont laissées telles
   quelles.
3. **Données personnage/persona** — les champs de la fiche de personnage et
   le persona actif sont assemblés dans le tableau de messages.
4. **Lorebook** — les entrées de lorebook correspondantes sont insérées selon
   leurs règles d'activation. Les entrées marquées requises sont protégées
   contre la suppression.
5. **Mémoire/RAG** — les blocs de mémoire et de rappel vectoriel sont
   récupérés et classés.
6. **Comptage de jetons** — le profil de tokeniseur local compte le contexte
   assemblé.
7. **Décalage de contexte** — le contexte est ajusté au budget de jetons.
   Consultez [Décalage de contexte](context-shifting).
8. **Intercepteurs de plugins** — les plugins peuvent inspecter et modifier
   le tableau de messages. Après le dernier intercepteur, le pipeline
   recompte les jetons et réapplique le budget, donc aucun plugin ne peut le
   contourner.
9. **Rendu du format d'instruction** — le tableau de messages propre est
   rendu dans le format d'instruction sélectionné, ou conservé structuré.
   Consultez [Formats d'instruction](instruct-formats).
10. **Sérialisation du fournisseur** — l'adaptateur construit la requête de
    fournisseur : les adaptateurs de chat reçoivent le tableau de messages
    structuré, les adaptateurs de texte la chaîne de prompt rendue.
11. **Requête** — la requête est envoyée avec un `AbortSignal`, des délais et
    une gestion de déconnexion client.
12. **Réponse en streaming** — la réponse est diffusée via SSE. Un
    `assistantPrefill` facultatif est préfixé exactement une fois au premier
    delta.
13. **Hooks de post-traitement** — les plugins peuvent traiter la réponse
    diffusée avant qu'elle ne soit enregistrée.
14. **Enregistrement du message** — le message final, ses variantes et les
    métadonnées de génération sont enregistrés dans une seule transaction.

## Règles des Hooks

Chaque hook de plugin est défini par le même contrat :

- **Ordre et priorité** — les hooks s'exécutent par ordre de priorité ; les
  priorités égales sont ordonnées de façon déterministe.
- **Délai** — chaque hook a un délai. Un hook qui le dépasse est abandonné.
- **Annulation** — les hooks reçoivent l'`AbortSignal` de la génération et
  doivent arrêter de travailler quand il se déclenche.
- **Permissions** — un hook ne s'exécute que si le plugin détient les
  permissions que ses capacités déclarées exigent.
- **Isolation des exceptions** — une erreur dans le hook d'un plugin est
  attrapée, journalisée et ignorée. Le pipeline continue ; un intercepteur
  cassé ne doit jamais casser silencieusement toute la génération.
- **Journal de diagnostic** — chaque changement de prompt est enregistré. Le
  journal des changements est renvoyé dans les diagnostics de génération et
  stocké dans le `meta` du message de réponse, donc vous pouvez toujours voir
  ce qui a réellement été envoyé.

## Post-Traitement du Prompt

En mode chat, le tableau de messages peut passer par une étape de
reconstruction facultative avant la sérialisation — le port de l'algorithme
classique `mergeMessages`. Les modes incluent `merge`, `semi`, `strict` et
`single`, plus des variantes `_tools` qui préservent les messages d'outils.
En mode texte cette étape est ignorée, car le rendu d'instruction a déjà
réduit les rôles en une seule chaîne.

## Voir Aussi

- [Décalage de contexte](context-shifting) pour savoir comment le budget est
  appliqué.
- [Tokenisation](tokenization) pour savoir comment fonctionne le comptage de
  jetons.
- Le [Plugin SDK](../plugin-sdk/) pour les API d'enregistrement des
  intercepteurs et du post-traitement.
