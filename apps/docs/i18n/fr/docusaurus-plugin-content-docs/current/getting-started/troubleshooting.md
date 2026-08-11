---
title: Dépannage
description: Solutions aux problèmes courants d'installation et de démarrage de NeoTavern.
sidebar_position: 5
---

Cette page répond sous forme de questions-réponses aux problèmes courants
d'installation et d'exécution. Si votre problème n'est pas listé, collectez
les lignes de log pertinentes et ouvrez une issue sur le
[dépôt GitHub](https://github.com/Disya123/NeoTavern).

## Pourquoi l'Application Dit-elle que le Port est Déjà Utilisé ?

Le backend local écoute sur `127.0.0.1:8000` par défaut. Si un autre
programme occupe ce port, le sidecar ne peut pas démarrer. Fermez le
programme en conflit, ou lancez le serveur avec un autre port en définissant
`NEOTA_PORT` dans l'environnement. Le message d'erreur dans l'application
inclut le numéro du port et les détails dont vous avez besoin pour résoudre
le conflit.

## Le Sidecar Backend ne Démarre Pas

L'application de bureau exécute son backend comme un sidecar Node.js intégré.
S'il ne démarre pas, la fenêtre de l'application affiche une erreur de
connexion. Vérifiez les points suivants :

- Une autre instance de NeoTavern peut déjà fonctionner et occuper le port.
- Le répertoire de données peut ne pas être accessible en écriture à son
  emplacement actuel.
- Un antivirus ou un pare-feu peut bloquer le runtime Node intégré.

Redémarrez l'application après avoir traité la cause. Si l'application entre
dans une boucle de crash, elle propose un lancement en mode sans échec qui
désactive les plugins et thèmes tiers avant leur chargement — utilisez-le
pour récupérer.

## La Base de Données est Verrouillée

NeoTavern utilise SQLite avec le mode WAL et un délai d'attente de
verrouillage, donc les accès concurrents brefs sont attendus et gérés. Une
erreur persistante « database is locked » signifie généralement qu'une
seconde instance de l'application a ouvert le même répertoire de données, ou
qu'une opération de sauvegarde ou d'import est encore en cours. Fermez les
instances en double et attendez la fin des opérations longues avant de
réessayer.

## Comment Vider les Caches ?

Les caches vivent sous `data/cache/` et sont entièrement régénérables :
vignettes, données de tokeniseur et téléchargements de dépendances de
plugins. Vider un cache ne supprime jamais vos originaux, qui sont stockés
séparément sous `data/files/`. Utilisez les contrôles de maintenance dans
Paramètres → Données pour vider les caches et reconstruire l'index de
recherche plein texte. Les deux actions confirment le nombre et la taille de
ce qui sera supprimé avant de faire quoi que ce soit.

## Où Vivent les Logs ?

Les logs sont écrits dans `data/logs/server.log`, avec rotation à 10 Mo. Le
fichier de log est expurgé : les secrets, clés API et contenus de messages
utilisateurs ne sont jamais journalisés. La sortie console est conservée à
côté du fichier. Quand vous signalez un bug, incluez les lignes de log
pertinentes et l'ID de trace affiché dans les détails de l'erreur.

## Comment Revenir à une Interface Fonctionnelle ?

Utilisez le mode sans échec : il est accessible avant le chargement des
thèmes et plugins tiers et les désactive. Après un thème ou un plugin cassé,
le mode sans échec restaure l'interface intégrée sans modifier de fichiers à
la main. Consultez [Thèmes](../user-guide/themes) et
[Extensions](../user-guide/extensions) pour les détails.

## Pourquoi le Bouton Envoyer est-il Désactivé ?

Le bouton n'est désactivé que lorsqu'il y a une raison concrète, expliquée à
côté — le plus souvent aucun fournisseur actif ou aucun personnage
sélectionné. Connectez un fournisseur dans les Paramètres IA ou choisissez un
personnage, et le bouton devient disponible. Consultez
[Démarrage rapide](quick-start).
