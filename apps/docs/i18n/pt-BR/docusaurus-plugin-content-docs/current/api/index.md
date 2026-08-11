---
title: Referência da SDK
description: Visão geral da referência TypeDoc gerada automaticamente para os quatro pacotes públicos da SDK.
sidebar_position: 1
---

A Referência da SDK é uma referência de API gerada automaticamente para os
quatro pacotes públicos TypeScript que o NeoTavern expõe a autores de plugins,
temas e provedores.

## O Que É Gerado

A referência é produzida pelo TypeDoc a partir do ponto de entrada
`src/index.ts` de cada pacote durante cada build do site. Ela documenta a
superfície exportada exata de:

- **Plugin SDK** — `@neotavern/plugin-sdk`: validação de manifesto, o modelo de
  permissões, eventos tipados e os contratos de API de frontend e backend de
  plugins.
- **Theme SDK** — `@neotavern/theme-sdk`: o contrato de design tokens, validação de
  manifesto de temas, resolução de herança e geração de variáveis CSS.
- **Provider SDK** — `@neotavern/provider-sdk`: o contrato de adaptadores de
  provedores, adaptadores integrados, estimativa de tokens e o registro de
  runtime.
- **Contracts** — `@neotavern/contracts`: os esquemas compartilhados de requisição,
  resposta e entidades dos quais as rotas do backend e os tipos do frontend
  derivam.

As páginas geradas não são escritas à mão e não são commitadas no
repositório. Elas são recriadas a cada build, de modo que sempre correspondem
ao `src/` atual dos pacotes.

## Regenerando a Referência

Qualquer build do Docusaurus regenera a referência como parte do pipeline:

```bash
pnpm --filter @neotavern/docs build
```

Execute o mesmo comando localmente quando quiser uma referência nova depois de
alterar um arquivo de código-fonte da SDK.

## Navegando pelos Pacotes

- [Referência do Plugin SDK](api/plugin-sdk/)
- [Referência do Theme SDK](api/theme-sdk/)
- [Referência do Provider SDK](api/provider-sdk/)
- [Referência de Contracts](api/contracts/)

Para guias de uso em vez de listagens cruas de API, veja as seções Plugin SDK,
Theme SDK e Provedores desta documentação. Elas explicam os contratos em
prosa, com exemplos, e linkam de volta para as páginas geradas para as
assinaturas precisas.
