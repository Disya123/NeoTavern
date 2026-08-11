---
title: Shell Tauri
description: O shell nativo Tauri 2 e como fechar a janela para o backend.
sidebar_position: 2
---

O shell desktop é construído sobre o Tauri 2. Ele é dono da janela nativa,
inicia o backend e garante que os dois sejam encerrados juntos.

## O Trabalho do Shell

O shell faz três coisas:

1. **Inicia o sidecar** — ele inicia o processo de backend Node.js
   autocontido e espera até a API local estar pronta antes de abrir a webview.
   Você nunca vê uma janela meio carregada apontando para um servidor morto.
2. **Hospeda a webview** — o app web de produção roda dentro da webview do
   Tauri e fala com o backend por `127.0.0.1` em uma porta livre aleatória.
3. **É dono do ciclo de vida** — eventos de janela e eventos de processo são
   conectados para que backend e shell sempre saiam como uma unidade.

## Ciclo de Vida da Janela

- **Fechar** — fechar a janela dispara um encerramento gracioso do sidecar. O
  backend é solicitado a parar limpo, e o app espera por ele antes de sair.
  Nenhum processo Node.js órfão é deixado para trás.
- **Falha do backend** — se o sidecar sair inesperadamente, o shell termina
  com um erro em vez de mostrar uma janela que não pode fazer nada. Saídas
  normais são marcadas separadamente, de modo que um encerramento limpo nunca
  é confundido com uma falha.
- **Reiniciar** — iniciar o app novamente reinicia o sidecar do zero. O estado
  vive no diretório de dados, não no processo, de modo que reinicializações
  não perdem nada.

## A Janela É a API

Como o shell espera pela API antes de mostrar conteúdo, o primeiro lançamento
parece imediato: a janela abre em um aplicativo pronto. O backend escuta
apenas em `127.0.0.1` em uma porta efêmera, de modo que nada é exposto à rede.

## Integração com o Updater

Builds de release integram o updater do Tauri. O shell pode verificar
atualizações do núcleo, verificar o manifesto e a assinatura minisign, instalar
o artefato da plataforma e reiniciar. O updater substitui o núcleo
separadamente do diretório de dados do usuário, e downgrades não assinados são
rejeitados. Builds feitos sem um endpoint de atualização e chave pública são
totalmente funcionais, mas relatam que atualizações não estão configuradas.

## Builds de Desenvolvimento

Para desenvolvimento, o mesmo shell pode rodar contra um servidor de dev e um
backend iniciado localmente. A garantia de produção — o sidecar sai com a
janela — aplica-se a builds empacotados; `pnpm desktop:dev` conecta o shell aos
seus processos de dev em execução.

Para saber como o sidecar é empacotado e gerenciado, veja
[Sidecar Node](node-sidecar.md).
