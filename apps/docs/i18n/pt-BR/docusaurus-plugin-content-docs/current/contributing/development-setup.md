---
title: Configuração de Desenvolvimento
description: Configure um ambiente de desenvolvimento do NeoTavern e execute o projeto localmente
sidebar_position: 2
---

Esta página explica como configurar um ambiente de desenvolvimento para o
NeoTavern e executar o projeto localmente.

## Pré-requisitos

- Node.js 24 LTS ou mais novo — o projeto exige Node `>= 24`.
- pnpm 9 — o workspace exige pnpm `>= 9` e `< 10` e declara
  `packageManager: pnpm@9.15.0`; habilite-o com o corepack ou instale-o
  diretamente.
- Windows, macOS ou Linux. O app desktop empacota seu próprio runtime Node.js
  para usuários finais, mas o desenvolvimento sempre usa o Node.js instalado
  na sua máquina.

## Instalar Dependências

```bash
pnpm install
```

Isso instala todos os pacotes do workspace. O repositório é um monorepo pnpm:
aplicativos ficam em `apps/` (server e web) e bibliotecas compartilhadas em
`packages/`.

## Executar em Desenvolvimento

```bash
pnpm dev
```

inicia o backend Fastify e o app web Vite em paralelo com hot reload. Para
executá-los separadamente:

```bash
pnpm dev:server
pnpm dev:web
```

Abra a URL impressa pelo dev server do Vite, conecte um provedor em
Configurações e envie sua primeira mensagem para verificar o pipeline
completo: chat, servidor, provedor, streaming e salvamento.

## Gates de Qualidade

Execute estes comandos antes de enviar:

```bash
pnpm typecheck    # TypeScript em todo o monorepo
pnpm lint         # ESLint, zero warnings permitidos
pnpm test         # Testes unitários e de integração Vitest, além de testes web
pnpm test:e2e     # Suite Playwright end-to-end (constrói o workspace primeiro)
pnpm build        # build completo do workspace (tsc -b e Vite)
pnpm format:check # Verificação Prettier
```

`pnpm test:e2e` compila todo o workspace primeiro, então espere que demore
mais que as outras verificações. Os scripts `docs:check` e `docs:build`
validam a documentação interna de desenvolvedores; o site público tem seus
próprios comandos, documentados na página
[Site de Documentação](./docs-site).

## Desenvolvimento Desktop

O shell desktop (Tauri) e seu sidecar Node são aplicativos separados:

```bash
pnpm desktop:dev       # executar o app desktop em desenvolvimento
pnpm desktop:portable  # construir o pacote Windows portátil
pnpm desktop:release   # construir pacotes de instalador
```

O empacotamento desktop envolve toolchains específicas do SO; veja a seção
[Desktop](../developers/desktop/) da documentação de Desenvolvedores para
detalhes.

## Problemas Comuns

- `pnpm install` ou `pnpm dev` falha: verifique se `node -v` reporta 24 ou
  mais novo e se `pnpm -v` reporta 9.
- Os dev servers não iniciam: verifique se nenhum outro processo ocupa as
  portas que o server e o Vite usam e reinicie o `pnpm dev`.
