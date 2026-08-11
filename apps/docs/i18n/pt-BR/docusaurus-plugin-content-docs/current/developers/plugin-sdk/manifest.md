---
title: Manifesto do Plugin
description: O esquema de plugin.json que todo pacote .stplugin deve conter.
sidebar_position: 2
---

O manifesto do plugin (`plugin.json`) é a fonte única de verdade de um plugin:
identidade, pontos de entrada, permissões solicitadas e capacidades
declaradas.

## Estrutura do Pacote

Um pacote `.stplugin` é um arquivo ZIP que contém `plugin.json` na raiz, os
arquivos de entrada que ele referencia e quaisquer ativos. O host valida o
arquivo antes de qualquer instalação: path traversal, symlinks, payloads
executáveis e limites de tamanho são todos rejeitados.

## Campos do Manifesto

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

Os campos principais são:

- **`id`** — identificador reverse-DNS, por exemplo `author.plugin-name`. Ele
  é único entre todos os plugins instalados e estável entre atualizações.
- **`name`** — nome legível mostrado no Gerenciador de Plugins.
- **`version`** — versão semântica (`major.minor.patch`). Alimenta comparações
  de versão e invalidação de cache.
- **`apiVersion`** — a versão da API do SDK que o plugin visa. A versão atual
  é 3; a versão 2 permanece como padrão até o novo runtime chegar em produção.
- **`engines`** — restrições de compatibilidade como `neotavern: "^0.1.0"`.
- **`frontend`** — caminho relativo para a entrada ESM do navegador.
- **`backend`** — caminho relativo para a entrada ESM do Node.js.
- **`styles`** — folha de estilo opcional do plugin.
- **`i18n`** — código de locale para caminho relativo dos arquivos JSON de
  tradução.

## Permissões

O array `permissions` é a lista plana legada do SDK v2. Manifestos novos
devem declarar capacidades com escopo por meio de `requiredCapabilities` e
`optionalCapabilities`:

```json
{
  "requiredCapabilities": [
    { "name": "chat.read" },
    { "name": "network", "scope": "api.example.com" }
  ],
  "optionalCapabilities": [{ "name": "lorebook.read" }]
}
```

`requiredCapabilities` são capacidades sem as quais o plugin não pode
funcionar; `optionalCapabilities` são aquelas sem as quais ele pode degradar.
O usuário confirma toda capacidade solicitada na instalação. Adicionar novas
permissões em uma atualização exige novo consentimento — veja
[Permissões](permissions.md).

## Pontos de Entrada Legados

```json
{
  "legacy": {
    "frontend": "legacy/main-window.js",
    "backend": "legacy/server.mjs"
  }
}
```

O bloco `legacy` aponta para entradas de compatibilidade confiáveis para
extensões SillyTavern existentes. Pacotes que usam qualquer uma das entradas
devem solicitar a permissão `legacy.trusted`, e a interface mostra um aviso
mais forte durante o consentimento. O modo de segurança nunca carrega pontos
de entrada legados. Veja [Sandboxing](sandboxing.md) para saber como isso
difere dos plugins nativos.

## Clientes OAuth

Plugins que se conectam a um serviço externo podem declarar clientes públicos
OAuth 2.0 usando fluxo authorization-code com PKCE:

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

Apenas clientes públicos são permitidos: `clientSecret` é proibido porque o
código do plugin roda em sandbox. Os endpoints devem ser HTTPS, com uma
exceção de loopback HTTP simples para provedores de identidade locais durante
o desenvolvimento. Alterar um descritor exige reinstalar o pacote.

## Campos de Worker e Assinatura

Manifestos avançados podem declarar módulos adicionais:

- **`workers`** — módulos de entrada relativos ao pacote que o plugin pode
  iniciar como workers de computação isolados. Iniciar uma entrada não
  declarada é rejeitado.
- **`publisher`** e **`signature`** — assinatura do pacote. `keyId` é a
  impressão digital `ed25519:<hex>` da chave pública de assinatura, e
  `signature` é a assinatura Ed25519 em base64 sobre o manifesto canônico.
  Eles são definidos pela ferramenta de build de plugins, nunca escritos à
  mão.

A função `validateManifest` do SDK verifica cada campo, e a
[Referência do Plugin SDK](../../api/plugin-sdk/) gerada documenta o tipo exato
`PluginManifest`.
