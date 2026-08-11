---
title: Extensões e Plugins
description: Instalar, ativar, desativar e desinstalar plugins no NeoTavern.
sidebar_position: 9
---

Esta página explica como funcionam os plugins no NeoTavern: onde obtê-los, como
funcionam permissões e consentimento, e como o aplicativo mantém código não
confiável sob controle.

## O Que É um Plugin

Um plugin adiciona comportamento ao NeoTavern — ações de barra de ferramentas,
ações de mensagem, slash commands, interceptores de prompt, painéis
personalizados, atalhos de teclado, rotas de backend ou integrações com
serviços externos. Plugins rodam contra o Plugin SDK estável, não contra as
entranhas do aplicativo, e cada recurso que registram é removido novamente
quando o plugin é desativado.

O catálogo oficial acompanha alguns plugins; pacotes de terceiros são
instalados a partir de um ZIP `.stplugin` ou de um link de repositório Git
público (GitHub ou GitLab, somente HTTPS). O servidor nunca executa Git ou npm:
um link Git é baixado como um arquivo e validado exatamente como um ZIP.

## Instalando um Plugin

Abra a seção Plugins e instale um pacote:

1. Antes da instalação, o aplicativo mostra o autor, versão, fonte,
   compatibilidade, assinatura (quando assinado) e a lista completa de
   permissões.
2. Você revisa e consente explicitamente as permissões. O pacote permanece no
   estado "requer consentimento" até você confirmar cada permissão solicitada.
3. A instalação é atômica: em qualquer erro, a versão anterior permanece
   instalada e funcional.

Se o pacote declarar dependências npm, elas são resolvidas do registro via
HTTPS, verificadas por checksum e nunca executadas — scripts de instalação e
binários nativos são rejeitados de imediato.

## Permissões

Uma permissão no manifesto é uma solicitação de capacidade, não acesso
automático. Antes que um plugin possa ler chats, modificar prompts, tocar seus
arquivos ou acessar a rede, você precisa conceder a permissão correspondente, e
a tela de consentimento descreve o que cada uma faz. Duas regras importam:

- **Novas permissões após uma atualização exigem novo consentimento.** Uma
  atualização nunca pode estender os direitos de um plugin silenciosamente.
- Permissões podem ser revogadas. A revogação vale a partir da próxima chamada
  de capacidade do plugin.

## Gerenciando Plugins

O gerenciador mostra o estado de cada plugin: ativado, desativado, precisa de
permissões, incompatível ou com erro. A partir daí você pode:

- **Ativar ou desativar** um plugin. Desativar remove sua interface, ganchos,
  timers, rotas e assinaturas sem reinicialização, e a limpeza é imposta pelo
  host.
- **Desinstalá-lo**, o que também limpa seus registros.
- **Revisar a compatibilidade** de extensões legadas da era SillyTavern, que
  mostram seu nível de compatibilidade e limitações conhecidas.

Um erro em um plugin é isolado: o aplicativo oferece desativar apenas aquele
plugin em vez de quebrar toda a interface.

## Segurança de Plugins

Plugins de backend não confiáveis rodam em um processo restrito separado, e a
interface de plugin em sandbox roda em um iframe com um canal RPC controlado.
Pacotes de tema não têm acesso a chats, chaves ou arquivos. O modo de segurança
desativa todos os plugins e temas de terceiros e é alcançável antes de eles
carregarem, então qualquer mau comportamento de plugin pode sempre ser
contornado. Veja [Modo de segurança e recuperação](themes) e a documentação do
[Plugin SDK](../developers/plugin-sdk/).
