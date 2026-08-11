---
title: Chat
description: Como funciona o chat no NeoTavern — streaming, swipes, regenerar, editar e parar.
sidebar_position: 2
---

Esta página cobre a visualização de chat: compor e enviar mensagens, ver as
respostas chegarem em streaming e trabalhar com as ações de mensagem que o
NeoTavern oferece.

## Enviando Mensagens

O compositor fica na parte inferior do canvas do chat. Digite uma mensagem e
pressione `Enter` para enviar; pressione `Shift+Enter` para uma nova linha. Sua
mensagem aparece instantaneamente, e a resposta chega em streaming à
visualização em lotes de no máximo 30 atualizações de interface por segundo.
Você pode rolar pelo histórico enquanto uma resposta chega — a rolagem
automática só o segue enquanto você permanece no fim, e uma ação "nova
mensagem" aparece depois que você rola para cima manualmente.

Enquanto uma resposta está sendo gerada, o botão principal do compositor vira
**Parar**. Parar mantém o texto recebido até então como uma resposta incompleta
explicitamente marcada. Uma conexão perdida oferece reconexão e nunca cria uma
mensagem duplicada.

Seu rascunho é salvo por chat, então alternar para outro chat e voltar nunca
perde o que você estava digitando.

## Swipes (Mensagens Alternativas)

Cada mensagem do assistente pode conter várias respostas alternativas, chamadas
de swipes. Um paginador sob a mensagem mostra a contagem como `N/M` com setas
de anterior e próxima; clicar nas setas percorre as variantes sem perder
nenhuma delas. O histórico de swipes é preservado e não destrutivo.

## Regenerar

A ação regenerar reescreve a **última** mensagem do assistente no lugar: uma
nova resposta chega em streaming ao balão existente, e o texto anterior vira
outra variante no paginador de swipes. Se a geração falhar ou for interrompida,
o texto antigo permanece intacto no disco.

## Editando Mensagens

Abra a ação de edição em uma mensagem para alterar seu texto. O editor embutido
salva com `Ctrl+Enter` (ou `Cmd+Enter` no macOS) e cancela com `Escape`. As
edições são não destrutivas: o conteúdo anterior é arquivado no histórico de
edições da mensagem, de onde você pode restaurá-lo a qualquer momento. Se a
mensagem mudou em outro lugar enquanto você editava, o editor mantém seu
rascunho e mostra um aviso de conflito em vez de sobrescrever silenciosamente.

## Ações de Mensagem

A barra de ações em cada mensagem está sempre visível, não apenas ao passar o
mouse:

- Copiar o texto bruto da mensagem.
- Editar a mensagem.
- Regenerar a última resposta do assistente.
- Percorrer as variantes com swipes.
- Criar um **checkpoint** ou **branch**: um snapshot do chat congelado naquela
  mensagem, copiado para um chat filho. Use checkpoints para explorar linhas de
  história sem tocar na conversa principal.
- Excluir a mensagem. A exclusão move chats para um estado de lixeira em vez de
  destruí-los instantaneamente.

Plugins podem adicionar suas próprias ações à mesma barra, sujeitas às
permissões que você concedeu. Veja [Extensions](extensions).

## Controle pelo Teclado

Todo o fluxo de chat funciona pelo teclado: `Tab` e `Shift+Tab` movem o foco,
`Escape` fecha o painel ou diálogo superior, e o paginador de swipes, os links
de checkpoint e as ações de mensagem são todos controles focalizáveis. Veja
[Keyboard Shortcuts](keyboard-shortcuts) para a lista completa.
