---
title: Contrato de Shell
description: As áreas nomeadas do shell que temas estilizam e plugins preenchem.
sidebar_position: 5
---

O contrato de shell define as áreas nomeadas do aplicativo. Temas estilizam
essas áreas; plugins adicionam conteúdo a elas por meio de slots estáveis.

## Áreas de Shell Nomeadas

O host publica cada área principal com um atributo de slot estável:

| Slot                 | Área                                                         |
| -------------------- | ------------------------------------------------------------ |
| `app.shell`          | A raiz do shell do aplicativo                                |
| `navigation.primary` | A trilha de navegação                                        |
| `chat.header`        | O cabeçalho do chat                                          |
| `chat.viewport`      | O viewport de rolagem do chat                                |
| `chat.composer`      | O compositor de mensagens                                    |
| `character.browser`  | A raiz do navegador de personagens                           |
| `panel.left`         | O painel de contexto esquerdo                                |
| `status.area`        | A área de status da conexão                                  |
| `modal.layer`        | A camada de modais (plugins abaixo da superfície do sistema) |
| `notification.layer` | A camada de notificações                                     |

Dois slots são reservados, mas não fazem parte da v1: `navigation.secondary`
e `panel.right`.

## O Que o Contrato Permite

Um tema pode:

- **Estilizar qualquer área nomeada** por meio de seu atributo `data-slot` e
  dos hooks de componentes dentro dela.
- **Organizar as áreas principais** por meio do `shellLayout` declarativo no
  manifesto — atualmente a ordem da trilha de navegação (grupos `main` e
  `bottom`) e a posição das abas de gerenciamento (`pinned`).
- **Substituir o fundo do canvas de chat** por meio dos tokens
  `chat-wallpaper-*`.

Rearranjo livre de áreas — mover a trilha para o lado direito, por exemplo —
não faz parte da v1. Slots são estilizados e preenchidos, não realocados.

## Como Plugins Adicionam Conteúdo

Plugins recebem as APIs de registro do SDK, e o host coloca seu conteúdo nos
slots estáveis. Por exemplo, um painel lateral registrado com `slot: 'left'`
é renderizado dentro de `panel.left`, e diálogos de plugins empilham-se dentro
de `modal.layer` abaixo da superfície do sistema.

O contrato que decorre dessa separação:

- Temas nunca dependem do DOM interno de um plugin.
- Plugins nunca dependem da hierarquia React interna ou de nomes de classes
  gerados específicos.
- Ambos os lados se encontram apenas nos slots nomeados e nos atributos de
  hook.

## Hooks Estáveis Dentro das Áreas

Dentro das áreas, os componentes publicam os atributos de hook padrão.
Exemplos notáveis:

- A raiz do compositor publica `data-slot="chat.composer"`, com uma parte de
  barra de ferramentas, uma parte de campo e uma entrada
  `data-component="textarea"`.
- Botões publicam `data-component="button"` com `data-part="icon"` e
  `data-part="label"`; ações relacionadas vivem em uma barra de ações
  (`data-component="action-bar"`) com grupos primário e secundário.
- Abas publicam `data-component="tabs"` com partes `list`, `trigger` e
  `content`; os painéis de gerenciamento usam a variante de segmento.
- Mensagens publicam `data-component="chat-message"` com
  `data-role="user|assistant|system|tool"` e estados como `streaming`.
- A trilha de navegação publica `data-component="navigation-rail"` com
  `data-part="main-items"`, `data-part="bottom-items"` e `data-item="<id>"`
  por entrada, além de `data-state="expanded|collapsed"`.
- Todos os painéis da trilha compartilham um cabeçalho comum
  (`data-component="sidebar-panel-header"`), de modo que um tema os estiliza
  uma única vez.

## Responsabilidades de Layout

O host é dono do layout crítico para o comportamento: trapping de foco,
direção lógica RTL, insets de área segura e tamanhos mínimos de alvo
interativo. Um tema de shell pode mudar a aparência e a organização das áreas,
mas deve preservar a ordem do DOM onde documentada, a rolagem horizontal de
listas de ações e o comportamento de teclado. Breakpoints são registrados no
SDK (`VIEWPORT_BREAKPOINTS` para larguras de viewport em px,
`CONTAINER_BREAKPOINTS` para tamanhos de contêiner em rem), e feature queries
como `prefers-reduced-motion` não são breakpoints de layout.

Para a camada de estilos que skiniza essas áreas, veja
[Skin de Componentes](component-skin.md); para recuperação quando um shell
está quebrado, veja [Modo de Segurança](safe-mode.md).
