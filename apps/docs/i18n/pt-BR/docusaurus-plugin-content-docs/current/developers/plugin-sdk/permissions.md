---
title: Permissões de Plugin
description: Como as permissões são declaradas e concedidas, e quando uma atualização exige novo consentimento.
sidebar_position: 3
---

Permissões são o mecanismo que permite aos usuários decidir o que um plugin
pode fazer, desde ler o histórico de chat até fazer requisições de rede.

## O Modelo de Permissões

Uma permissão é uma string que nomeia uma capacidade. Declará-la no manifesto
é uma solicitação, não acesso automático: o usuário deve confirmar toda
permissão solicitada antes de o plugin se tornar ativo, e o host aplica a
concessão em cada ponto de uso.

O conjunto integrado é um contrato estável e versionado:

| Permissão            | O que concede                                                        |
| -------------------- | -------------------------------------------------------------------- |
| `chat.read`          | Ler mensagens de chat e seus metadados                               |
| `chat.write`         | Criar ou modificar mensagens de chat                                 |
| `characters.read`    | Ler personagens e fichas de personagem                               |
| `characters.write`   | Criar ou modificar personagens                                       |
| `lorebook.read`      | Ler entradas de lorebook                                             |
| `lorebook.write`     | Criar ou modificar entradas de lorebook                              |
| `prompt.inspect`     | Inspecionar o prompt montado                                         |
| `prompt.modify`      | Modificar o prompt ou pós-processar a saída da geração               |
| `providers.register` | Registrar adaptadores e tokenizadores de provedores                  |
| `ui.toolbar`         | Adicionar ações de barra de ferramentas                              |
| `ui.sidebar`         | Adicionar painéis de barra lateral                                   |
| `ui.messageActions`  | Adicionar ações de mensagem                                          |
| `ui.shell`           | Adicionar conteúdo a slots do shell                                  |
| `clipboard.read`     | Ler a área de transferência                                          |
| `clipboard.write`    | Escrever na área de transferência                                    |
| `notifications`      | Mostrar notificações                                                 |
| `server.routes`      | Montar rotas de backend                                              |
| `legacy.trusted`     | Executar código legado SillyTavern documentado no contexto confiável |

## Permissões com Escopo

Algumas permissões carregam um escopo, escrito como `kind:scope`:

- **`network:<hostname>`** — permissão para buscar de um host específico, por
  exemplo `network:api.example.com`. Requisições a hosts não concedidos são
  rejeitadas.
- **`network:*`** — um curinga que permite buscar de qualquer host. O host o
  trata como acesso total à rede e a interface de consentimento o mostra com
  um aviso reforçado. Prefira listar hosts concretos; publicar plugins que
  solicitam o curinga é desencorajado.
- **`files:plugin`** — ler e escrever dentro do diretório de dados do próprio
  plugin.
- **`files:user-selected`** — acesso a arquivos que o usuário selecionou
  explicitamente.

`hasPermission` verifica um conjunto concedido contra uma permissão
necessária, e `parsePermission` divide uma string `kind:scope` em suas
partes. A função `validatePermissions` rejeita strings malformadas como
permissões vazias, duplicadas ou desconhecidas.

## Como as Concessões São Aplicadas

Declarar uma permissão não é suficiente; o host aplica a concessão no ponto de
aplicação:

- Registros de interface verificam permissões `ui.*` antes de montar.
- Rotas verificam `server.routes`.
- O `fetch` verificado por permissões verifica `network:<host>`.
- O sistema de arquivos virtual verifica `files:*`.
- APIs de provedores e de contexto verificam `providers.register` e
  `prompt.modify`.

O kernel de capacidades (namespace `kernel` de `@neotavern/plugin-sdk`) é a camada
compartilhada que verifica concessões tanto no host web quanto no servidor,
de modo que o navegador e o backend sempre veem os mesmos direitos efetivos.
As concessões são armazenadas com uma revisão monotônica, entregues à sandbox
durante o handshake de bootstrap e revogáveis em runtime. Operações em
andamento são concluídas com um erro `CAPABILITY_REVOKED` e handles abertos
são fechados pelo host.

## Consentimento e Novo Consentimento em Atualizações

A instalação mostra a lista completa de permissões solicitadas. O plugin
permanece no estado `needs-consent` até você confirmar toda permissão, e a
interface mostra a lista de dependências quando o pacote traz dependências
npm.

Atualizar um plugin é uma nova instalação para a verificação de permissões: o
host calcula a diferença entre o manifesto anterior e o novo com
`diffPermissions`. Se a atualização adiciona permissões:

- o runtime do plugin é desativado imediatamente;
- o usuário é solicitado a consentir com as novas permissões;
- o plugin permanece desativado até que o consentimento seja dado.

Remover permissões nunca exige consentimento. A regra geral: o conjunto de
permissões concedidas nunca cresce sem uma decisão explícita do usuário. Para
a lista completa de constantes e auxiliares de permissões, veja a
[Referência do Plugin SDK](../../api/plugin-sdk/) gerada.
