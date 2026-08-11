---
title: Démarrage rapide
description: >-
  Connectez un fournisseur, choisissez un personnage et envoyez votre
  premier message dans NeoTavern.
sidebar_position: 3
---

Cette page vous fait passer d'une installation fraîche à votre premier
message généré en environ cinq minutes. Vous avez besoin d'un fournisseur
actif ; tout le reste est facultatif.

## 1. Lancez l'Application

Ouvrez NeoTavern. L'écran d'accueil s'ouvre directement, et le premier
lancement affiche une liste de contrôle non bloquante où vous choisissez
votre langue et l'échelle du texte. Vous pouvez ignorer la liste de contrôle
et y revenir plus tard — rien ici ne bloque la galerie de personnages, les
imports ou les paramètres locaux.

## 2. Connectez un Fournisseur

La génération a besoin d'un fournisseur : un serveur de modèle local sur
votre machine ou une API distante. Ouvrez le panneau Paramètres IA ou la
section Fournisseurs :

1. Choisissez un type d'API (par exemple Chat Completions) et une source, qui
   définit le fournisseur.
2. Saisissez votre clé API. Les clés sont stockées localement, jamais
   affichées en entier après l'enregistrement et jamais incluses dans les
   exports par défaut.
3. Chargez éventuellement la liste des modèles de ce fournisseur et choisissez
   un modèle.
4. Utilisez **Tester la connexion** pour vérifier la disponibilité et la
   latence, puis **Connecter** pour activer le profil.

Pas encore de fournisseur ? Sélectionnez le fournisseur **Echo** intégré pour
tester tout le pipeline hors ligne. Echo répond avec un écho codé et ne
nécessite ni clé ni accès réseau.

Tant qu'aucun fournisseur n'est actif, le bouton Envoyer est désactivé et
l'application explique pourquoi à côté. Les erreurs de fournisseur ne vous
verrouillent jamais votre bibliothèque locale.

## 3. Choisissez ou Créez un Personnage

Ouvrez la section Personnages depuis la barre de navigation :

- Parcourez la galerie et ouvrez une fiche pour commencer à discuter.
- Importez une fiche de personnage (PNG ou JSON) depuis le disque.
- Créez un nouveau personnage de zéro — seul un nom est requis.

Consultez [Personnages](../user-guide/characters) pour tous les détails.

## 4. Envoyez Votre Premier Message

Avec un personnage sélectionné, la zone de discussion s'ouvre avec le message
d'accueil du personnage comme premier message de l'assistant. Saisissez le
texte ci-dessous et appuyez sur `Entrée` pour envoyer. La conversation n'est
créée sur le backend qu'après l'envoi d'un premier message non vide, donc
naviguer ne laisse jamais de conversations vides derrière.

La réponse arrive en streaming au fur et à mesure de sa génération. Vous
pouvez l'arrêter à tout moment ou remonter dans l'historique pendant qu'elle
défile. Consultez [Discussion](../user-guide/chat) pour tout ce que la vue de
chat peut faire.

## Étapes Suivantes

- [Dépannage](troubleshooting) si le backend ne démarre pas ou si un port est
  déjà utilisé.
- [Paramètres](../user-guide/settings) pour régler les paramètres de
  génération et les profils de connexion.
- [Données et sauvegardes](../user-guide/data-and-backups) pour importer une
  sauvegarde SillyTavern existante ou créer la vôtre.
