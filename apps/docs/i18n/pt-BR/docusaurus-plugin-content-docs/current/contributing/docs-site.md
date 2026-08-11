---
title: Site de Documentação
description: Como o site de documentação do NeoTavern funciona e como adicionar ou corrigir páginas
sidebar_position: 4
---

O site público de documentação é um projeto Docusaurus em `apps/docs`. Esta
página explica seu layout e como adicionar ou atualizar páginas.

## Layout

- As páginas-fonte em inglês ficam em `apps/docs/docs/`, um arquivo markdown
  por página, organizadas nos mesmos diretórios que a barra lateral mostra.
- As traduções ficam em
  `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/`,
  espelhando a árvore em inglês com um arquivo por página; veja
  [Traduções](./translations).
- A referência da SDK em `apps/docs/docs/api/` é gerada e gitignorada; não a
  edite à mão.

## Adicionando uma Página

1. Crie o arquivo markdown no diretório que corresponde a onde a página deve
   aparecer.
2. Adicione front matter com `title`, `description` e `sidebar_position`:

   ```yaml
   ---
   title: Page Title
   description: One sentence describing the page.
   sidebar_position: 3
   ---
   ```

3. Abra com um resumo de uma frase do que a página cobre.
4. Use `##` e `###` para seções; o `title` do front matter fornece o único H1.
5. Se você adicionar um novo diretório, crie um `_category_.json` nele:

   ```json
   { "label": "Category Label", "position": 2 }
   ```

`sidebar_position` ordena páginas dentro do seu diretório; a página Overview
é 1. As seções da barra lateral de conteúdo são geradas automaticamente a
partir da estrutura de diretórios.

## Limites de MDX

As páginas são Markdown simples mais admonitions do Docusaurus apenas:

```md
:::note
Texto dentro da admonition.
:::
```

Sem declarações `import`, sem componentes JSX customizados, sem abas e sem HTML
bruto. Toda página deve permanecer copiável verbatim para qualquer um dos oito
locais de tradução. Amostras de código usam blocos cercados com uma tag de
idioma.

## Referência da SDK

A referência da SDK é gerada pelo TypeDoc a partir do ponto de entrada de cada
pacote:

- `packages/plugin-sdk/src/index.ts` -> `apps/docs/docs/api/plugin-sdk/`
- `packages/theme-sdk/src/index.ts` -> `apps/docs/docs/api/theme-sdk/`
- `packages/provider-sdk/src/index.ts` -> `apps/docs/docs/api/provider-sdk/`
- `packages/contracts/src/index.ts` -> `apps/docs/docs/api/contracts/`

A referência é regenerada a cada build do site, de modo que edições nas
páginas geradas são perdidas. Para corrigir uma página de referência, corrija o
TSDoc no código-fonte do pacote. A visão geral em `apps/docs/docs/api/index.md`
é escrita à mão e permanece commitada.

## Executando o Site

```bash
pnpm docs:site        # dev server local com hot reload
pnpm docs:site:build  # build de produção: todos os locais mais a referência da SDK
```

O build de produção é o gate — links quebrados e links markdown quebrados o
fazem falhar — então execute-o antes de enviar mudanças de conteúdo.

## Regras de Links

Links internos devem apontar para páginas que existem no site. Prefira
caminhos absolutos do site a partir da página inicial (`/getting-started/`) e
caminhos relativos a partir de páginas mais profundas (`../developers/` a
partir de uma página sob `contributing/`). Links externos são limitados à
documentação do Docusaurus e ao repositório do NeoTavern.

## Documentação Interna de Desenvolvedores

O repositório também mantém documentação interna de desenvolvedores em `docs/`
na raiz do repositório, validada por `pnpm docs:check` e `pnpm docs:build`.
Esse é um conjunto separado de documentos deste site público; não confunda as
duas árvores.
