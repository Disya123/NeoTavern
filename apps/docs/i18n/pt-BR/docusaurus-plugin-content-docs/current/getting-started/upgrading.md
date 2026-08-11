---
title: Atualização
description: Como funcionam as atualizações do NeoTavern e por que seus dados permanecem seguros durante uma atualização.
sidebar_position: 4
---

Esta página explica como as atualizações do NeoTavern são distribuídas, o que
acontece com seus dados durante uma atualização e onde ler sobre o que mudou.

## Como Funcionam as Atualizações

O NeoTavern trata o aplicativo principal, plugins e temas como unidades
separadas, e cada uma é atualizada de forma independente:

- **Atualizações do núcleo** substituem o próprio aplicativo, mantendo seu
  diretório de dados intacto.
- **Atualizações de plugins e temas** acontecem pelos respectivos gerenciadores
  no aplicativo e nunca são ativadas automaticamente sem sua revisão.
- Cada instalação é atômica: a nova versão substitui a antiga em uma única
  etapa, e a versão anterior é mantida para que uma atualização com falha possa
  ser revertida.
- A integridade do pacote é verificada por checksum, e o catálogo oficial pode
  adicionar assinaturas além disso.

Você nunca precisa de Git, npm ou terminal para atualizar. Se você instalou o
aplicativo normalmente, atualiza-o da mesma forma que o instalou.

## Segurança dos Dados Durante Atualizações

- Atualizações nunca modificam diretamente seus arquivos de usuário:
  personagens, chats, lorebooks, personas e configurações não são tocados pelo
  instalador.
- Quando uma atualização inclui uma migração de esquema do banco de dados, um
  backup é criado antes de a migração ser executada, e as migrações são
  transacionais e idempotentes.
- Seu banco de dados SQLite roda em modo WAL, então o aplicativo permanece
  utilizável e suas gravações continuam duráveis durante uma migração ou
  atualização.
- Se uma atualização de plugin ou tema falhar, o aplicativo mantém a versão
  anterior funcionando em vez de deixar um pacote meio instalado.

## Verificando o Que Mudou

O [changelog](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md)
lista cada mudança com seu impacto. Antes de atualizar, passe os olhos pelas
entradas mais recentes: mudanças que quebram compatibilidade vêm com um guia de
migração, e recursos ainda experimentais ou planejados são marcados
explicitamente.

## Atualizando Plugins e Temas

Abra a seção Plugins e Temas. Cada item instalado mostra sua versão, status e
se há uma atualização disponível. Se uma atualização solicitar novas
permissões, o aplicativo pede seu consentimento explícito novamente antes de
aplicá-las — permissões nunca são estendidas silenciosamente por uma
atualização.

## Reversão

Como a versão anterior é mantida durante atualizações do núcleo, você pode
reinstalá-la se uma nova versão se comportar mal. Seu diretório de dados é
legível por versões anteriores, e um backup criado antes de qualquer migração
arriscada permite restaurar um estado conhecidamente bom pela interface. Veja
[Data & Backups](../user-guide/data-and-backups).
