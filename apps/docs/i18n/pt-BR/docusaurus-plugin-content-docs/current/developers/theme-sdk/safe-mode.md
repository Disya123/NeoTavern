---
title: Modo de Segurança
description: Como o modo de segurança desativa temas e plugins de terceiros, e por que o reset sempre funciona.
sidebar_position: 6
---

O modo de segurança é o mecanismo de recuperação da camada visual: ele
desativa temas e plugins de terceiros para que a interface sempre retorne a um
estado funcional.

## O Que o Modo de Segurança Faz

O modo de segurança é ativado com `?safe=1` na URL. Ele é tratado antes de
qualquer código de pacote carregar:

- CSS de temas de terceiros e overrides de tokens não são adicionados ao
  documento.
- Pontos de entrada de plugins de terceiros nunca rodam, incluindo pontos de
  entrada legados.
- O tema integrado e o runtime de plugin integrado permanecem ativos.

A interface recai nos tokens claro e escuro integrados, que estão sempre
presentes. Sair do modo de segurança restaura o estado ativo salvo
anteriormente de temas e plugins — sair não muda sua seleção.

## Por Que um Tema Quebrado Não Pode Bloquear a Recuperação

Várias garantias protegem o usuário de um tema quebrado:

- **Pré-visualização antes de aplicar** — temas são pré-visualizados antes da
  ativação, e instalar um pacote nunca o ativa automaticamente.
- **O modo de segurança é pré-pacote** — `?safe=1` é processado antes de o
  registro de temas ser consultado, de modo que mesmo um tema cujo CSS derruba
  o renderizador nunca é carregado.
- **O botão de reset** — a ação de reset retorna o tema integrado, remove
  links CSS de runtime e limpa overrides inline `--st-*`. Excluir o tema ativo
  também redefine a seleção de tema salva.
- **Temas não podem esconder as Configurações** — a trilha de navegação sempre
  mantém o item Configurações acessível, porque itens de sistema omitidos são
  restaurados na ordem padrão. No modo de segurança, a ordem de trilha
  integrada é usada e o menu-toggle permanece disponível.
- **Sem execução de código** — temas não contêm JavaScript de forma alguma.
  São CSS, tokens e layout declarativo, de modo que não há código de tema que
  pudesse rodar antes de o modo de segurança fazer efeito.

## Restrições de Pacotes de Tema

Um pacote de tema nunca recebe acesso a chats, chaves de API ou ao sistema de
arquivos. Suas folhas de estilo são validadas contra construtos proibidos
(`@import`, URLs remotas, URLs `javascript:`, `expression()`, `!important` e
outros) antes de serem aceitas, e seus tokens devem ser valores CSS seguros.
Não há ponto de entrada executável no Theme SDK.

## Modo de Segurança para Plugins

O mesmo interruptor desativa plugins de terceiros. As sandboxes de plugins, o
isolamento de processos e a limpeza aplicada pelo host são a camada de
runtime; o modo de segurança é o interruptor de cinto-e-suspensório que
impede que código não confiável carregue em primeiro lugar. Veja
[Sandboxing de plugins](../plugin-sdk/sandboxing.md) para os detalhes do lado
dos plugins.

## Verificando o Modo de Segurança Programaticamente

O pacote `@neotavern/theme-sdk` exporta `getSafeModeFromSearch(search)`, que analisa
a string de busca da URL e retorna se `?safe=1` está presente. O host a usa
como o único gate antes de carregar CSS de pacote e overrides de tokens, e a
mesma função está disponível para hosts alternativos.

Para as áreas de shell que permanecem disponíveis no modo de segurança, veja
[Contrato de Shell](shell-contract.md).
