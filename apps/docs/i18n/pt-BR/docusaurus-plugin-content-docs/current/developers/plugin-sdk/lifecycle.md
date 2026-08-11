---
title: Ciclo de Vida do Plugin
description: Como os plugins passam da instalação ao consentimento, à ativação e ao teardown.
sidebar_position: 6
---

Um plugin passa por um ciclo de vida definido: instalação, consentimento,
ativação, ativo e, por fim, teardown. Cada transição é aplicada pelo host.

## Instalação

A instalação acontece pelo Gerenciador de Plugins. Você pode instalar um
arquivo ZIP `.stplugin` limitado ou um link de repositório público
(`github.com` ou `gitlab.com`, apenas HTTPS). O host nunca invoca o binário
git; ele baixa um arquivo do repositório e o submete exatamente à mesma
validação de um ZIP: path traversal, symlinks, payloads executáveis,
tamanhos, campos do manifesto, pontos de entrada e permissões. A instalação é
atômica e reverte em qualquer erro.

Se o pacote traz um `package.json` com dependências, o resolvedor integrado as
busca no registro npm sem executar scripts de instalação. Empacote suas
dependências quando possível; o resolvedor existe para bibliotecas WASM
pesadas que não podem ser razoavelmente empacotadas.

## Consentimento

Após a validação, o plugin entra no estado `needs-consent`. Ele permanece lá
até o usuário confirmar toda permissão solicitada (e revisar a lista de
dependências npm quando houver uma). Nenhum ponto de entrada roda durante
essa fase. Veja [Permissões](permissions.md) para o modelo completo.

## Ativação

A ativação é uma operação em duas fases:

1. Registros de backend e legados começam primeiro.
2. A entrada de frontend carrega e recebe sua API.

Se a ativação falhar no meio do caminho, o host reverte os registros parciais
e registra uma falha de carregamento. Uma ativação com falha nunca deixa
superfícies meio registradas para trás.

## Runtime Ativo

Enquanto ativo, todo registro que o plugin faz — superfícies de interface,
rotas, inscrições de eventos, recursos i18n, notificações, provedores,
tokenizadores, estratégias de contexto e pós-processadores — é coletado pelo
runtime. O plugin também pode gerenciar seus próprios recursos em
`deactivate()`.

## Teardown

Desativação, modo de segurança, exclusão, uma falha ou o encerramento do
aplicativo disparam a limpeza aplicada pelo host. O runtime descarta os
registros coletados em ordem reversa, e as garantias são estritas: depois que
um plugin é desativado, nada permanece.

- Nenhum handler ou inscrição de evento.
- Nenhum timer.
- Nenhum nó de DOM.
- Nenhuma rota montada.
- Nenhuma requisição em segundo plano.
- Nenhum provedor, tokenizador ou estratégia registrado.

Um erro lançado pelo próprio `deactivate()` do plugin não cancela a limpeza
necessária — o host ainda descarta tudo o que rastreia. O teardown é
idempotente: chamá-lo duas vezes não tem efeito.

## Atualização

Atualizar substitui o pacote atomicamente e mantém o estado de ativação
atual, com uma exceção: se o novo manifesto adiciona permissões, o runtime é
desativado imediatamente e permanece desativado até o usuário consentir com as
novas permissões. Reverter para uma versão anterior é feito instalando essa
versão novamente; os dados do usuário no armazenamento do plugin sobrevivem em
ambas as direções.

## Tratamento de Falhas

Um plugin de backend roda em seu próprio processo. Se esse processo falhar, o
host remove todos os registros do plugin e relata a falha. Um plugin que
falhou não pode deixar rotas órfãs ou inscrições de eventos, porque elas são
de propriedade do host, não do processo.

Para o modelo de segurança que torna essas garantias possíveis, veja
[Sandboxing](sandboxing.md). Para os campos do manifesto que dirigem o ciclo
de vida, veja [Manifesto](manifest.md).
