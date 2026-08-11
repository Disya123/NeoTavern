---
title: Configurações
description: Configurações globais e por chat, perfis de conexão, provedores e chaves de API no NeoTavern.
sidebar_position: 7
---

Esta página explica onde ficam as configurações no NeoTavern e como configurar
provedores, perfis de conexão e chaves de API.

## Onde Ficam as Configurações

O NeoTavern não tem uma página separada de configurações. Tudo abre como um
painel ou modal sobre o workspace de chat, e fechá-lo retorna exatamente ao
mesmo chat e rascunho:

- **Configurações** (na barra de navegação) agrupa opções de todo o aplicativo
  em abas: **Geral** (idioma, escala do texto, tela inicial, estilo da
  mensagem, formato do avatar, acessibilidade), **Temas** (instalar e ativar
  temas) e **Dados** (migração, backups, manutenção de cache, diagnósticos).
- **Configurações de IA** é o painel de contexto da geração. Sua aba **Config**
  contém os parâmetros de solicitação do modelo ativo: tamanho do contexto,
  comprimento da resposta, streaming, amostragem, penalidades, semente e
  raciocínio. A aba **API** gerencia perfis de conexão e chaves, e
  **Avançado** cria modelos personalizados de chat e instrução a partir de
  ChatML, Llama 3 ou Alpaca.

As mudanças de configuração são aplicadas imediatamente quando são facilmente
reversíveis. Opções que diferem dos padrões são marcadas e podem ser
redefinidas individualmente, e a busca de configurações cobre nomes, descrições
e palavras-chave.

## Globais vs. Por Chat

Configurações globais em **Configurações** se aplicam a todo o aplicativo:
idioma, tema, gerenciamento de dados e padrões. O comportamento por chat fica
ao lado do chat: parâmetros de geração, o provedor e modelo ativos e a
estratégia de contexto são editados no painel Configurações de IA enquanto o
chat permanece aberto, e rascunhos e posição de rolagem são preservados. A
persona também é por chat — cada conversa pode usar uma persona diferente
enquanto a persona ativa do aplicativo permanece como padrão.

## Provedores e Perfis de Conexão

Um perfil de conexão reúne tudo o que é necessário para falar com um provedor:
o tipo e a fonte da API, a URL base quando aplicável, a chave de API selecionada
e o modelo. A aba **API** nas Configurações de IA (e a seção Provedores)
permite:

1. Escolher a API de nível superior (Chat Completions ou Text Completions).
2. Escolher uma fonte, que filtra as fontes dessa API e vira o nome do perfil.
3. Digitar a URL base para servidores compatíveis com OpenAI, geralmente
   terminando em `/v1`.
4. Escolher ou digitar um ID de modelo, opcionalmente carregando a lista de
   modelos primeiro.
5. Usar **Testar Conexão** para verificar disponibilidade e latência e, depois,
   **Conectar** para ativar o perfil.

## Chaves de API

As chaves são armazenadas localmente em um gerenciador de chaves que guarda
várias chaves nomeadas por provedor, com uma ativa por vez. Segredos são
verificados antes de salvar e nunca são exibidos por completo depois disso —
apenas um sufixo mascarado permanece visível. Exportações e diagnósticos
excluem segredos por padrão, e erros de provedor são mostrados como mensagens
localizadas com detalhes técnicos e um ID de rastreamento em um bloco
recolhível.

Veja [Themes](themes), [Extensions](extensions) e
[Data & Backups](data-and-backups) para o restante das configurações do
aplicativo.
