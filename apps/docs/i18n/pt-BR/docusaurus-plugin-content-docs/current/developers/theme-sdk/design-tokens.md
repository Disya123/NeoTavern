---
title: Design Tokens
description: O contrato semântico de design tokens e o que os componentes não podem fixar.
sidebar_position: 3
---

Design tokens são as variáveis semânticas que carregam todos os valores
visuais no aplicativo. Componentes os referenciam; temas os substituem; nada é
fixado.

## O Contrato de Tokens

Todo token é uma propriedade customizada CSS prefixada com `--st-`, e todo
nome de token faz parte do contrato versionado em `@neotavern/theme-sdk`. O host
fornece valores padrão para os modos claro e escuro, de modo que todo token
sempre resolve mesmo quando um tema não define nenhum.

Os grupos canônicos de tokens são:

- **Cores de texto** — `color-text-primary`, `color-text-secondary`,
  `color-text-muted`, `color-text-inverse`, `color-text-link`.
- **Superfícies** — `color-surface-primary`, `color-surface-secondary`,
  `color-surface-tertiary`, `color-surface-overlay`, `color-surface-canvas`,
  `color-surface-elevated`.
- **Destaque e status** — `color-accent`, `color-accent-hover`,
  `color-accent-text`, `color-accent-soft`, `color-accent-soft-text`,
  `color-border`, `color-border-strong`, `color-success`, `color-warning`,
  `color-danger`, `color-info`.
- **Markdown de mensagens de chat** — `color-message-quote`,
  `color-message-emphasis`, `color-message-code`, `color-message-code-bg`.
- **Tipografia** — `font-ui`, `font-mono`, `font-size-2xs` até
  `font-size-2xl`, `line-height-body`, `font-weight-normal` até
  `font-weight-bold`.
- **Espaçamento** — `space-2xs` até `space-3xl`.
- **Raios e bordas** — `radius-control`, `radius-card`, `radius-overlay`,
  `radius-panel`, `radius-round`, `radius-inset`, `border-width`.
- **Elevação** — `shadow-card`, `shadow-soft`, `shadow-focus`,
  `shadow-overlay`.
- **Camadas (z-index)** — `layer-base`, `layer-raised`, `layer-panel`,
  `layer-plugin-overlay`, `layer-plugin-chrome`, `layer-dropdown`,
  `layer-modal`, `layer-notification`.
- **Movimento** — `motion-duration-fast`, `motion-duration-normal`,
  `motion-duration-slow`, `motion-easing-standard`, `effect-glass-blur`.
- **Tamanhos de controles** — `control-height`, `control-height-large`,
  `control-height-sm`, `control-height-xs`, `control-height-2xs`,
  `control-hit-min`, `switch-width`, `switch-height`, `switch-thumb-size`,
  `menu-min-width`, `dialog-max-width`, `dialog-max-height`,
  `textarea-min-height`, `spinner-size`.
- **Tamanhos de painel e conteúdo** — `size-panel-max-height`,
  `size-content-max-height`, `size-chat-column-max`.
- **Limites de viewport** — `overlay-width-limit`, `overlay-height-limit`,
  `dialog-sheet-height`.
- **Barras de rolagem** — `scrollbar-width`, `scrollbar-radius`,
  `scrollbar-track-bg`, `scrollbar-thumb-bg`, `scrollbar-thumb-hover-bg`,
  `scrollbar-fade-duration`, `scrollbar-fade-easing`,
  `scrollbar-hide-delay`.
- **Tamanhos do shell do app** — `shell-rail-width`, `shell-panel-width`,
  `shell-panel-min-width`, `shell-panel-max-width`.
- **Canvas de chat** — `chat-wallpaper-image`, `chat-wallpaper-position`,
  `chat-wallpaper-size`, `chat-wallpaper-overlay`, `chat-wallpaper-blur`,
  `custom-wallpaper-overlay-alpha`.
- **Métricas tipográficas do chat** — `chat-markdown-column-width`,
  `chat-message-block`, `chat-message-inline`.
- **Controles ajustáveis pelo usuário** — `custom-glass-blur`,
  `custom-ui-opacity`.

## Substituindo Tokens

Um tema substitui qualquer subconjunto dos nomes. Os valores são validados:
devem ser valores CSS seguros e não vazios, e construtos como `{`, `}` e `;`
são rejeitados.

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#e38a62",
      "shadow-card": "0 1px 2px rgba(0, 0, 0, 0.35)"
    }
  }
}
```

Se o usuário escolher um fundo de chat, o aplicativo define uma propriedade
customizada com escopo para a imagem de wallpaper na raiz do workspace;
posição, tamanho, overlay e desfoque permanecem tokens do tema.

## Regras de Resolução

Os tokens são resolvidos nesta ordem, vencendo os últimos:

1. Padrões integrados para o modo ativo.
2. A cadeia de temas pais, raiz primeiro.
3. O próprio tema.

O modo escuro recai nos tokens claros do tema quando não há override escuro,
de modo que um tema apenas-claro ainda funciona no modo escuro. As funções
`resolveTokens` e `buildThemeVariables` em `@neotavern/theme-sdk` implementam isso,
e o host escreve o resultado como variáveis CSS em `document.documentElement`.

## O Que os Componentes Não Podem Fixar

O contrato de estilo proíbe valores fixados em qualquer lugar da interface
integrada, e as mesmas regras se aplicam ao que um tema não deve usar:

- `font-weight` numérico, `font-size` em px e `border-radius` bruto em px.
- Valores numéricos de `z-index` — use os tokens `layer-*`.
- Tamanhos de controles como `40px`, `44px`, `52px`, `32px` e `36px`.
- `!important` em CSS de tema, exceto na camada de preferências de
  acessibilidade.
- Regras de layout: coordenadas, esquemas de grid e flex, breakpoints e ordem
  de áreas não fazem parte do contrato de tokens. Breakpoints vêm do registro
  (`VIEWPORT_BREAKPOINTS` e `CONTAINER_BREAKPOINTS`), e mover áreas de shell
  está fora do escopo da v1.

A geometria de conteúdo, como o esquema de grid de listas de cartões, é uma
exceção explícita: não é coberta pelo contrato de tokens. Tudo o que um tema
precisa para reestilizar está disponível por tokens, hooks e o layout de shell
declarativo. A [Referência do Theme SDK](../../api/theme-sdk/) gerada documenta a
lista exata de `TokenName`.
