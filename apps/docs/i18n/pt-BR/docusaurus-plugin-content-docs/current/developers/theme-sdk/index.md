---
title: Visão Geral do Theme SDK
description: 'O que é o Theme SDK: uma substituição completa do shell visual, nível por nível.'
sidebar_position: 1
---

O Theme SDK é o contrato versionado para substituir todo o shell visual do
NeoTavern — não apenas recolorir.

## O Que É o Theme SDK

Um tema é um pacote (`.sttheme`) que controla a aparência do aplicativo e como
suas áreas principais são compostas. Diferente de um plugin, um tema não tem
JavaScript: é CSS, tokens semânticos e um layout de shell declarativo em um
manifesto. Como o SDK é declarativo, um tema não pode quebrar o comportamento
do aplicativo nem alcançar seus dados.

O pacote `@neotavern/theme-sdk` fornece o contrato em si: os nomes canônicos de
tokens, validação de manifesto, resolução de herança e geração de variáveis
CSS. A implementação de referência do host aplica um tema escrevendo
propriedades customizadas `--st-*` na raiz do documento e carregando as
folhas de estilo do tema em uma ordem definida.

## Os Três Níveis

A tematização é estruturada em três níveis, e um tema pode usar qualquer um
deles:

1. **Design tokens** — variáveis semânticas para cores, fontes, espaçamento,
   raios, sombras, camadas de z-index, movimento e tamanhos de controles.
   Componentes referenciam exclusivamente esses tokens, de modo que
   substituir um token reestiliza toda a interface de forma consistente.
2. **Skin de componentes** — CSS que reestiliza componentes por meio dos hooks
   estáveis `data-component`, `data-part`, `data-role` e `data-state`.
3. **Layout de shell** — composição declarativa das áreas principais: a trilha
   de navegação, os painéis de gerenciamento e o workspace de chat.

Como a lógica de chat, o modelo de dados e o comportamento ficam intocados,
um tema pode imitar um sistema operacional, um console de jogos, uma interface
de visual novel ou um layout de app mobile sem quebrar nenhum recurso. Veja
[Níveis](levels.md) para os detalhes.

## Escrever sem Etapa de Build

Um tema é um ZIP com `theme.json`, `components.css` e `shell.css`. Você pode
criar um à mão:

1. Abra o gerenciador de Temas e baixe o kit de início de tema.
2. Descompacte-o e edite `theme.json`, `components.css` e `shell.css`.
3. Recompacte os arquivos na raiz do arquivo e instale o pacote.
4. Verifique os modos claro e escuro, mobile, foco de teclado, RTL e modo de
   segurança, e então aplique o tema.

Nenhum Node.js, npm, JavaScript ou CLI do Theme SDK é necessário para um
primeiro tema.

## Instalação e Ativação

Instalar um pacote não o ativa. A ativação valida toda a cadeia `extends`
quanto a pais ausentes e ciclos e, em seguida, atualiza o tema ativo e a
seleção de tema salva em uma única transação. Atualizar um pacote com o mesmo
id substitui atomicamente seu diretório e mantém o estado de ativação atual;
em um erro de registro, o diretório anterior é restaurado.

A distribuição traz um conjunto de temas integrados, como AMOLED, GitHub Dark,
Matrix, Nord, Gruvbox, Dracula, Tokyo Night, Catppuccin Mocha, Solarized Dark
e One Dark, de modo que o gerenciador de Temas nunca abre vazio.

## Segurança

Temas não podem ler chats, chaves de API ou o sistema de arquivos, e não
contêm código executável. Toda folha de estilo é escaneada em busca de
construtos proibidos, e o modo de segurança desativa temas de terceiros
inteiramente. Veja [Modo de Segurança](safe-mode.md) para as garantias, e a
[Referência do Theme SDK](../api/theme-sdk/) gerada para a API completa.

## Próximos Passos

- [Níveis](levels.md) — tokens, skins e layouts de shell.
- [Design Tokens](design-tokens.md) — o contrato de tokens semânticos.
- [Skin de Componentes](component-skin.md) — a pilha de estilos e os hooks.
- [Contrato de Shell](shell-contract.md) — áreas nomeadas e slots estáveis.
- [Modo de Segurança](safe-mode.md) — recuperação de temas quebrados.
