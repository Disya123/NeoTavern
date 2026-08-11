---
title: Traduções
description: Contribua com uma tradução do site de documentação do NeoTavern ou melhore uma existente
sidebar_position: 5
---

O site de documentação é distribuído em inglês mais oito locais, e toda
tradução é uma contribuição da comunidade. Esta página explica como contribuir
com uma ou corrigir uma existente.

## Locais Atuais

O idioma base é o inglês. Os locais traduzidos são russo (`ru`), chinês
simplificado (`zh-Hans`), japonês (`ja`), coreano (`ko`), espanhol (`es`),
francês (`fr`), alemão (`de`) e português brasileiro (`pt-BR`).

## Onde as Traduções Ficam

Cada local espelha a árvore em inglês sob `apps/docs/i18n/`:

```
apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/<path>.md
```

Strings de interface — navbar, footer, tagline e rótulos da barra lateral —
ficam em arquivos JSON sob `apps/docs/i18n/<locale>/docusaurus-theme-classic/`,
gerados pelo comando write-translations.

## Completude

Toda página em inglês deve ter uma contraparte traduzida no mesmo caminho
relativo. Páginas não traduzidas recaem automaticamente no inglês, de modo
que o progresso parcial fica visível imediatamente — mas mire na cobertura
completa e nunca envie arquivos meio traduzidos.

## O Que Traduzir

- Cabeçalhos, texto do corpo, legendas e texto alternativo.
- O `title` e a `description` do front matter; mantenha `sidebar_position`
  idêntico.
- Rótulos de `_category_.json`.

## O Que Deixar Intacto

- Links, cercas de código, código inline e sintaxe de admonition
  (`:::note` ... `:::`), byte por byte.
- O nome do produto: NeoTavern nunca é traduzido.
- Identificadores de API, nomes de arquivos, comandos e flags permanecem em
  sua forma em inglês.

## Terminologia

Use a própria redação da interface do app onde ela existir; caso contrário,
use o termo comunitário padrão na sua língua. Onde um termo comunitário
padrão já existe, prefira-o — nunca invente uma palavra nova.

## Corrigindo uma Tradução

Edite o arquivo do seu local no mesmo caminho relativo e abra um pull request.
Quando a fonte em inglês de uma página muda, atualize a tradução dessa página
na mesma mudança.

## Adicionando um Novo Local

1. Adicione o código do local e seu rótulo de exibição a `i18n.locales` e
   `localeConfigs` em `apps/docs/docusaurus.config.ts`.
2. Gere o esqueleto da pasta do local:

   ```bash
   pnpm docs:translations -- --locale <code>
   ```

3. Traduza toda página sob
   `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/` e os
   arquivos JSON gerados.
4. Abra um pull request contendo tanto a mudança de configuração quanto os
   novos arquivos.

Os códigos de local seguem convenções padrão, por exemplo `zh-Hans` para
chinês simplificado e `pt-BR` para português brasileiro.
