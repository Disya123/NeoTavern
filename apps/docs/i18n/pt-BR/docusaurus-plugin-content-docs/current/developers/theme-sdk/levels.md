---
title: Níveis de Tema
description: Os três níveis de tematização — tokens, skin de componentes e layout de shell.
sidebar_position: 2
---

Um tema é construído a partir de três níveis independentes. Entender a
separação é o que permite a um tema mudar a aparência de todo o aplicativo sem
tocar em seu comportamento.

## Nível 1: Design Tokens

Tokens são propriedades customizadas CSS semânticas prefixadas com `--st-`.
Eles cobrem cores, tipografia, espaçamento, raios, bordas, sombras, camadas de
z-index, movimento, tamanhos de controles, barras de rolagem e o canvas de
chat.

Componentes referenciam apenas tokens — eles nunca fixam um valor de cor,
fonte ou espaçamento. Substituir um token no manifesto do tema reestiliza todo
componente que o usa:

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#ff00aa",
      "font-ui": "'Atkinson Hyperlegible', system-ui, sans-serif"
    }
  }
}
```

Tokens são resolvidos por uma cadeia de herança: padrões integrados para o
modo, depois temas pais, depois o próprio tema. Um modo escuro recai nos
tokens claros do tema quando não há override escuro. Veja
[Design Tokens](design-tokens.md) para o contrato completo.

## Nível 2: Skin de Componentes

A skin de componentes é CSS que reestiliza os componentes integrados por meio
de hooks estáveis. O host publica atributos `data-component`, `data-part`,
`data-role` e `data-state`; um tema estiliza esses atributos, nunca nomes de
classes gerados por CSS modules:

```css
@layer theme {
  [data-component='button'][data-variant='primary'] {
    background: var(--st-color-accent);
  }
}
```

A skin é aplicada por camadas de cascata em ordem fixa, com a camada de
override do usuário por último. `!important` é proibido em CSS de tema, exceto
na camada de preferências de acessibilidade. Veja
[Skin de Componentes](component-skin.md) para a ordem das camadas e a
referência de hooks.

## Nível 3: Layout de Shell

O layout de shell é a composição das áreas principais: a trilha de navegação,
os painéis de gerenciamento e o workspace de chat. Ele é declarativo, expresso
em `theme.json` — nunca em JavaScript:

```json
{
  "shellLayout": {
    "navigationRail": {
      "main": [
        "menu-toggle",
        "chats",
        "characters",
        "personas",
        "lorebooks",
        "backgrounds",
        "ai-settings",
        "plugins"
      ],
      "bottom": ["settings"]
    }
  }
}
```

Itens de trilha válidos são `chats`, `characters`, `personas`, `lorebooks`,
`backgrounds`, `ai-settings`, `plugins`, `settings` e o opcional
`menu-toggle`. O grupo `main` flui do topo; `bottom` é fixado à borda
inferior. Itens que você omite são adicionados de volta na ordem padrão, de
modo que um tema não pode esconder acidentalmente as Configurações e travar o
usuário fora da recuperação.

## Imitando Outras Interfaces

Como os níveis são independentes, um tema pode imitar um paradigma de
interface completamente diferente:

- Um tema estilo console muda tokens e skins, fazendo a trilha, os painéis e
  os botões parecerem uma interface de jogo.
- Um tema de visual novel reestiliza o viewport de chat, as mensagens e o
  cabeçalho do personagem enquanto a lógica de chat permanece intacta.
- Um tema estilo app mobile usa o layout de shell declarativo para reordenar a
  trilha e os painéis.

Nenhum deles exige tocar na lógica de chat, nos dados ou no comportamento de
plugins — que é exatamente por que a superfície de tema pode ser substituída
por completo. A única coisa que a v1 não fornece é rearranjo livre das áreas
de shell; slots são estilizados e preenchidos, não movidos. Veja
[Contrato de Shell](shell-contract.md) para o que está no escopo.
