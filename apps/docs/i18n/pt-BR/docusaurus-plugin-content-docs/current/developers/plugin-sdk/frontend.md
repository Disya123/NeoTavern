---
title: API de Frontend do Plugin
description: Como um plugin de frontend registra páginas, painéis, ações, comandos e eventos.
sidebar_position: 4
---

A API de frontend é o que um plugin do lado do navegador recebe em sua chamada
`activate()`: um conjunto de registradores para cada superfície de interface,
o barramento de eventos e i18n.

## Ponto de Entrada

Um plugin de frontend exporta uma definição com uma função `activate(api)`. O
host a chama com o objeto `FrontendPluginApi` assim que o plugin é consentido
e ativo:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    // Registre superfícies aqui.
  },
  deactivate() {
    // Teardown explícito opcional.
  },
});
```

Todo registrador retorna uma função de limpeza. O runtime as recolhe
automaticamente, então seu plugin não precisa rastreá-las à mão — embora
`deactivate()` ainda possa desmontar qualquer coisa que você gerencie por
conta própria.

## Superfícies de Registro

O namespace `api.ui` agrupa os registradores de interface:

- **Páginas** — `api.ui.pages.register({ id, path, title, mount })` adiciona
  uma rota sob o namespace do plugin. `mount` recebe um contêiner fornecido
  pelo host e pode retornar um teardown.
- **Painéis de configurações** — `api.ui.settingsPanels.register(...)`
  adiciona um painel à tela de Configurações.
- **Ações de barra de ferramentas** — `api.ui.toolbarActions.register({ id,
title, icon, run })`. O host renderiza a ação como um botão padrão; você
  fornece apenas a semântica, nunca layout ou breakpoints.
- **Ações de mensagem** — `api.ui.messageActions.register({ id, title, icon,
order, placement, run })`. O callback `run` recebe um snapshot imutável da
  mensagem mais um `AbortSignal` que dispara no teardown, na reinvocação ou no
  timeout.
- **Itens de menu de contexto** — `api.ui.contextMenuItems.register({ id,
title, context, run })` para `context: 'message' | 'character'`.
- **Renderizadores de mensagem** — `api.ui.messageRenderers.register({ id,
title, render })`. `render` retorna texto simples com um `placement` de
  `'replace'` ou `'after'` — nunca HTML.
- **Abas de personagem** — `api.ui.characterTabs.register({ id, title, mount })`.
  `mount` recebe `{ characterId }` como contexto.
- **Painéis de barra lateral** — `api.ui.sidebarPanels.register({ id, title,
slot, mount })` com `slot: 'left' | 'right'`.
- **Diálogos** — `api.ui.dialogs.register({ id, title, description, mount })`.
- **Ações da paleta de comandos** — `api.ui.commands.register({ id, title,
run })`.
- **Atalhos de teclado** — `api.ui.hotkeys.register({ id, combo, run })`, por
  exemplo `combo: 'mod+shift+k'`.

Comandos de barra (slash commands) são registrados separadamente por meio de
`api.slash.register({ name, description, run })`, e interceptadores de prompt
por meio de `api.interceptors`.

## Interceptadores de Prompt

Um interceptador roda sobre o prompt montado antes de ele ser enviado:

```ts
api.interceptors.register({
  id: 'example.format',
  priority: 100,
  timeoutMs: 5000,
  intercept(context) {
    // context.messages é um array de { id, role, content, name }.
    return context;
  },
});
```

`priority` menor roda antes; um plugin que excede `timeoutMs` é ignorado sem
quebrar a cadeia. Interceptadores que apenas inspecionam o prompt precisam de
`prompt.inspect`; aqueles que o alteram precisam de `prompt.modify`.

## Eventos

O barramento de eventos é tipado e compartilhado com o host.
`api.events.on(event, handler)` retorna uma função de cancelamento de
inscrição:

```ts
const off = api.events.on('chat.message.created', ({ chatId, messageId }) => {
  console.log('new message', chatId, messageId);
});
```

Eventos integrados incluem `chat.created`, `chat.opened`,
`chat.message.created`, `chat.message.updated`, `chat.message.deleted`,
`character.selected`, `generation.started`, `generation.delta`,
`generation.finished`, `generation.error`, `theme.changed` e
`language.changed`. Plugins também podem emitir e escutar eventos
customizados, com nomes com namespace por convenção, por exemplo
`myplugin.foo`.

## Snapshots de Mensagem e Gate de Conteúdo

Ações de mensagem recebem um `MessageActionSnapshot` imutável com `messageId`,
`chatId`, `branchId`, `role`, `content`, `name`, `meta` e `revision`. O campo
`content` é `null` a menos que o plugin também tenha `chat.read`, de modo que
uma ação pode renderizar metadados sem nunca ver o texto da mensagem.

## Notificações e i18n

`api.notify({ title, description, variant, timeoutMs })` mostra uma
notificação e retorna uma função de dispensar. `variant` é `info`, `success`,
`warning` ou `error`.

`api.i18n` gerencia recursos de tradução em um namespace de plugin isolado:

```ts
api.i18n.addResources('ru', { greet: 'Привет' });
const label = api.i18n.t('greet');
```

`addResources` retorna uma função de limpeza como qualquer outro registro.

## Garantias de Limpeza

Como todo registro retorna uma função de limpeza e o runtime as rastreia,
desativar um plugin remove todos os seus handlers, timers, nós de DOM,
inscrições e requisições em segundo plano. Veja [Ciclo de Vida](lifecycle.md)
para o contrato completo de teardown, e a
[Referência do Plugin SDK](../../api/plugin-sdk/) gerada para os tipos precisos.
