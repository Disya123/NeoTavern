---
title: Solução de Problemas
description: Correções para problemas comuns de instalação e inicialização do NeoTavern.
sidebar_position: 5
---

Esta página responde a problemas comuns de instalação e execução em formato de
perguntas e respostas. Se o seu problema não estiver listado, colete as linhas
de log relevantes e abra uma issue no
[repositório do GitHub](https://github.com/Disya123/NeoTavern).

## Por que o aplicativo diz que a porta já está em uso?

O backend local escuta em `127.0.0.1:8000` por padrão. Se outro programa ocupar
essa porta, o sidecar não consegue iniciar. Feche o programa conflitante ou
inicie o servidor com uma porta diferente definindo `NEOTA_PORT` no ambiente. A
mensagem de erro no aplicativo inclui o número da porta e os detalhes
necessários para resolver o conflito.

## O sidecar do backend não inicia

O aplicativo de desktop executa seu backend como um sidecar Node.js embutido.
Se ele falhar ao iniciar, a janela do aplicativo mostra um erro de conexão.
Verifique o seguinte:

- Outra instância do NeoTavern pode já estar em execução e segurando a porta.
- O diretório de dados pode não ser gravável no local atual.
- Um antivírus ou firewall pode estar bloqueando o runtime Node embutido.

Reinicie o aplicativo depois de resolver a causa. Se o aplicativo entrar em um
ciclo de falhas, ele oferece uma inicialização em modo de segurança que
desativa plugins e temas de terceiros antes que carreguem — use-a para se
recuperar.

## O banco de dados está bloqueado

O NeoTavern usa SQLite com modo WAL e um tempo limite de espera, então o acesso
concorrente breve é esperado e tratado. Um erro persistente de "banco de dados
bloqueado" geralmente significa que uma segunda instância do aplicativo abriu o
mesmo diretório de dados, ou que uma operação de backup ou importação ainda
está em execução. Feche instâncias duplicadas e aguarde as operações longas
terminarem antes de tentar novamente.

## Como limpo os caches?

Os caches ficam em `data/cache/` e são totalmente regeneráveis: miniaturas,
dados de tokenizador e downloads de dependências de plugins. Limpar um cache
nunca apaga seus arquivos originais, que são armazenados separadamente em
`data/files/`. Use os controles de manutenção em Configurações → Dados para
limpar caches e reconstruir o índice de pesquisa de texto completo. Ambas as
ações confirmam a quantidade e o tamanho do que será removido antes de fazer
qualquer coisa.

## Onde ficam os logs?

Os logs são gravados em `data/logs/server.log`, com rotação a cada 10 MB. O
arquivo de log é editado para remover dados sensíveis: segredos, chaves de API
e o conteúdo das mensagens dos usuários nunca são registrados. A saída do
console é mantida junto com o arquivo. Ao reportar um bug, inclua as linhas de
log relevantes e o ID de rastreamento mostrado nos detalhes do erro.

## Como volto a uma interface funcional?

Use o modo de segurança: ele é alcançável antes de temas e plugins de terceiros
carregarem e os desativa. Depois de um tema ou plugin quebrado, o modo de
segurança restaura a interface integrada sem editar arquivos manualmente. Veja
[Themes](../user-guide/themes) e [Extensions](../user-guide/extensions) para
detalhes.

## Por que o botão Enviar está desabilitado?

O botão fica desabilitado apenas quando há um motivo concreto, explicado ao
lado — na maioria das vezes, nenhum provedor ativo ou nenhum personagem
selecionado. Conecte um provedor nas Configurações de IA ou escolha um
personagem, e o botão fica disponível. Veja [Quick Start](quick-start).
