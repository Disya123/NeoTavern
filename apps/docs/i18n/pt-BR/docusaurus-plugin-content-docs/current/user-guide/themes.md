---
title: Temas
description: Instalar, trocar e criar temas no NeoTavern, além do modo de segurança.
sidebar_position: 8
---

Esta página explica como funcionam os temas no NeoTavern: o que eles podem
mudar, como instalar e trocar, e como o modo de segurança protege você.

## O Que um Tema Muda

Um tema tem três níveis:

- **Tokens de design** — cores, fontes, espaçamento, raios, sombras e durações
  de animação.
- **Skin de componentes** — a aparência de botões, painéis e outros controles.
- **Layout do shell** — a disposição de regiões nomeadas: navegação, navegador
  de personagens, viewport do chat, painéis laterais e camada de modais.

Isso significa que temas são reformulações visuais completas, não apenas trocas
de cor. Um tema pode reestilizar o aplicativo como um console de jogos, um
visual novel ou um cliente móvel sem mudar nenhuma lógica de chat. Trocar o
tema, a skin de componentes ou o layout do shell nunca exige reinicialização.

## Temas Incluídos

A primeira execução semeia um conjunto de temas integrados, incluindo AMOLED,
GitHub Dark, Matrix, Nord, Gruvbox, Dracula, Tokyo Night e Catppuccin Mocha. O
gerenciador de Temas sempre abre com eles disponíveis, então você pode trocar
de estilo imediatamente.

## Instalando Temas

Um pacote de tema é um arquivo `.sttheme` — um ZIP com um manifesto `theme.json`
e CSS, de até 25 MB. Instale-o pelo gerenciador de Temas:

1. Abra Temas pela barra de navegação ou pela aba Configurações → Temas.
2. Instale o pacote. O servidor valida caminhos, tipos de arquivo, tamanhos e o
   manifesto antes de gravar qualquer coisa, e rejeita caminhos de travessia,
   symlinks e CSS proibido.
3. Pré-visualize o tema antes de aplicá-lo. Pela pré-visualização, você pode
   aceitar o tema, voltar ou abrir suas configurações.
4. Ative-o. A instalação nunca ativa um tema por si só.

Atualizações de um tema instalado o substituem atomicamente e mantêm seu estado
de ativação. Se um tema falhar ao carregar, o shell restaura automaticamente o
último layout funcional.

## Temas Personalizados

Temas são pacotes, não gambiarras: um tema não tem acesso aos seus chats, chaves
de API ou sistema de arquivos. O Theme SDK documenta os ganchos estáveis —
`data-component`, `data-part`, `data-role` e `data-state` — que os temas
estilizam, e o contrato do shell que define as regiões nomeadas. Overrides de
CSS personalizados carregam por último na cascata. Veja a referência do
[Theme SDK](../developers/theme-sdk/) para criar o seu.

## Modo de Segurança e Recuperação

O modo de segurança desativa todos os temas e plugins de terceiros e é
alcançável antes de eles carregarem, então um tema quebrado nunca pode bloqueá-
lo. Após um ciclo de falhas, o aplicativo oferece uma inicialização segura
automaticamente. A ação integrada **Redefinir interface** restaura o tema
padrão sem editar arquivos manualmente, e nenhum tema pode ocultar essa ação.

Veja [Settings](settings) para a aba Geral, onde ficam as opções de tema ativo e
estilo da mensagem.
