---
title: O Que É o NeoTavern
description: Uma introdução ao NeoTavern, uma plataforma local-first de chat e roleplay com IA.
sidebar_position: 1
---

O NeoTavern é uma plataforma local-first de chat e roleplay com IA que roda no
seu próprio computador. Você cria ou importa personagens, conversa com eles por
qualquer modelo de IA que conectar e mantém cada mensagem, ficha de personagem
e configuração na sua máquina.

## Local-First por Design

- Seus dados vivem em um diretório de dados local no seu computador. Não há
  conta, nem sincronização em nuvem obrigatória, nem telemetria por padrão.
- Você pode navegar pela biblioteca, editar personagens e revisar configurações
  offline. Apenas a geração precisa de um provedor acessível.
- Antes que algo seja enviado a um serviço de IA externo pela primeira vez, o
  aplicativo mostra exatamente qual provedor receberá a solicitação.

## Como Funciona

- O aplicativo de desktop está disponível para Windows, macOS e Linux. Ele
  inclui Node.js e SQLite, então você nunca instala um runtime.
- O aplicativo inicia seu próprio backend local, um sidecar Node.js embutido
  que escuta em `127.0.0.1:8000` por padrão e é encerrado junto com a janela.
- Um PWA responsivo permite que celulares e tablets se conectem a um backend
  rodando no seu PC ou servidor doméstico.

## O Que Você Precisa

- Um sistema operacional de desktop 64 bits compatível. Nenhum terminal, Git ou
  gerenciador de pacotes é necessário em momento algum.
- Um provedor para gerar respostas: um servidor de modelo local ou uma API
  remota com sua chave. O provedor Echo integrado permite verificar todo o
  fluxo offline, sem nenhum serviço externo.
- Opcional, mas útil: um backup de dados existente do SillyTavern para migrar
  seus personagens, chats, lorebooks e personas.

## Para Onde Ir em Seguida

- [Installation](getting-started/installation) — baixe e configure o aplicativo no seu sistema
  operacional.
- [Quick Start](getting-started/quick-start) — conecte um provedor e envie sua primeira
  mensagem.
- [Upgrading](getting-started/upgrading) — como funcionam as atualizações e por que seus dados
  permanecem seguros.
- [Troubleshooting](getting-started/troubleshooting) — correções para problemas comuns de
  instalação e execução.
- [User Guide](user-guide/) — páginas aprofundadas sobre chat, personagens,
  lorebooks, memória, temas e plugins.
- [FAQ](faq) — respostas curtas para perguntas frequentes.
