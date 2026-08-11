---
title: Dados e Backups
description: Onde o NeoTavern armazena seus dados, como exportar e importar, e como funcionam os backups.
sidebar_position: 10
---

Esta página explica onde seus dados ficam, o que o diretório de dados contém e
como exportar, importar e fazer backup da sua biblioteca.

## O Diretório de Dados

Todos os dados do usuário ficam em um único diretório de dados, criado na
primeira execução. Sua localização exata é mostrada em Configurações → Dados;
você pode apontar o servidor para outro local com a variável de ambiente
`NEOTA_DATA_DIR`. O layout:

- `app.db` — o banco de dados SQLite: personagens, chats, mensagens, lorebooks,
  entradas de memória, personas, presets e configurações. Ele roda em modo WAL
  com chaves estrangeiras ativadas e pesquisa de texto completo para
  personagens, chats e mensagens.
- `files/` — arquivos originais do usuário: avatares, planos de fundo, anexos,
  áudio e imagens geradas. Estes nunca são dados derivados.
- `cache/` — dados regeneráveis: miniaturas, dados de tokenizador e downloads
  de plugins. Limpar um cache nunca toca seus originais.
- `backups/` — arquivos de backup que você cria pela interface.
- `logs/` — logs de servidor com dados sensíveis removidos.
- `plugins/` e `themes/` — pacotes instalados, cada um confinado ao seu próprio
  diretório.

## O Que É Armazenado

Personagens e suas fichas, chats com histórico completo de mensagens e
variantes de swipe, lorebooks, entradas de memória, personas, presets de
geração, perfis de conexão, temas, plugins e suas configurações. Chaves de API
são armazenadas localmente em um gerenciador de chaves criptografado e nunca
são gravadas em logs, armazenamento do navegador ou exportações de diagnóstico.

## Exportação e Importação

- **Fichas de personagem** exportam como PNG ou JSON, e chats exportam como
  arquivos que você pode guardar ou mover para outra máquina. Veja
  [Characters](characters).
- **A migração do SillyTavern** fica em Configurações → Dados: escolha um ZIP de
  backup completo, e o aplicativo primeiro executa uma análise somente leitura
  que reporta objetos, registros aninhados, danos, tamanho e conflitos por
  categoria — personagens, chats, personas, lorebooks e presets. Nada é gravado
  antes de você revisar o relatório e confirmar. Você então escolhe as
  categorias e uma política explícita de conflitos (manter os existentes, criar
  cópias, mesclar com segurança ou substituir pelo arquivo). Segredos, plugins,
  temas e categorias não suportadas são listados como ignorados, e repetir a
  importação nunca cria duplicatas.

## Backups

Backups são criados e restaurados inteiramente pela interface em Configurações
→ Dados:

- **Criar** um backup a qualquer momento; criá-lo não bloqueia a leitura dos
  seus dados.
- A tela de backup mostra data, tamanho, versão do esquema, fonte e estado.
- **Restaurar** pede confirmação, cria primeiro um backup de proteção do estado
  atual e avisa que o aplicativo precisa reiniciar depois.
- A restauração só é reportada como bem-sucedida após a verificação de
  integridade; se falhar, o aplicativo oferece retorno automático à cópia de
  proteção.

Antes de qualquer migração de esquema perigosa, o aplicativo cria um backup por
conta própria. Combinado com o banco WAL, isso significa que uma atualização ou
restauração sempre tem uma alternativa conhecidamente boa. Veja
[Upgrading](../getting-started/upgrading).
