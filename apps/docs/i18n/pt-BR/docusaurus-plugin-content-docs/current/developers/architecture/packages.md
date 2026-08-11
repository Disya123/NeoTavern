---
title: Pacotes
description: >-
  A responsabilidade de cada pacote do workspace e a direção das dependências
  que mantém o monorepo livre de ciclos.
sidebar_position: 4
---

Cada pacote do workspace tem exatamente uma responsabilidade, e dependências
apontam apenas para baixo, o que mantém o monorepo livre de ciclos.

## Direção das Dependências

O código só pode depender de pacotes "abaixo" dele:

```text
apps (server, web, desktop, plugin-runtime)
  → packages
  → shared, contracts (o piso)
```

`server` e `web` dependem de pacotes; pacotes dependem no máximo de `shared` e
`contracts`. Dependências cíclicas são proibidas. Ao adicionar código novo,
coloque-o no pacote mais restrito que possa hospedá-lo: utilitários
compartilhados vão para `@neotavern/shared`, formatos de API vão para `@neotavern/contracts`,
e qualquer coisa relacionada a banco de dados vai para `@neotavern/db`.

## Responsabilidades dos Pacotes

- `@neotavern/shared` — utilitários isomórficos com zero dependências de runtime: IDs
  UUIDv7, `Result`, o envelope `AppError`, um logger estruturado com remoção de
  segredos, utilitários de timeout e sinal, e macros de prompt.
- `@neotavern/contracts` — esquemas TypeBox para cada entrada e saída de API. A fonte
  única de verdade compartilhada por servidor e web; nunca duplicada
  manualmente.
- `@neotavern/db` — SQLite: o esquema Drizzle, migrações, repositórios e busca FTS5.
  O único pacote que fala com o banco de dados.
- `@neotavern/ui` — componentes base headless construídos sobre primitivas Radix,
  tokens de design e os ganchos `data-*` em que os temas dependem.
- `@neotavern/i18n` — configuração do i18next, namespaces, recursos `en` e `ru` e o
  localizador de códigos de erro que mapeia códigos de erro de máquina para
  texto localizado.
- `@neotavern/plugin-sdk` — o Plugin SDK versionado: esquema de manifesto, permissões
  e concessões de capacidade, e os contratos de API de frontend e backend
  contra os quais os plugins compilam.
- `@neotavern/theme-sdk` — o Theme SDK: esquema de manifesto, os níveis
  token/componente/shell e a resolução de herança.
- `@neotavern/provider-sdk` — o contrato unificado de adaptador de provedor, além dos
  adaptadores integrados para provedores de LLM, TTS, STT e imagem, e o
  registro de adaptadores.
- `@neotavern/legacy-compat` — a camada de compatibilidade legada: globais de
  `window`, o barramento de eventos e ilhas DOM não gerenciadas para scripts da
  era SillyTavern.
- `@neotavern/gestures` — gestos de linha agnósticos de framework: menus de contexto
  (clique direito e toque longo) e reconhecimento de reordenação por arrastar e
  soltar.
- `@neotavern/plugin-build` — o pipeline de build e publicação de plugins: analisar,
  assinar e construir pacotes de plugins.

## O Que Vive Onde

- **Formatos de API** sempre vêm de `@neotavern/contracts`. Backend e frontend nunca
  declaram o mesmo tipo duas vezes.
- **Acesso ao banco de dados** acontece apenas pelos repositórios de `@neotavern/db`.
  Código de plugin nunca recebe uma conexão SQLite.
- **Comportamento de provedor** vive nos adaptadores de `@neotavern/provider-sdk`. O
  núcleo do servidor não é acoplado ao SDK de nenhum provedor, com uma exceção
  documentada: o adaptador Anthropic usa o SDK oficial para superfícies beta.
- **Blocos de construção de interface** vêm de `@neotavern/ui`; telas de aplicativo os
  compõem. Gestos agnósticos de framework ficam em `@neotavern/gestures` para poderem
  ser reutilizados fora do React.

## Adicionando um Pacote

Um pacote novo precisa de um `README.md` que declare seu propósito, pontos de
entrada públicos, dependências e restrições — documentação faz parte da
implementação. Antes de criar um, verifique se o código cabe em um pacote
existente; a resposta padrão é nenhum pacote novo.
