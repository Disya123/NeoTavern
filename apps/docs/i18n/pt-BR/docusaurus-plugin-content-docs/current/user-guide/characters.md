---
title: Personagens
description: A galeria de personagens, as fichas de personagem e a importação ou exportação de fichas no NeoTavern.
sidebar_position: 3
---

Esta página explica como encontrar, criar, editar e compartilhar personagens no
NeoTavern. Um personagem é um participante dos seus chats, apoiado por uma
ficha de personagem que armazena tudo o que a IA sabe sobre ele.

## A Galeria de Personagens

A seção Personagens é o navegador da sua biblioteca. Ela suporta uma grade e
uma visualização de lista compacta, ambas virtualizadas para permanecerem
rápidas com dezenas de milhares de fichas. Miniaturas são usadas nas
pré-visualizações; as imagens originais carregam apenas quando você abre uma
ficha.

A busca suporta uma linguagem de consulta simples: `tag:NSFW author:Name
"exact phrase" -tag:beta`. Filtros de tag e autor combinam com os termos de
busca, e os resultados são classificados por relevância sempre que você digita
uma consulta. A ordenação inclui alfabética, mais recentes, mais antigas,
favoritas, usadas recentemente, mais ou menos chats, mais ou menos conteúdo e
aleatória.

## Criando e Editando Personagens

Abra qualquer ficha e escolha Editar. O editor é dividido em grupos claros:

- **Identidade** — nome, avatar e tags.
- **Descrição** — quem é o personagem.
- **Primeira mensagem** — a saudação, além de saudações alternativas.
- **Cenário** — a ambientação de onde o roleplay começa.
- **Exemplos** — exemplos de diálogo que moldam o estilo do personagem.
- **Lore** — lorebooks vinculados a este personagem.
- **Imagens** — uma galeria de imagens, uma das quais é o avatar principal.
- **Avançado** — personalidade, notas do criador, substituições de prompt, nota
  do personagem com profundidade e função, loquacidade e metadados do criador.

Apenas o nome é necessário para criar um personagem. Mensagens de validação
aparecem ao lado do campo e em uma lista final de erros, e os campos
obrigatórios são rotulados com texto, não apenas com cor.

## Fichas de Personagem

Uma ficha de personagem é a representação portátil de um personagem. Seus
campos incluem nome, descrição, personalidade, cenário, a primeira mensagem
(saudação), saudações alternativas, tags e avatar. As fichas também carregam
notas do criador, e campos desconhecidos de fichas importadas são preservados
em vez de descartados, então nenhum metadado é perdido ao levar uma ficha por
outra ferramenta.

## Importando e Exportando Fichas

- **Importar** aceita fichas de personagem PNG e JSON (V1 e V2) e funciona a
  partir da galeria, de um chat ou durante a configuração da primeira execução.
  A importação é segura de repetir — executá-la duas vezes nunca cria
  duplicatas.
- **Exportar** grava a ficha como PNG ou JSON, exatamente como você escolher,
  com um snapshot de versão do estado atual.
- Avatares e imagens da galeria são enviados como arquivos; uma imagem
  substituída nunca é removida até que a nova seja salva com sucesso.

Se uma ficha da sua biblioteca estiver danificada, o NeoTavern mostra uma
pré-visualização segura com o motivo e permite exportar o original para que
você possa repará-la em outro lugar.
