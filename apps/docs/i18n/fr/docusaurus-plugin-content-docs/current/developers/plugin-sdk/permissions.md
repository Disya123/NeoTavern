---
title: Permissions de plugin
description: >-
  Comment les permissions sont déclarées et accordées, et quand une mise
  à jour exige un nouveau consentement.
sidebar_position: 3
---

Les permissions sont le mécanisme qui permet aux utilisateurs de décider ce
qu'un plugin peut faire, de la lecture de l'historique de conversation aux
requêtes réseau.

## Le Modèle de Permissions

Une permission est une chaîne qui nomme une capacité. La déclarer dans le
manifeste est une demande, pas un accès automatique : l'utilisateur doit
confirmer chaque permission demandée avant que le plugin ne devienne actif,
et l'hôte applique l'octroi à chaque point d'utilisation.

L'ensemble intégré est un contrat stable et versionné :

| Permission           | Ce qu'elle accorde                                                          |
| -------------------- | --------------------------------------------------------------------------- |
| `chat.read`          | Lire les messages de conversation et leurs métadonnées                      |
| `chat.write`         | Créer ou modifier des messages de conversation                              |
| `characters.read`    | Lire les personnages et les fiches de personnage                            |
| `characters.write`   | Créer ou modifier des personnages                                           |
| `lorebook.read`      | Lire les entrées de lorebook                                                |
| `lorebook.write`     | Créer ou modifier des entrées de lorebook                                   |
| `prompt.inspect`     | Inspecter le prompt assemblé                                                |
| `prompt.modify`      | Modifier le prompt ou post-traiter la sortie de génération                  |
| `providers.register` | Enregistrer des adaptateurs et tokeniseurs de fournisseurs                  |
| `ui.toolbar`         | Ajouter des actions de barre d'outils                                       |
| `ui.sidebar`         | Ajouter des panneaux latéraux                                               |
| `ui.messageActions`  | Ajouter des actions de message                                              |
| `ui.shell`           | Ajouter du contenu aux emplacements du shell                                |
| `clipboard.read`     | Lire le presse-papiers                                                      |
| `clipboard.write`    | Écrire dans le presse-papiers                                               |
| `notifications`      | Afficher des notifications                                                  |
| `server.routes`      | Monter des routes backend                                                   |
| `legacy.trusted`     | Exécuter le code SillyTavern hérité documenté dans le contexte de confiance |

## Permissions Limitées

Certaines permissions portent une portée, écrite comme `kind:scope` :

- **`network:<hostname>`** — permission de récupérer depuis un hôte
  spécifique, par exemple `network:api.example.com`. Les requêtes vers des
  hôtes non accordés sont rejetées.
- **`network:*`** — un joker qui autorise la récupération depuis n'importe
  quel hôte. L'hôte le traite comme un accès réseau complet et l'interface de
  consentement l'affiche avec un avertissement renforcé. Préférez lister des
  hôtes concrets ; publier des plugins qui demandent le joker est
  découragé.
- **`files:plugin`** — lire et écrire dans le répertoire de données propre du
  plugin.
- **`files:user-selected`** — accès aux fichiers que l'utilisateur a
  explicitement sélectionnés.

`hasPermission` vérifie un ensemble accordé contre une permission requise, et
`parsePermission` divise une chaîne `kind:scope` en ses parties. La fonction
`validatePermissions` rejette les chaînes malformées comme les permissions
vides, en double ou inconnues.

## Comment les Octrois Sont Appliqués

Déclarer une permission ne suffit pas ; l'hôte applique l'octroi au point
d'application :

- Les enregistrements d'interface vérifient les permissions `ui.*` avant le
  montage.
- Les routes vérifient `server.routes`.
- Le `fetch` vérifié par permissions vérifie `network:<host>`.
- Le système de fichiers virtuel vérifie `files:*`.
- Les API de fournisseurs et de contexte vérifient `providers.register` et
  `prompt.modify`.

Le noyau de capacités (espace de noms `kernel` de `@neotavern/plugin-sdk`) est la
couche partagée qui vérifie les octrois à la fois dans l'hôte web et le
serveur, donc le navigateur et le backend voient toujours les mêmes droits
effectifs. Les octrois sont stockés avec une révision monotone, livrés au bac
à sable pendant la poignée de main d'amorçage et révocables au runtime. Les
opérations en cours se terminent avec une erreur `CAPABILITY_REVOKED` et les
handles ouverts sont fermés par l'hôte.

## Consentement et Re-Consentement à la Mise à Jour

L'installation affiche la liste complète des permissions demandées. Le plugin
reste dans un état `needs-consent` jusqu'à ce que vous confirmiez chaque
permission, et l'interface affiche la liste des dépendances quand le package
livre des dépendances npm.

Mettre à jour un plugin est une nouvelle installation pour la vérification
des permissions : l'hôte calcule la différence entre l'ancien et le nouveau
manifeste avec `diffPermissions`. Si la mise à jour ajoute des permissions :

- le runtime du plugin est désactivé immédiatement ;
- l'utilisateur est invité à consentir aux nouvelles permissions ;
- le plugin reste désactivé jusqu'à ce que le consentement soit donné.

Retirer des permissions ne nécessite jamais de consentement. La règle
générale : l'ensemble des permissions accordées ne grandit jamais sans une
décision utilisateur explicite. Pour la liste complète des constantes et
helpers de permissions, consultez la
[référence du Plugin SDK](../../api/plugin-sdk/) générée.
