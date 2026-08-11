---
title: Dados e Armazenamento
description: >-
  Visão geral da camada de dados: o banco de dados SQLite, o layout do sistema
  de arquivos para originais e cache, e o modelo de backups.
sidebar_position: 1
---

Esta seção explica como o NeoTavern armazena dados: o banco de dados SQLite, o
layout do sistema de arquivos para originais e cache, e o modelo de backups.

## Diretório de Dados

Todos os dados do usuário ficam em um único diretório de dados local:

```text
data/
  app.db
  files/{avatars,backgrounds,attachments,audio,generated}/
  plugins/  themes/  cache/thumbnails/  backups/  logs/
```

## Páginas Nesta Seção

- [Armazenamento SQLite](data/sqlite) — pragmas, tabelas STRICT, busca FTS5, IDs
  UUIDv7 estáveis e migrações.
- [Arquivos e Imagens](data/files-and-images) — como originais e miniaturas
  regeneráveis são armazenados e gravados atomicamente.
- [Backups](data/backups) — o modelo de backups, a restauração e o que os backups
  cobrem.

## Seções Relacionadas

- A seção [Arquitetura](architecture/) explica onde a camada de dados fica
  no monorepo.
- Para a visão voltada ao usuário, veja Dados e Backups no
  [Guia do Usuário](../user-guide/data-and-backups).
