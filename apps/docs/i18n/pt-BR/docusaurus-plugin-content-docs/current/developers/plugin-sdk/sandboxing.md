---
title: Sandboxing de Plugins
description: 'O modelo de segurança para código de plugin não confiável: isolamento de processo e modo de segurança.'
sidebar_position: 7
---

Código de plugin não confiável é isolado em todas as camadas: o backend roda
em um processo restrito separado, o frontend roda em um iframe em sandbox, e
temas nunca recebem acesso sensível de forma alguma.

## Sem Sandbox de JavaScript

`node:vm` é deliberadamente não usado como sandbox de segurança. Uma sandbox
de interpretador JavaScript não pode impedir um atacante determinado de
alcançar o processo do host. Em vez disso, o isolamento é aplicado pelo
sistema operacional: processos separados com capacidades limitadas e contextos
de navegação separados.

## Isolamento de Backend

Um plugin de backend não confiável roda em seu próprio processo Node.js 24
com restrições:

- Um loader limitado resolve apenas ESM local ao pacote e a API do SDK.
- O processo não pode importar built-ins `node:*` além do que o loader
  permite, resolver módulos fora da raiz do pacote ou alcançar o banco de
  dados do host.
- Todas as capacidades chegam por um canal IPC; o host aplica permissões em
  cada chamada.
- O processo escuta eventos centrais do aplicativo apenas pelo barramento de
  eventos do SDK e pode emitir apenas sob seu próprio namespace.
- Se o processo falhar, o host remove todo registro que ele possuía.

O processo de plugin nunca recebe a raiz do Fastify, a conexão SQLite,
caminhos absolutos, o ambiente completo ou as chaves de API de outros
provedores. O acesso à rede é limitado aos hosts concedidos por meio do
`fetch` verificado por permissões.

## Isolamento de Frontend

Um plugin de frontend nativo roda dentro de um iframe em sandbox com
`sandbox="allow-scripts"` e sem `allow-same-origin`:

- O iframe não tem acesso de mesma origem ao documento do aplicativo.
- A comunicação com o host acontece por um único `MessagePort` transferido com
  um nonce de bootstrap, envelopes estruturados, prazos e cancelamento.
- O host monta a interface de cada registro em uma raiz isolada dentro do
  iframe e comunica-se via RPC, de modo que o plugin nunca toca a árvore de
  componentes React ou o DOM interno.
- Uma falha na interface de um plugin derruba apenas as raízes e regiões de
  recorte daquele plugin.

Cada plugin possui um iframe de sandbox de viewport completo; o host agrupa os
retângulos das montagens ativas e recorta a área visível e interativa do
iframe à sua união, de modo que eventos de ponteiro fora de uma superfície de
plugin permanecem com o aplicativo.

## Modo Legado Confiável

Entradas `legacy.frontend` e `legacy.backend` são um modo de compatibilidade
confiável separado para extensões SillyTavern existentes — não um desvio da
sandbox nativa. Usar qualquer uma das entradas exige a permissão
`legacy.trusted`, que a interface mostra com um aviso reforçado, e o usuário
deve confirmá-la explicitamente. O código de frontend legado é executado na
janela principal, e o código de backend legado recebe um roteador Express com
escopo em seu próprio namespace `/api/plugins/{pluginId}`. O modo de segurança
não carrega pontos de entrada legados de forma alguma.

## Temas

Pacotes de tema são ainda mais restritos: um tema não recebe acesso a chats,
chaves de API ou ao sistema de arquivos. Temas são apenas CSS e layout
declarativo — não há ponto de entrada JavaScript no Theme SDK. Veja
[Modo de segurança do Theme SDK](../theme-sdk/safe-mode.md) para a história do
lado dos temas.

## Modo de Segurança

O modo de segurança (`?safe=1` na URL) desativa plugins e temas de terceiros
inteiramente. Ele é tratado antes de o código de plugin ou tema carregar: CSS
de pacote e overrides de tokens não são adicionados ao documento, e pontos de
entrada de terceiros nunca rodam. O tema integrado e o runtime de plugin
integrado permanecem, de modo que a interface sempre se recupera. Sair do modo
de segurança restaura o estado ativo salvo anteriormente de plugins e temas.

## Validação de Pacote

Todo pacote é validado antes que qualquer código possa rodar: path traversal,
symlinks, binários nativos e payloads executáveis são rejeitados; campos do
manifesto, pontos de entrada e permissões são verificados; dependências npm
são buscadas com verificações de integridade e scripts de instalação nunca são
executados. Para a história completa de instalação ao teardown, veja
[Ciclo de Vida](lifecycle.md).
