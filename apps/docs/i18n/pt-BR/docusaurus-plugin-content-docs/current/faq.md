---
title: FAQ
description: Perguntas frequentes sobre dados, uso offline, plugins, atualizações e migração
sidebar_position: 2
---

Esta página responde às perguntas que os usuários fazem com mais frequência
sobre o NeoTavern.

## Onde meus dados são armazenados?

Todos os seus dados — chats, personagens, personas, grupos, lorebooks, memória
e configurações — ficam em um diretório de dados na sua máquina. O diretório
contém o banco de dados SQLite e o armazenamento de arquivos com fichas de
personagem, imagens e outros ativos. Veja [Data & Storage](./developers/data/)
e [Data and Backups](./user-guide/data-and-backups) para conhecer o layout
exato e como movê-lo.

## O NeoTavern funciona offline?

Sim. O NeoTavern é local-first e capaz de funcionar offline: aponte-o para um
endpoint de modelo local e você pode conversar sem nenhuma conexão com a
internet. Provedores em nuvem obviamente precisam de rede, e o aplicativo
avisa quando uma conexão está ausente.

## Meus dados são enviados para a nuvem?

Não. Seus chats e arquivos permanecem na sua máquina. O único tráfego de rede
são as solicitações que você configura explicitamente — os provedores que você
conecta para geração, fala e imagens — e o aplicativo não envia telemetria por
padrão.

## Preciso de uma chave de API?

Apenas para os provedores em nuvem que você escolher conectar. Modelos locais
não precisam de chave alguma; você configura cada provedor em Configurações, e
a chave fica no seu perfil de conexão.

## Plugins são seguros?

Plugins rodam sob um modelo de permissões e em sandbox: plugins de backend
executam em um processo restrito, e a interface do plugin é isolada do
aplicativo principal. Você concede permissões no momento da instalação, e o
modo de segurança inicia o aplicativo sem plugins e temas se algo der errado.
Veja [Extensions](./user-guide/extensions) e o
[Plugin SDK](./developers/plugin-sdk/).

## Posso usar meus personagens existentes?

Sim. O NeoTavern importa fichas de personagem padrão, incluindo fichas PNG com
JSON incorporado, então personagens de outros aplicativos de chat e da galeria
comunitária funcionam imediatamente. Veja [Characters](./user-guide/characters).

## Posso migrar meus plugins da era SillyTavern?

Plugins escritos para o ambiente SillyTavern mais antigo podem rodar pela
camada de compatibilidade legada, que fornece os globais familiares
`window.SillyTavern`, `window.eventSource` e `window.$`, além de um host HTTP
compatível com Express. É um caminho de compatibilidade, não um alvo de
reescrita: novos plugins devem usar o [Plugin SDK](./developers/plugin-sdk/).
Veja [Legacy Compatibility](./developers/legacy-compat).

## Como funcionam as atualizações?

Atualizações são instaladas no lugar e preservam seu diretório de dados. O
changelog lista o que mudou em cada versão; leia-o antes de atualizar para
identificar mudanças que quebram compatibilidade.

## Quais são os requisitos de sistema?

O NeoTavern roda em Windows (instalador ou versão portátil), macOS (pacote) e
Linux (AppImage ou arquivo). O aplicativo de desktop inclui seu próprio runtime
Node.js, então você não precisa instalar mais nada. Um sistema operacional 64
bits atual e algumas centenas de megabytes de RAM livre para o backend são
suficientes para o uso típico.

## Existe uma versão web ou móvel?

O aplicativo de desktop é construído com Tauri e acompanha um PWA: a interface
web pode ser instalada como um aplicativo web progressivo com shell offline.
Veja [Desktop](./developers/desktop/).

## Como faço backup dos meus dados?

Exporte chats para arquivos, exporte sua biblioteca inteira ou copie o
diretório de dados com o aplicativo parado. Backups são arquivos simples e
portáveis; restaure importando-os ou colocando-os de volta no lugar. Veja
[Data and Backups](./user-guide/data-and-backups) e
[Backups](./developers/data/backups).

## O que é o modo de segurança?

O modo de segurança inicia o NeoTavern sem plugins e temas para que você possa
diagnosticar problemas causados por código de terceiros. Use-o quando o
aplicativo falhar ao iniciar após instalar um plugin ou tema. Veja
[Troubleshooting](./getting-started/troubleshooting).

## Como reporto um bug ou solicito um recurso?

Abra uma issue no [repositório do GitHub](https://github.com/Disya123/NeoTavern)
com a versão, seu sistema operacional e os passos para reproduzir. Solicitações
de recursos também são bem-vindas por lá.

## Onde encontro o changelog?

O changelog fica no repositório em
[CHANGELOG.md](https://github.com/Disya123/NeoTavern/blob/main/CHANGELOG.md).
