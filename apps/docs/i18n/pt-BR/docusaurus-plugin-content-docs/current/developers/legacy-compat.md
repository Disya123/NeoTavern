---
title: Compatibilidade Legada
description: Os contratos documentados da era SillyTavern que ainda funcionam.
sidebar_position: 8
---

O NeoTavern preserva um conjunto de contratos documentados para extensões
existentes da era SillyTavern, de modo que plugins escritos contra essas APIs
possam continuar funcionando enquanto o Plugin SDK nativo é o caminho a seguir.

## Globais de Janela

O pacote `@neotavern/legacy-compat` instala os globais de janela documentados que
extensões mais antigas esperam:

- `window.SillyTavern` — com `getContext()`, `eventSource` e `event_types`.
- `window.eventSource` — a fonte de eventos legada.
- `window.event_types` — as constantes de nomes de eventos.
- `window.extension_settings` — o objeto compartilhado de configurações de
  extensão.
- `window.$` e `window.jQuery` — a instância do jQuery empacotado.

Esses globais são instalados de forma idempotente e conectados ao host por
meio de uma ponte, para que o código legado leia o mesmo contexto e os mesmos
eventos que o código nativo.

## Ilhas de DOM Não Gerenciadas

Extensões de frontend legadas esperam possuir uma parte da página. O host
fornece ilhas de DOM não gerenciadas para esse fim: um contêiner estável ao
qual o código legado pode se anexar e manipular diretamente, fora da árvore
React. As extensões recebem o contêiner, e o host cuida do resto do aplicativo
ao redor dele.

## Plugins de Servidor Legados

Plugins de servidor legados são executados por meio de um host de
compatibilidade Express. Suas rotas são proxiadas sob `/api/plugins/{pluginId}/...`,
correspondendo ao mesmo namespace usado pelos plugins de backend nativos. A
integração `@fastify/express` é usada apenas dentro dessa camada de
compatibilidade — o novo núcleo é nativo do Fastify e não roteia pelo Express.

## A Fronteira de Confiança

Pontos de entrada legados são um modo de confiança, não uma forma de contornar
a sandbox. Um pacote que os usa deve declarar `legacy.frontend` ou
`legacy.backend` em seu manifesto e solicitar a permissão `legacy.trusted`,
que a interface de consentimento exibe com um aviso reforçado. O código de
frontend legado é executado na janela principal, e o código de backend legado
recebe um roteador Express restrito ao seu próprio namespace de plugin. O modo
de segurança não carrega pontos de entrada legados de forma alguma. Veja
[Sandbox de plugins](plugin-sdk/sandboxing.md) e
[Manifesto de plugins](plugin-sdk/manifest.md) para detalhes.

## O Que Não É Suportado

Compatibilidade é um contrato documentado, não uma promessa de comportamento
universal. Plugins que dependem de qualquer um dos itens a seguir não são
suportados:

- Nomes de classes CSS internas aleatórias.
- Monkey patching de internals do aplicativo.
- Imports privados de pacotes que não são deles.

Esses são detalhes de implementação e mudam entre versões. Quando uma API
legada muda, a mudança acompanha um guia de migração e um teste de
compatibilidade.

## Migrando para Frente

Para funcionalidades novas, o [Plugin SDK](plugin-sdk/index.md) nativo é o
caminho suportado: versionado, com verificação de permissões, em sandbox e
com limpeza feita pelo host. A compatibilidade legada existe para manter
extensões existentes vivas, não para crescer. Porte as extensões para o SDK
para obter todas as garantias de segurança e ciclo de vida.
