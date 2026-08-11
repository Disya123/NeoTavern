---
title: Lorebooks
description: >-
  Ce que sont les lorebooks, comment les entrées s'activent et comment
  les lier aux personnages.
sidebar_position: 5
---

Cette page explique les lorebooks : des collections de connaissances du monde
que NeoTavern injecte dans le prompt exactement au moment où elles
deviennent pertinentes.

## Ce Qu'est un Lorebook

Un lorebook est un ensemble d'entrées sur un monde, un cadre ou un
personnage : lieux, factions, histoire, personnes, règles de magie — tout ce
que le modèle devrait savoir mais qui gaspillerait des jetons s'il était
inclus dans chaque message. Au lieu de charger tout le grimoire dans le
prompt, l'application n'active que les entrées dont les mots-clés
correspondent à la conversation actuelle.

Un grimoire est soit **global** (disponible dans chaque conversation), soit
lié à un **personnage** (utilisé uniquement dans les conversations de ce
personnage). Vous pouvez lier et délier des grimoires par personnage depuis
la section Lore de l'éditeur de personnage.

## Entrées

Chaque entrée possède :

- **Clés primaires** — un ou plusieurs mots-clés d'activation. Au moins une
  clé primaire est requise.
- **Clés secondaires** — des mots-clés optionnels supplémentaires.
- **Contenu** — le texte injecté dans le prompt quand l'entrée se déclenche.
- **Position** — où l'entrée est insérée par rapport aux autres entrées.
- **Interrupteurs** — `enabled` (participer à l'activation), `constant`
  (toujours inclus) et `selective` (insérer uniquement à la position
  configurée).

La correspondance est une correspondance de sous-chaîne insensible à la casse
contre le contexte de la conversation. Quand une entrée se déclenche, son
contenu est inséré dans le prompt à la position de l'entrée, et la boîte de
dialogue de l'entrée montre une estimation de sa taille en jetons afin que
vous puissiez garder le budget prévisible.

## Ordre d'Insertion

Le pipeline assemble les blocs du prompt dans un ordre fixe : prompt
principal, lorebook avant le personnage, persona, personnage, lorebook après
le personnage, exemples de dialogue, mémoire, historique de conversation,
instructions post-historique et entrée utilisateur actuelle. Les entrées de
lorebook sont classées par pertinence aux côtés des blocs de mémoire, et les
entrées constantes sont toujours présentes. L'ordre effectif des entrées
activées suit leur position dans le grimoire, donc un grimoire bien structuré
produit un prompt stable.

## Gérer les Grimoires

Le panneau Lorebooks de la barre de navigation a trois onglets : la liste des
grimoires, l'éditeur de grimoire et la liste des entrées. La liste affiche le
nom de chaque grimoire, sa description, son nombre de chargements et un badge
de portée (Global ou Personnage), avec des filtres pour les grimoires
globaux, les grimoires d'un personnage spécifique ou tous les grimoires. Les
grimoires supprimés passent dans un état corbeille et peuvent être restaurés,
et la recherche sur les grimoires est anti-rebond pour les grandes
bibliothèques.

Les nouveaux grimoires créés depuis l'éditeur de personnage sont
immédiatement liés à ce personnage. Consultez [Personnages](characters) pour
l'éditeur, et [Mémoire et rappel](memory) pour savoir comment les blocs de
mémoire interagissent avec les entrées de lorebook.
