---
title: Bac à sable des plugins
description: >-
  Le modèle de sécurité du code de plugin non fiable : isolation des
  processus et mode sans échec.
sidebar_position: 7
---

Le code de plugin non fiable est isolé à chaque couche : le backend s'exécute
dans un processus restreint séparé, le frontend s'exécute dans un iframe en
bac à sable, et les thèmes ne reçoivent jamais d'accès sensible du tout.

## Pas de Bac à Sable JavaScript

`node:vm` n'est délibérément pas utilisé comme bac à sable de sécurité. Un
bac à sable d'interpréteur JavaScript ne peut pas empêcher un attaquant
déterminé d'atteindre le processus hôte. À la place, l'isolation est imposée
par le système d'exploitation : des processus séparés avec des capacités
limitées, et des contextes de navigation séparés.

## Isolation Backend

Un plugin backend non fiable s'exécute dans son propre processus Node.js 24
avec des restrictions :

- Un chargeur limité ne résout que l'ESM local au package et l'API du SDK.
- Le processus ne peut pas importer de modules intégrés `node:*` au-delà de
  ce que le chargeur permet, résoudre des modules en dehors de la racine du
  package, ni atteindre la base de données de l'hôte.
- Toutes les capacités arrivent via un canal IPC ; l'hôte applique les
  permissions à chaque appel.
- Le processus n'écoute les événements centraux de l'application que via le
  bus d'événements du SDK, et ne peut émettre que sous son propre espace de
  noms.
- Si le processus plante, l'hôte retire chaque enregistrement qu'il
  possédait.

Le processus de plugin ne reçoit jamais la racine Fastify, la connexion
SQLite, les chemins absolus, l'environnement complet ni les clés API
d'autres fournisseurs. L'accès réseau est limité aux hôtes accordés via le
`fetch` vérifié par permissions.

## Isolation Frontend

Un plugin frontend natif s'exécute dans un iframe en bac à sable avec
`sandbox="allow-scripts"` et sans `allow-same-origin` :

- L'iframe n'a aucun accès de même origine au document de l'application.
- La communication avec l'hôte passe par un seul `MessagePort` transféré avec
  un nonce d'amorçage, des enveloppes structurées, des échéances et une
  annulation.
- L'hôte monte l'interface de chaque enregistrement dans une racine isolée à
  l'intérieur de l'iframe et communique via RPC, donc le plugin ne touche
  jamais l'arbre de composants React ni le DOM interne.
- Un crash d'interface de plugin n'abat que les racines et régions de rognage
  de ce plugin.

Chaque plugin possède un iframe de bac à sable pleine fenêtre ; l'hôte
regroupe les rectangles des montages actifs et rogne la zone visible et
interactive de l'iframe à leur union, donc les événements de pointeur en
dehors d'une surface de plugin restent à l'application.

## Mode Hérité de Confiance

Les entrées `legacy.frontend` et `legacy.backend` sont un mode de
compatibilité de confiance séparé pour les extensions SillyTavern existantes
— pas un contournement du bac à sable natif. Utiliser l'une ou l'autre
entrée exige la permission `legacy.trusted`, que l'interface affiche avec un
avertissement renforcé, et l'utilisateur doit la confirmer explicitement. Le
code frontend hérité s'exécute dans la fenêtre principale, et le code backend
hérité obtient un routeur Express limité à son propre espace de noms
`/api/plugins/{pluginId}`. Le mode sans échec ne charge pas du tout les
points d'entrée hérités.

## Thèmes

Les packages de thème sont encore plus restreints : un thème ne reçoit aucun
accès aux conversations, aux clés API ou au système de fichiers. Les thèmes
ne sont que du CSS et une mise en page déclarative — il n'y a pas de point
d'entrée JavaScript dans le Theme SDK. Consultez
[Mode sans échec du Theme SDK](../theme-sdk/safe-mode.md) pour l'histoire
côté thème.

## Mode Sans Échec

Le mode sans échec (`?safe=1` dans l'URL) désactive entièrement les plugins
et thèmes tiers. Il est géré avant que le code de plugin ou de thème ne se
charge : le CSS des packages et les remplacements de jetons ne sont pas
ajoutés au document, et les points d'entrée tiers ne s'exécutent jamais. Le
thème intégré et le runtime de plugin intégré restent, donc l'interface
récupère toujours. Quitter le mode sans échec restaure l'état de plugin et de
thème actif précédemment enregistré.

## Validation des Packages

Chaque package est validé avant que n'importe quel code ne puisse
s'exécuter : les traversées de chemins, liens symboliques, binaires natifs et
charges exécutables sont rejetés ; les champs de manifeste, points d'entrée
et permissions sont vérifiés ; les dépendances npm sont récupérées avec des
vérifications d'intégrité et les scripts d'installation ne sont jamais
exécutés. Pour l'histoire complète de l'installation au nettoyage,
consultez [Cycle de vie](lifecycle.md).
