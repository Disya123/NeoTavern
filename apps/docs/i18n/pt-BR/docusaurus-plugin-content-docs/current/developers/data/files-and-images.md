---
title: Arquivos e Imagens
description: >-
  Como os arquivos do usuário são armazenados em disco: originais separados do
  cache, o pipeline de importação de imagens, miniaturas e escritas atômicas.
sidebar_position: 3
---

Arquivos do usuário são armazenados em disco, nunca como BLOBs: originais
ficam em `data/files/`, miniaturas regeneráveis em `data/cache/thumbnails/`, e
toda escrita é atômica.

## Originais vs. Cache

A separação é estrita:

- **Originais** — `data/files/{avatars,backgrounds,attachments,audio,generated}/`.
  Originais nunca são modificados nem excluídos pela manutenção de cache.
- **Cache** — `data/cache/thumbnails/`. Miniaturas são regeneráveis e
  endereçadas por conteúdo.

Limpar o cache nunca remove originais. Uma miniatura ausente é regenerada
automaticamente a partir do original.

## O Pipeline de Importação de Imagens

Importar uma imagem segue um pipeline fixo:

1. Validar tamanho, tipo MIME e extensão.
2. Calcular um hash de conteúdo (SHA-256).
3. Salvar o original sem perdas, endereçado por conteúdo (`{sha256}{ext}`), o
   que deduplica por conteúdo.
4. Gerar miniaturas de baixa resolução para galerias, listas e pré-visualizações.
5. Armazenar miniaturas em `data/cache/thumbnails/`.
6. Chavear cada miniatura pelo hash do original, pelo tamanho alvo e pela
   versão do algoritmo: `{hash}-{size}-v{algorithmVersion}`.
7. Não regenerar uma miniatura cuja chave não mudou.
8. Nunca carregar o original onde uma miniatura é suficiente.
9. Reconstruir o cache automaticamente quando uma miniatura está ausente.
10. A limpeza de cache nunca toca os originais.

## Escritas Atômicas

Toda escrita de arquivo passa por um arquivo temporário seguido de um rename.
Uma falha no meio nunca deixa um arquivo parcialmente gravado. Isso se aplica
igualmente a originais, miniaturas e arquivos de tokenizador baixados.

## Galeria de Personagens

Imagens da galeria reutilizam a tabela `attachments` com
`owner_type = character.gallery`. As linhas de metadados contêm as URLs do
original e de sua miniatura; os bytes ficam em `files/avatars/` endereçados
por conteúdo. Remover uma imagem da galeria exclui o registro do anexo, não o
arquivo original — a ação permanece reversível e a deduplicação é preservada.

## Fundos de Chat

`files/backgrounds/` é a fonte da verdade: a lista é construída escaneando o
diretório, então fundos importados do SillyTavern aparecem sem nenhuma etapa
de transferência. Arquivos enviados são armazenados endereçados por conteúdo e
nunca modificados.

Miniaturas de fundos ficam em `cache/thumbnails/`, chaveadas pelo SHA-256 do
nome do arquivo em vez do conteúdo, o que permite que arquivos importados do
SillyTavern com nomes arbitrários também ganhem miniaturas e mantém upload,
listagem e exclusão em uma única chave. Um arquivo que não pode ser
decodificado ou excede 64 MiB é listado sem miniatura; o original permanece
disponível. Excluir um fundo remove tanto o original quanto sua miniatura em
cache.

## Importação de Fichas de Personagem

`POST /api/v2/characters/import` aceita JSON de Character Card V1/V2 e PNGs
com metadados `chara`. A entrada é limitada a 25 MiB e detectada pelo
conteúdo. O SHA-256 de todo o arquivo de origem é armazenado em
`ext._st2.importHash`, e reimportar o mesmo arquivo retorna o registro
existente. PNGs são validados por um decodificador de imagens. O original é
gravado atomicamente em `files/avatars/` e uma miniatura WebP é gerada; uma
miniatura ausente é reconstruída a partir do original na próxima leitura.

## Manutenção de Cache

A tela de diagnóstico chama `DELETE /api/v2/diagnostics/cache`, que remove
apenas os arquivos em `cache/thumbnails/` e suas linhas `cache_metadata`. A
raiz de `cache/` é mantida, então diretórios ativos de staging de migração
nunca são interrompidos. O resultado relata o número e o tamanho dos arquivos
removidos; executá-lo novamente é seguro e retorna zeros.
