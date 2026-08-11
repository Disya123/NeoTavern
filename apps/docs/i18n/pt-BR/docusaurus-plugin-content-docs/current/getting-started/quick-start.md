---
title: Início Rápido
description: Conecte um provedor, escolha um personagem e envie sua primeira mensagem no NeoTavern.
sidebar_position: 3
---

Esta página leva você de uma instalação nova à sua primeira mensagem gerada em
cerca de cinco minutos. Você precisa de um provedor ativo; todo o resto é
opcional.

## 1. Inicie o Aplicativo

Abra o NeoTavern. A tela inicial abre diretamente, e a primeira execução mostra
uma lista de verificação não bloqueante em que você escolhe seu idioma e a
escala do texto. Você pode ignorar a lista e voltar a ela depois — nada aqui
bloqueia a galeria de personagens, importações ou configurações locais.

## 2. Conecte um Provedor

A geração precisa de um provedor: um servidor de modelo local na sua máquina ou
uma API remota. Abra o painel de Configurações de IA ou a seção Provedores:

1. Escolha um tipo de API (por exemplo, Chat Completions) e uma fonte, que
   define o provedor.
2. Digite sua chave de API. As chaves são armazenadas localmente, nunca exibidas
   por completo após salvar e nunca incluídas em exportações por padrão.
3. Opcionalmente, carregue a lista de modelos desse provedor e escolha um
   modelo.
4. Use **Testar Conexão** para verificar disponibilidade e latência e, depois,
   **Conectar** para ativar o perfil.

Ainda não tem provedor? Selecione o provedor **Echo** integrado para testar
todo o pipeline offline. O Echo responde com um eco pronto e não precisa de
chave nem de acesso à rede.

Enquanto nenhum provedor estiver ativo, o botão Enviar fica desabilitado e o
aplicativo mostra o motivo ao lado. Erros de provedor nunca bloqueiam o acesso
à sua biblioteca local.

## 3. Escolha ou Crie um Personagem

Abra a seção Personagens na barra de navegação:

- Navegue pela galeria e abra uma ficha para começar a conversar.
- Importe uma ficha de personagem (PNG ou JSON) do disco.
- Crie um personagem do zero — apenas um nome é necessário.

Veja [Characters](../user-guide/characters) para todos os detalhes.

## 4. Envie Sua Primeira Mensagem

Com um personagem selecionado, o canvas do chat abre com a saudação do
personagem como primeira mensagem do assistente. Digite abaixo e pressione
`Enter` para enviar. O chat é criado no backend apenas depois que você envia
uma primeira mensagem não vazia, então navegar nunca deixa chats vazios para
trás.

A resposta chega em streaming enquanto é gerada. Você pode interrompê-la a
qualquer momento ou rolar pelo histórico enquanto ela chega. Veja
[Chatting](../user-guide/chat) para tudo o que a visualização de chat pode
fazer.

## Próximos Passos

- [Troubleshooting](troubleshooting) se o backend não iniciar ou uma porta já
  estiver em uso.
- [Settings](../user-guide/settings) para ajustar parâmetros de geração e
  perfis de conexão.
- [Data & Backups](../user-guide/data-and-backups) para importar um backup
  existente do SillyTavern ou criar o seu.
