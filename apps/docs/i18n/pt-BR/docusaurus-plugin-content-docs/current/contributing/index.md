---
title: Contribuindo com o NeoTavern
description: Como contribuir com o NeoTavern — issues, código, documentação e traduções
sidebar_position: 1
---

O NeoTavern é um projeto aberto, e contribuições de todos os tipos são
bem-vindas: relatos de bugs, pedidos de recursos, código, documentação e
traduções.

## Formas de Contribuir

- **Relate bugs e peça recursos.** Abra uma issue no GitHub com a versão, seu
  SO e passos para reproduzir:
  [https://github.com/Disya123/NeoTavern/issues](https://github.com/Disya123/NeoTavern/issues)
- **Escreva código.** Escolha uma issue, comente nela e abra um pull request.
  Mantenha as mudanças pequenas e siga as
  [Diretrizes de Código](contributing/code-guidelines).
- **Melhore a documentação.** O site público fica em `apps/docs`; veja
  [Site de Documentação](contributing/docs-site).
- **Traduza.** Ajude com um dos oito locais ou proponha um novo; veja
  [Traduções](contributing/translations).

## Código de Conduta

Trate outros contribuidores com respeito. Seja construtivo em reviews e
issues, presuma boa fé e mantenha a discussão focada no trabalho. O
[AGENTS.md](https://github.com/Disya123/NeoTavern/blob/main/AGENTS.md) do
repositório é a descrição autoritativa de como o projeto é construído e como
as tarefas são concluídas; leia-o antes da sua primeira mudança.

## Antes de Começar

- Leia primeiro a [Configuração de Desenvolvimento](contributing/development-setup) e as
  [Diretrizes de Código](contributing/code-guidelines), além do AGENTS.md linkado acima.
- Procure uma issue existente cobrindo o que você quer fazer e comente antes
  de começar um trabalho grande, para que os mantenedores possam dar feedback
  cedo.
- Mantenha pull requests focados: uma mudança lógica por PR, com testes e
  documentação incluídos.

## O Que Acontece Depois do Envio

Os mantenedores revisam a mudança e o CI executa os gates de qualidade —
lint, typecheck e testes. Quando tudo fica verde, o pull request é mesclado e
mudanças visíveis ao usuário entram no changelog.
