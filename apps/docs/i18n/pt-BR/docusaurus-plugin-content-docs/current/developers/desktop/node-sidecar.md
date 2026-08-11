---
title: Sidecar Node
description: O backend Fastify como um sidecar Node.js embutido, da inicialização ao encerramento gracioso.
sidebar_position: 3
---

O backend do NeoTavern é um servidor Fastify, e no app desktop ele roda como um
sidecar Node.js embutido: um binário Node.js 24 autocontido empacotado ao lado
do shell.

## Por Que um Sidecar

Empacotar o backend como um processo separado mantém o shell enxuto e o
backend real:

- O backend é o mesmo aplicativo Fastify 5 que uma instalação auto-hospedada
  executa, de modo que o comportamento de desktop e servidor permanece
  idêntico.
- Node.js e SQLite são compilados na distribuição, o que explica por que o
  primeiro uso não precisa de npm install nem de terminal.
- Uma fronteira de processo significa que uma falha ou travamento no backend
  não pode derrubar o loop de eventos do shell, e o shell pode aplicar
  garantias de ciclo de vida.

## Inicialização

No lançamento, o shell inicia o executável do sidecar e espera pela prontidão
antes de abrir a webview. O backend:

- escuta apenas em uma porta livre aleatória em `127.0.0.1`;
- cria o banco de dados SQLite e executa migrações de esquema pendentes no
  diretório de dados, fazendo um backup antes das migrações pendentes;
- serve os ativos web de produção e a API.

O primeiro uso é totalmente automático: diretório de dados, banco de dados,
temas empacotados e o personagem inicial são configurados sem nenhuma
interação do usuário.

## Encerramento Gracioso

O encerramento é cooperativo e ordenado:

1. O shell recebe o evento de fechamento e diz ao backend para parar.
2. O backend para de aceitar novas conexões, termina o trabalho em andamento
   dentro de seu prazo e fecha o banco de dados limpo.
3. O sidecar sai e o shell sai.

Uma terminação inesperada do backend é detectada pelo shell e relatada como
saída de erro, nunca deixada para orfanar silenciosamente um processo de
backend. O app, portanto, nunca deixa um processo `neotavern-server` solto
para trás depois que a janela é fechada.

## Empacotamento e Verificação

O sidecar é construído por plataforma alvo. Addons nativos (`better-sqlite3`,
Sharp) e os ativos web de produção são preparados no mesmo runner alvo e
empacotados com o executável; mover recursos preparados entre sistemas
operacionais não é suportado. Um gate de smoke test executa o sidecar
empacotado headless em cada plataforma no CI, verificando o executável Node
real, SQLite, Sharp, a SPA empacotada, diagnósticos e a ausência de processos
sobrando.

## Variante Portátil

O build portátil Windows executa o mesmo layout de sidecar: o executável
principal, o executável do sidecar, um marcador `portable.flag` e uma pasta
`resources/`. A flag muda a raiz de dados para uma pasta `data/` local ao lado
do aplicativo. O shell normaliza caminhos de recursos do Windows antes de
entregá-los ao binário Node empacotado.

Para os formatos e a experiência de primeiro uso, veja
[Empacotamento](packaging.md); para o shell que gerencia esse processo, veja
[Shell Tauri](tauri-shell.md).
