---
title: Paramètres
description: >-
  Paramètres globaux et par conversation, profils de connexion,
  fournisseurs et clés API dans NeoTavern.
sidebar_position: 7
---

Cette page explique où vivent les paramètres dans NeoTavern et comment
configurer les fournisseurs, les profils de connexion et les clés API.

## Où Vivent les Paramètres

NeoTavern n'a pas de page de paramètres séparée. Tout s'ouvre comme un
panneau ou une fenêtre modale par-dessus l'espace de travail de chat, et la
fermer vous ramène exactement à la même conversation et au même brouillon :

- **Paramètres** (depuis la barre de navigation) regroupe les options
  applicatives dans des onglets : **Général** (langue, échelle du texte,
  écran de démarrage, style de message, forme d'avatar, accessibilité),
  **Thèmes** (installer et activer des thèmes) et **Données** (migration,
  sauvegardes, maintenance du cache, diagnostics).
- **Paramètres IA** est le panneau de contexte de la génération. Son onglet
  **Config** contient les paramètres de requête du modèle actif : taille du
  contexte, longueur de réponse, streaming, échantillonnage, pénalités,
  graine et raisonnement. L'onglet **API** gère les profils de connexion et
  les clés, et **Avancé** construit des modèles de chat et d'instructions
  personnalisés à partir de ChatML, Llama 3 ou Alpaca.

Les changements de paramètres s'appliquent immédiatement là où ils sont
facilement réversibles. Les options qui diffèrent de leurs valeurs par défaut
sont marquées et peuvent être réinitialisées individuellement, et la
recherche de paramètres couvre les noms, les descriptions et les mots-clés.

## Paramètres Globaux vs. Par Conversation

Les paramètres globaux dans **Paramètres** s'appliquent à toute
l'application : langue, thème, gestion des données et valeurs par défaut. Le
comportement par conversation vit à côté de la conversation : les paramètres
de génération, le fournisseur et le modèle actifs et la stratégie de contexte
se modifient dans le panneau Paramètres IA pendant que la conversation reste
ouverte, et les brouillons et la position de défilement sont conservés. Le
persona est aussi par conversation — chaque échange peut utiliser un persona
différent tandis que le persona actif global reste la valeur par défaut.

## Fournisseurs et Profils de Connexion

Un profil de connexion regroupe tout ce qui est nécessaire pour parler à un
fournisseur : le type et la source d'API, l'URL de base le cas échéant, la
clé API sélectionnée et le modèle. L'onglet **API** des Paramètres IA (et la
section Fournisseurs) vous permet de :

1. Choisir l'API de premier niveau (Chat Completions ou Text Completions).
2. Choisir une source, qui filtre les sources de cette API et devient le nom
   du profil.
3. Saisir l'URL de base pour les serveurs compatibles OpenAI, se terminant
   généralement par `/v1`.
4. Choisir ou saisir un ID de modèle, en chargeant éventuellement d'abord la
   liste des modèles.
5. **Tester la connexion** pour vérifier la disponibilité et la latence, puis
   **Connecter** pour activer le profil.

## Clés API

Les clés sont stockées localement dans un gestionnaire de clés qui contient
plusieurs clés nommées par fournisseur, avec une seule active à la fois. Les
secrets sont vérifiés avant l'enregistrement et ne sont plus jamais affichés
en entier ensuite — seul un suffixe masqué reste visible. Les exports et les
diagnostics excluent les secrets par défaut, et les erreurs de fournisseur
sont affichées sous forme de messages localisés avec des détails techniques
et un ID de trace dans un bloc repliable.

Consultez [Thèmes](themes), [Extensions](extensions) et
[Données et sauvegardes](data-and-backups) pour le reste des paramètres
globaux.
