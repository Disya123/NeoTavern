---
title: Cycle de vie des plugins
description: >-
  Comment les plugins passent de l'installation au consentement, à
  l'activation et au nettoyage.
sidebar_position: 6
---

Un plugin traverse un cycle de vie défini : installation, consentement,
activation, actif, et enfin nettoyage. Chaque transition est imposée par
l'hôte.

## Installation

L'installation se fait via le gestionnaire de plugins. Vous pouvez installer
une archive ZIP `.stplugin` bornée ou un lien de dépôt public (`github.com`
ou `gitlab.com`, HTTPS uniquement). L'hôte n'invoque jamais le binaire git ;
il télécharge une archive de dépôt et la fait passer par exactement la même
validation qu'un ZIP : traversée de chemins, liens symboliques, charges
exécutables, tailles, champs de manifeste, points d'entrée et permissions.
L'installation est atomique et revient en arrière en cas d'erreur.

Si le package livre un `package.json` avec des dépendances, le résolveur
intégré les récupère depuis le registre npm sans exécuter les scripts
d'installation. Empaquetez vos dépendances quand c'est possible ; le
résolveur existe pour les bibliothèques WASM lourdes qui ne peuvent pas
raisonnablement être empaquetées.

## Consentement

Après la validation, le plugin entre dans un état `needs-consent`. Il y reste
jusqu'à ce que l'utilisateur confirme chaque permission demandée (et examine
la liste des dépendances npm quand elle existe). Aucun point d'entrée ne
s'exécute pendant cette phase. Consultez [Permissions](permissions.md) pour
le modèle complet.

## Activation

L'activation est une opération en deux phases :

1. Les enregistrements backend et hérités démarrent d'abord.
2. L'entrée frontend se charge et reçoit son API.

Si l'activation échoue en cours de route, l'hôte annule les enregistrements
partiels et enregistre un échec de chargement. Une activation échouée ne
laisse jamais de surfaces à moitié enregistrées derrière.

## Runtime Actif

Pendant qu'il est actif, chaque enregistrement que fait le plugin — surfaces
d'interface, routes, abonnements d'événements, ressources i18n,
notifications, fournisseurs, tokeniseurs, stratégies de contexte et
post-processeurs — est collecté par le runtime. Le plugin peut aussi gérer
ses propres ressources dans `deactivate()`.

## Nettoyage

La désactivation, le mode sans échec, la suppression, un crash ou l'arrêt de
l'application déclenchent tous un nettoyage imposé par l'hôte. Le runtime
élimine les enregistrements collectés dans l'ordre inverse, et les garanties
sont strictes : après la désactivation d'un plugin, il ne reste rien.

- Aucun handler ni abonnement d'événements.
- Aucune minuterie.
- Aucun nœud DOM.
- Aucune route montée.
- Aucune requête en arrière-plan.
- Aucun fournisseur, tokeniseur ou stratégie enregistré.

Une erreur lancée par le propre `deactivate()` du plugin n'annule pas le
nettoyage requis — l'hôte élimine toujours tout ce qu'il suit. Le nettoyage
est idempotent : l'appeler deux fois n'a aucun effet.

## Mise à Jour

La mise à jour remplace le package atomiquement et conserve l'état
d'activation actuel, avec une exception : si le nouveau manifeste ajoute des
permissions, le runtime est désactivé immédiatement et reste désactivé
jusqu'à ce que l'utilisateur consente aux nouvelles permissions. Revenir à
une version précédente se fait en réinstallant cette version ; les données
utilisateur du stockage de plugins survivent dans les deux sens.

## Gestion des Crashes

Un plugin backend s'exécute dans son propre processus. Si ce processus
plante, l'hôte retire tous les enregistrements du plugin et signale l'échec.
Un plugin crashé ne peut pas laisser de routes orphelines ni d'abonnements
d'événements, car ils appartiennent à l'hôte, pas au processus.

Pour le modèle de sécurité qui rend ces garanties possibles, consultez
[Bac à sable](sandboxing.md). Pour les champs de manifeste qui pilotent le
cycle de vie, consultez [Manifeste](manifest.md).
