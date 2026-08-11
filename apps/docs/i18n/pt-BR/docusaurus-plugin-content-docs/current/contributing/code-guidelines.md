---
title: Diretrizes de Código
description: As regras que toda contribuição de código do NeoTavern deve seguir
sidebar_position: 3
---

As contribuições de código do NeoTavern seguem um conjunto compartilhado de
regras: TypeScript estrito, um contrato explícito de erros, documentação como
parte da mudança e metas de desempenho mensuráveis.

## TypeScript

- O modo estrito está habilitado para todo o código; mantenha-o.
- `any` injustificado, `@ts-ignore`, asserções não nulas e casts `as unknown
as` são proibidos.
- Nas fronteiras do sistema — parsing, requisições, arquivos, entrada de
  plugins — use `unknown` e valide explicitamente antes de confiar nos dados.
- Interfaces públicas expõem tipos exportados. Nunca duplique à mão tipos de
  backend e frontend: tipos de API compartilhados ficam em `packages/contracts`
  e são importados de lá.
- Use ESM em todo lugar.
- Prefira funções pequenas com entradas e saídas explícitas a funções grandes
  e com estado.

## Erros de API

Todo erro de API usa um envelope estável e legível por máquina:

```json
{
  "code": "CHARACTER_NOT_FOUND",
  "params": { "characterId": "0193..." },
  "traceId": "01J4..."
}
```

- `code` é um identificador de erro estável e legível por máquina — não o
  mude depois de lançado.
- `params` carrega contexto estruturado sobre o qual um cliente ou plugin pode
  agir.
- `traceId` correlaciona o erro com os logs do servidor.
- Texto voltado ao usuário nunca é composto no backend: o frontend localiza o
  code e os params em texto de interface.

## Documentação É Parte da Implementação

Documentação é parte da implementação, não uma cauda que vem depois do código.
Qualquer mudança que afete o comportamento de usuários ou desenvolvedores
atualiza os arquivos relevantes em `docs/` na mesma mudança. Isso é
obrigatório para:

- arquitetura e fronteiras de pacotes;
- REST API, SSE, WebSocket e esquemas de contratos;
- Plugin SDK, Theme SDK e a camada de compatibilidade legada;
- permissões, sandboxing e o modelo de segurança;
- esquema SQLite, migrações, backup e restauração;
- importação, exportação, arquivos e o cache de miniaturas;
- pipeline de prompt, formatos instruct, tokenização e context shifting;
- adaptadores de provedores;
- empacotamento desktop, sidecar Tauri, PWA e atualizações;
- configurações do usuário, i18n e acessibilidade;
- breaking changes, deprecações e guias de migração.

Regras adicionais:

- Todo novo `app` ou `package` entrega um `README.md` cobrindo propósito,
  pontos de entrada públicos, dependências, comandos de dev e restrições.
- Exports públicos TypeScript e pontos de extensão do SDK ganham TSDoc quando
  o nome sozinho não explica o contrato.
- Mudanças visíveis ao usuário são adicionadas ao `CHANGELOG.md`; breaking
  changes também ganham um guia de migração.
- Não documente recursos não implementados como prontos — marque-os como
  "experimental" ou "planejado".
- Mantenha uma fonte de verdade por contrato e linke para ela; não copie o
  mesmo contrato em vários lugares.

## i18n

- Nenhuma string voltada ao usuário fixada no código de interface. Todas as
  strings passam por namespaces i18next.
- Formate plurais, datas, números e unidades com `Intl`, não por concatenação
  de strings.
- Troca de idioma sem recarregar a página; atualize `lang` e `dir` no `<html>`.
- Suporte a layouts RTL.
- Plugins e temas usam namespaces isolados para não colidirem com o app.
- O backend retorna códigos de erro; o frontend os localiza.
- Adicione verificações de pseudo-locale para novas telas e verifique
  interfaces com traduções longas.

## Metas de Desempenho

Não regrida estas metas sem uma decisão explícita:

| Meta                                                    | Orçamento      |
| ------------------------------------------------------- | -------------- |
| Início até a interface pronta (PC de referência)        | 4 s            |
| Memória ociosa do backend                               | 180 MB         |
| Primeira página de 100.000 personagens                  | 300 ms         |
| Abrir um chat de 10.000 mensagens até as mais recentes  | 700 ms         |
| Atualizações de interface em streaming                  | 30 por segundo |
| Bundle inicial do frontend (gzip, antes de chunks lazy) | 2 MB           |

Meça antes e depois da otimização. Não adicione um cache sem uma estratégia de
invalidação.

## Testes

Toda mudança adiciona um teste no nível apropriado: testes unitários Vitest,
testes de integração Fastify `inject()`, testes end-to-end Playwright, regressão
visual para temas e layouts de shell, testes de acessibilidade, testes de
migração, testes de contrato de plugins e a suíte de compatibilidade legada.
Cubra erros e entradas corrompidas, cancelamento de requisições, reimportação,
migrações e rollback, restauração de backup, limpeza de cache, desativação de
plugins, modo de segurança, catálogos grandes e chats longos, context shifting
na fronteira do orçamento de tokens, renderização de formatos instruct e
geração e invalidação de miniaturas.

## Definição de Pronto

Antes de enviar: `pnpm format`, `pnpm lint` com zero warnings, `pnpm typecheck`,
`pnpm test` e `pnpm test:e2e` para mudanças de interface. Confirme que a
documentação relacionada, os exemplos e os guias de migração estão atualizados
e que os links da documentação resolvem.
