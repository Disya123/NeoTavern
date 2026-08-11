---
title: Visão Geral do Desktop
description: Como o app desktop é entregue — um shell Tauri 2 com um sidecar Node.js embutido.
sidebar_position: 1
---

O app desktop é uma distribuição nativa do NeoTavern: um shell Tauri 2 que
executa o backend Fastify como um sidecar Node.js embutido.

## Um App, Sem Configuração

A distribuição desktop é autocontida. Node.js, SQLite e os ativos web de
produção vêm dentro do pacote, de modo que o primeiro uso não precisa de
terminal, Git, npm nem configuração manual de banco de dados. Você instala o
app, o inicia, e a webview abre assim que a API local está pronta.

As peças de runtime são:

- **Shell Tauri 2** — a janela nativa e o ciclo de vida do aplicativo.
- **Sidecar Node.js** — um binário Node.js 24 autocontido que executa o
  backend Fastify localmente em `127.0.0.1`.
- **SQLite** — o banco de dados local, criado automaticamente no diretório de
  dados no primeiro uso.

## Formatos Suportados

O build desktop atende aos formatos que a maioria dos usuários espera:

- Instalador Windows (NSIS e MSI).
- Build portátil Windows (um ZIP com uma flag de portabilidade).
- Pacote macOS (`.app`, além de DMG).
- AppImage Linux e um arquivo.

Cada formato é produzido em seu runner nativo de plataforma, porque a
distribuição empacota addons nativos como `better-sqlite3` e Sharp. Veja
[Empacotamento](packaging.md) para os detalhes de formato e o comportamento no
primeiro uso.

## Garantias de Ciclo de Vida

O shell e o sidecar são uma única unidade. Fechar a janela encerra o backend —
o app nunca deixa um processo Node.js órfão para trás. Uma saída inesperada do
backend termina o shell com um erro em vez de uma janela silenciosamente
quebrada. Veja [Shell Tauri](tauri-shell.md) e
[Sidecar Node](node-sidecar.md) para a mecânica.

## Localização dos Dados

Builds instalados armazenam dados do usuário no diretório de dados locais do
app da plataforma, nunca dentro do pacote. O build portátil é a exceção: com a
flag de portabilidade presente, os dados ficam em uma pasta `data/` local ao
lado do aplicativo. O tratamento de dados em si é coberto na seção
[Dados e Armazenamento](../data/index.md).

## Próximos Passos

- [Shell Tauri](tauri-shell.md) — a janela nativa e seu ciclo de vida.
- [Sidecar Node](node-sidecar.md) — o processo de backend embutido.
- [Empacotamento](packaging.md) — formatos de distribuição e primeiro uso.
