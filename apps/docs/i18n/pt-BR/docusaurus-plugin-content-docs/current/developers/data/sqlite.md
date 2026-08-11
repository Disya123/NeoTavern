---
title: Armazenamento SQLite
description: >-
  As configurações do banco de dados SQLite, tabelas STRICT, busca FTS5, IDs
  UUIDv7 estáveis, migrações versionadas e isolamento de plugins.
sidebar_position: 2
---

O NeoTavern armazena todos os dados estruturados em um único banco de dados
SQLite com pragmas estritos, tabelas STRICT, busca FTS5 e migrações
versionadas.

## Configurações do Banco de Dados

A conexão é aberta com as seguintes configurações:

- `foreign_keys = ON` — a integridade referencial é aplicada.
- Modo de journal WAL — leitores nunca são bloqueados por escritores.
- `busy_timeout` — escritores concorrentes esperam em vez de falhar
  imediatamente.
- `synchronous = NORMAL` — durabilidade com desempenho seguro para WAL.
- Declarações preparadas — todas as consultas passam pelas declarações
  preparadas do Drizzle; sem interpolação bruta de strings SQL.
- Tabelas STRICT sempre que possível — o SQLite aplica os tipos das colunas.
- FTS5 — busca de texto completo sobre personagens, chats e mensagens.

## IDs Estáveis

Toda entidade tem um ID de string estável, de preferência UUIDv7. IDs nunca
são índices de array. Onde uma lixeira é necessária, as linhas são excluídas
de forma branda com `deleted_at` em vez de removidas.

## Visão Geral do Esquema

As tabelas principais cobrem a biblioteca e o estado de runtime: personagens,
personas, chats, ramificações, mensagens e variantes de mensagens, tags,
lorebooks e entradas de lore, presets, configurações e segredos de
provedores, o registro de plugins com configurações e concessões de
capacidades, o registro de temas, auditorias de contexto de prompt, trabalhos
e artefatos de importação, e metadados de cache.

Dois padrões importam para autores de plugins:

- `plugin_state` armazena estado de propriedade do plugin separadamente do
  registro de instalação, com um `schema_version` para o formato de dados e
  uma `revision` para compare-and-swap.
- `provider_secrets` armazena chaves de API como valores somente-gravação:
  apenas uma pré-visualização mascarada sai do repositório.

## Busca FTS5

As tabelas virtuais `characters_fts`, `chats_fts` e `messages_fts` alimentam a
busca, construídas com `unicode61` e `remove_diacritics`. Gatilhos em
`INSERT`/`UPDATE`/`DELETE` as mantêm sincronizadas transacionalmente. A busca
suporta termos de prefixo (`token*`), filtros de tag e classificação por
relevância bm25. Uma reconstrução completa está disponível em
`POST /api/v2/search/rebuild`.

## Migrações

Toda mudança de esquema chega como uma migração:

- Migrações são **versionadas e idempotentes** — `IF NOT EXISTS` mais uma
  versão estrita tornam a reexecução segura.
- Migrações rodam **transacionalmente**; uma migração com falha reverte como
  um todo.
- Não há migração automática `down`. Reversão significa restaurar o backup
  pré-migração, que o runner cria automaticamente para bancos de dados
  populados antes de migrações perigosas.
- Ler dados nunca dispara mudanças destrutivas ocultas.

Veja [Backups](backups) para saber como funcionam os backups de segurança do
runner de migração.

## Isolamento de Plugins

Plugins nunca recebem uma conexão SQLite direta. Toda persistência passa
pelas APIs de armazenamento do Plugin SDK, que possuem as tabelas
`plugin_storage` e `plugin_state` em nome do plugin. Isso mantém os dados do
plugin versionados, revogáveis e seguros contra acidentes de SQL bruto. Veja o
[Plugin SDK](../plugin-sdk/) para a API de armazenamento.

## O Que Nunca Entra no Banco de Dados

- Imagens e áudio são armazenados em disco, nunca como BLOBs no banco de dados
  principal. Veja [Arquivos e Imagens](files-and-images).
- Campos desconhecidos de fichas de personagem e metadados de extensão são
  preservados na coluna `ext` e sobrevivem a exportação e importação.
