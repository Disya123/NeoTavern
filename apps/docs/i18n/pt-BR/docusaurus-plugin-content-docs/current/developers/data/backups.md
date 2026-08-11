---
title: Backups
description: >-
  O modelo de backups: snapshots online do SQLite, restauração segura com
  backup de segurança, e o que os backups cobrem.
sidebar_position: 4
---

Backups são snapshots online do SQLite criados pela SQLite Backup API, seguros
para executar com WAL e restauráveis sem ferramentas externas.

## Modelo de Backup

Um backup é um snapshot consistente do banco de dados SQLite, criado enquanto
o servidor está em execução:

- `POST /api/v2/backups` cria o snapshot pela SQLite Backup API, que é segura
  com WAL e não bloqueia leitores.
- `GET /api/v2/backups` lista os backups existentes; conteúdos de cache e logs
  não são incluídos.

Cada registro de backup mostra sua data, tamanho, versão de esquema, origem e
estado. A interface mostra as mesmas informações, e criar um backup nunca
interrompe a leitura dos dados locais.

## O Que os Backups Cobrem

Um backup cobre todo o banco de dados estruturado: personagens, personas,
chats e mensagens, lorebooks, presets, configurações de provedores, estado de
plugins e configurações. Ele não inclui:

- `cache/thumbnails/` — regenerável, e excluído por design;
- logs — excluídos por design;
- diretórios de staging de importação — temporários por design.

Originais em `files/` são endereçados por conteúdo e nunca tocados pela
manutenção de cache, então não fazem parte do snapshot em si.

## Restauração

`POST /api/v2/backups/:id/restore` segue uma sequência segura:

1. Cria e faz a rotação de um **backup de segurança** do estado atual.
2. Valida o snapshot selecionado com `PRAGMA quick_check`.
3. Copia-o para o banco de dados ativo pela SQLite Online Backup API.

A conexão e os repositórios permanecem abertos: a resposta carrega
`restartRequired: false`, e leituras e escritas subsequentes continuam
funcionando sem reinicialização. A restauração nunca exige ferramentas SQLite
externas. Um snapshot ou cópia com falha retorna `RESTORE_FAILED`, e o backup
de segurança é retido, de modo que o estado atual nunca é perdido em uma
restauração com falha.

Na interface, a restauração exige confirmação explícita, nunca é relatada como
bem-sucedida antes de a verificação de integridade passar, e oferece retorno
automático à cópia de segurança se algo der errado. Excluir um backup avisa
você se ele for a última cópia funcional.

## Backups como Rede de Segurança

As mesmas mecânicas de snapshot protegem operações perigosas:

- O runner de migração cria um backup pré-migração para bancos de dados
  populados antes de migrações que reconstroem ou remodelam tabelas.
- A execução de importação cria um backup de segurança antes de gravar
  qualquer dado selecionado, de modo que uma importação com falha ou
  interrompida sempre pode ser revertida.
- A restauração sempre captura o estado atual primeiro, como descrito acima.

## Veja Também

- [Armazenamento SQLite](sqlite) para o banco de dados em si.
- [Arquivos e Imagens](files-and-images) para o que vive fora do banco de
  dados.
- O fluxo voltado ao usuário está documentado no
  [Guia do Usuário](../../user-guide/data-and-backups).
