---
title: Atalhos de Teclado
description: Os atalhos de teclado padrão do NeoTavern em uma olhada.
sidebar_position: 11
---

Esta página lista os atalhos de teclado padrão do NeoTavern. Todo o aplicativo
é operável pelo teclado, e cada modal mantém o foco dentro de si até você
fechá-lo.

## Compositor

| Ação                              | Atalho                                                |
| --------------------------------- | ----------------------------------------------------- |
| Enviar mensagem                   | `Enter`                                               |
| Inserir uma nova linha            | `Shift+Enter`                                         |
| Abrir a busca do chat             | Focar o campo de busca no cabeçalho do chat           |
| Rolar até a mensagem mais recente | Usar a ação "nova mensagem" depois de rolar para cima |

A dica do compositor sempre mostra o modo atual, então você pode ver
rapidamente se `Enter` envia ou adiciona uma linha.

## Editando Mensagens

| Ação              | Atalho                                              |
| ----------------- | --------------------------------------------------- |
| Salvar a edição   | `Ctrl+Enter` (Windows/Linux) ou `Cmd+Enter` (macOS) |
| Cancelar a edição | `Escape`                                            |

A edição é não destrutiva: o conteúdo anterior é arquivado no histórico de
edições da mensagem, e um conflito mantém seu rascunho em vez de sobrescrevê-lo.
Veja [Chatting](chat).

## Navegação e Painéis

| Ação                                      | Atalho                                                                |
| ----------------------------------------- | --------------------------------------------------------------------- |
| Fechar o painel, diálogo ou menu superior | `Escape`                                                              |
| Mover o foco para frente / para trás      | `Tab` / `Shift+Tab`                                                   |
| Fechar uma superfície ciente de rota      | Voltar do navegador                                                   |
| Redimensionar um painel redimensionável   | `ArrowLeft` / `ArrowRight` com o controle de redimensionamento focado |
| Abrir e fechar o menu de navegação        | O botão de alternância da barra                                       |

`Escape` fecha primeiro a superfície superior: um diálogo aninhado fecha antes
do painel atrás dele, e o foco retorna ao controle que o abriu.

## Ações de Chat

| Ação                                          | Atalho                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| Alternar entre variantes de swipe             | Setas de anterior / próxima no paginador `N/M`                           |
| Abrir um snapshot de checkpoint               | Clicar na bandeira do checkpoint (ou `Shift+Click` para criar um novo)   |
| Excluir ou restaurar uma mensagem manualmente | A ação de exclusão na barra de mensagens (estratégia de contexto manual) |

As ações de mensagem estão sempre visíveis no desktop e agrupadas no cartão
compacto de mensagem no celular; toda ação é um controle focalizável, então
nenhuma ação exige passar o mouse ou um ponteiro.

## Atalhos de Plugins

Plugins registram seus atalhos pelo Plugin SDK, que resolve colisões de forma
que o registro ativo mais recente vence e libera o vínculo quando o plugin é
desativado. Atalhos de plugins nunca interceptam os combos do navegador do
sistema, e a paleta de comandos lista o atalho de cada comando em contexto. Veja
[Extensions & Plugins](extensions).
