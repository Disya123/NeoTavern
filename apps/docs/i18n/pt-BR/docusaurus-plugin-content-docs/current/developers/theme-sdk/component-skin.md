---
title: Skin de Componentes
description: A pilha de estilos para skins de temas, das camadas de cascata aos hooks estáveis.
sidebar_position: 4
---

O nível de skin de componentes reestiliza os componentes integrados. Ele se
baseia em uma pilha de estilos específica e em um contrato de hooks estável.

## A Pilha de Estilos

A interface integrada usa quatro tecnologias juntas:

- **CSS Modules** para estilos com escopo de componente, com nomes de classes
  com hash que explicitamente não são um contrato público.
- **CSS Custom Properties** para os tokens semânticos (`--st-*`).
- **Cascade Layers** para ordenar as fontes de verdade.
- **Container Queries** para layout que se adapta ao próprio contêiner do
  componente, com tamanhos expressos em `rem`.

Temas miram os atributos de hook, nunca os nomes de classes gerados.

## Ordem das Camadas de Cascata

Todos os estilos vivem em uma ordem fixa de camadas de cascata:

```css
@layer reset, tokens, base, components, plugin-base, theme, user;
```

Camadas posteriores vencem as anteriores, de modo que a precedência é:

1. `reset` — o reset base.
2. `tokens` — as definições de tokens.
3. `base` — padrões no nível de elementos.
4. `components` — os estilos dos componentes integrados.
5. `plugin-base` — uma camada para estilos base fornecidos por plugins.
6. `theme` — a skin do tema ativo.
7. `user` — os overrides do próprio usuário, que carregam por último.

A folha de estilo de override do usuário sempre carrega por último, de modo
que um tema quebrado ou opinativo nunca pode impedir o usuário de substituí-lo.
Em termos de `!important`: o construto é proibido em CSS de tema, exceto na
camada de preferências de acessibilidade, que pertence aos modos de
acessibilidade voltados ao usuário.

## O Contrato de Hooks

Temas estilizam componentes por meio de quatro atributos, publicados pelo host
e versionados como o resto do SDK:

```html
<div
  data-component="chat-message"
  data-part="container"
  data-role="assistant"
  data-state="streaming"
></div>
```

- `data-component` — o tipo de componente.
- `data-part` — a parte estrutural dentro de um componente.
- `data-role` — um papel semântico, como um papel de mensagem.
- `data-state` — um estado, como `open`, `closed` ou `streaming`.

O CSS de skin de um tema então se parece com isto:

```css
@layer theme {
  [data-component='button'][data-variant='primary'] > [data-part='icon'] {
    color: var(--st-color-accent-text);
  }

  [data-component='action-bar'] [data-part='group'][data-role='secondary'] {
    color: var(--st-color-text-secondary);
  }
}
```

O pacote `@neotavern/theme-sdk` exporta o helper `dataHook` para construir esses
objetos de atributo, de modo que autores de componentes e autores de temas
concordem nos mesmos nomes.

## O Que Não É um Contrato

- **Nomes de classes gerados por CSS modules** — com hash, instáveis e não
  parte do SDK. Um tema que os mira quebra no próximo build.
- **A hierarquia React interna** — temas não devem depender de internals de
  componentes ou da ordem do DOM além dos hooks documentados.
- **Valores de layout numéricos** — coordenadas, esquemas de grid e
  breakpoints não são estilizáveis pelo contrato de tokens; breakpoints de
  viewport vivem no registro e container queries devem ser escritas em `rem`.

## CSS Proibido

Folhas de estilo de temas são escaneadas antes de carregar. Os construtos
proibidos são rejeitados na instalação e na validação:

- `@import`
- URLs `javascript:` e `expression()`.
- `-moz-binding` e `behavior:`.
- URLs remotas ou relativas a protocolo (`url(http:`, `url(https:`, `url(//`).
- `data:text/html`.
- `!important` (exceto a camada de preferências de a11y).

Isso mantém o CSS de tema puro, local e seguro. Para os tokens que a skin deve
referenciar, veja [Design Tokens](design-tokens.md); para as áreas nomeadas
que uma skin pode reestilizar, veja [Contrato de Shell](shell-contract.md).
