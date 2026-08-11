---
title: Manifeste de plugin
description: Le schéma plugin.json que chaque package .stplugin doit contenir.
sidebar_position: 2
---

Le manifeste de plugin (`plugin.json`) est la source unique de vérité d'un
plugin : identité, points d'entrée, permissions demandées et capacités
déclarées.

## Disposition du Package

Un package `.stplugin` est une archive ZIP qui contient `plugin.json` à la
racine, les fichiers d'entrée qu'il référence et d'éventuelles ressources.
L'hôte valide l'archive avant que quoi que ce soit ne soit installé : les
traversées de chemins, les liens symboliques, les charges exécutables et les
limites de taille sont tous rejetés.

## Champs du Manifeste

```json
{
  "id": "author.plugin-name",
  "name": "Plugin Name",
  "version": "1.0.0",
  "apiVersion": 2,
  "engines": { "neotavern": "^0.1.0" },
  "frontend": "dist/frontend.js",
  "backend": "dist/backend.mjs",
  "styles": "dist/plugin.css",
  "permissions": ["chat.read", "ui.messageActions", "network:api.example.com"],
  "i18n": { "ru": "locales/ru.json", "de": "locales/de.json" }
}
```

Les champs principaux sont :

- **`id`** — identifiant DNS inversé, par exemple `author.plugin-name`. Il
  est unique parmi tous les plugins installés et stable à travers les mises à
  jour.
- **`name`** — nom lisible affiché dans le gestionnaire de plugins.
- **`version`** — version sémantique (`major.minor.patch`). Elle alimente les
  comparaisons de versions et l'invalidation du cache.
- **`apiVersion`** — la version d'API du SDK ciblée par le plugin. La version
  actuelle est 3 ; la version 2 reste la valeur par défaut jusqu'à ce que le
  nouveau runtime arrive en production.
- **`engines`** — contraintes de compatibilité comme `neotavern: "^0.1.0"`.
- **`frontend`** — chemin relatif de l'entrée ESM navigateur.
- **`backend`** — chemin relatif de l'entrée ESM Node.js.
- **`styles`** — feuille de style de plugin facultative.
- **`i18n`** — code de locale vers chemin relatif des fichiers JSON de
  traduction.

## Permissions

Le tableau `permissions` est la liste plate héritée du SDK v2. Les nouveaux
manifestes doivent déclarer des capacités limitées à la place via
`requiredCapabilities` et `optionalCapabilities` :

```json
{
  "requiredCapabilities": [
    { "name": "chat.read" },
    { "name": "network", "scope": "api.example.com" }
  ],
  "optionalCapabilities": [{ "name": "lorebook.read" }]
}
```

`requiredCapabilities` sont les capacités sans lesquelles le plugin ne peut
pas fonctionner ; `optionalCapabilities` sont celles dont il peut se passer.
L'utilisateur confirme chaque capacité demandée à l'installation. Ajouter de
nouvelles permissions dans une mise à jour exige un nouveau consentement —
consultez [Permissions](permissions.md).

## Points d'Entrée Hérités

```json
{
  "legacy": {
    "frontend": "legacy/main-window.js",
    "backend": "legacy/server.mjs"
  }
}
```

Le bloc `legacy` pointe vers des entrées de compatibilité de confiance pour
les extensions SillyTavern existantes. Les packages utilisant l'une ou
l'autre entrée doivent demander la permission `legacy.trusted`, et
l'interface affiche un avertissement plus fort pendant le consentement. Le
mode sans échec ne charge jamais les points d'entrée hérités. Consultez
[Bac à sable](sandboxing.md) pour savoir en quoi cela diffère des plugins
natifs.

## Clients OAuth

Les plugins qui se connectent à un service externe peuvent déclarer des
clients publics OAuth 2.0 utilisant le flux de code d'autorisation avec PKCE :

```json
{
  "authClients": [
    {
      "serviceId": "com.example.idp",
      "name": "Example IdP",
      "authorizationUrl": "https://idp.example.com/oauth/authorize",
      "tokenUrl": "https://idp.example.com/oauth/token",
      "clientId": "neotavern-author.plugin-name",
      "scopes": ["profile.read"]
    }
  ]
}
```

Seuls les clients publics sont autorisés : `clientSecret` est interdit parce
que le code de plugin s'exécute dans un bac à sable. Les endpoints doivent
être en HTTPS, avec une exception de boucle HTTP simple pour les fournisseurs
d'identité locaux pendant le développement. Changer un descripteur exige de
réinstaller le package.

## Champs de Workers et de Signature

Les manifestes avancés peuvent déclarer des modules supplémentaires :

- **`workers`** — des modules d'entrée relatifs au package que le plugin peut
  lancer comme workers de calcul isolés. Lancer une entrée non déclarée est
  rejeté.
- **`publisher`** et **`signature`** — la signature du package. `keyId` est
  l'empreinte `ed25519:<hex>` de la clé publique de signature, et
  `signature` est la signature Ed25519 base64 sur le manifeste canonique. Ils
  sont définis par l'outil de build de plugins, jamais écrits à la main.

La fonction `validateManifest` du SDK vérifie chaque champ, et la
[référence du Plugin SDK](../../api/plugin-sdk/) générée documente le type exact
`PluginManifest`.
