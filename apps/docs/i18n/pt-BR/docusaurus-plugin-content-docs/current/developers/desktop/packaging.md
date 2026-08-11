---
title: Empacotamento
description: Formatos de distribuição para Windows, macOS e Linux, e a experiência de primeiro uso.
sidebar_position: 4
---

O NeoTavern é distribuído como pacotes nativos por plataforma, cada um
carregando o sidecar Node.js, SQLite, addons nativos e os ativos web de
produção.

## Formatos de Distribuição

O build desktop produz:

- **Instalador Windows** — instaladores NSIS e MSI com modo de instalação
  por usuário. O instalador registra o app e coloca os dados do usuário no
  diretório de dados locais do app da plataforma.
- **Build portátil Windows** — um ZIP contendo o executável, o sidecar, um
  marcador `portable.flag` e `resources/`, além de um arquivo de checksum
  `.sha256`. Com a flag presente, os dados ficam em uma pasta `data/` local ao
  lado do aplicativo em vez de app-local-data.
- **Pacote macOS** — um bundle `.app`, empacotado em um DMG no runner macOS.
- **Linux** — um AppImage e um arquivo.

Cada formato é construído e testado por smoke test em seu próprio runner de
plataforma nativa, porque a distribuição empacota addons nativos. Copiar
artefatos preparados entre plataformas não é suportado.

## O Que Vem Dentro

Todo pacote contém tudo o que o app precisa em runtime:

- O shell Tauri 2.
- O executável do sidecar Node.js 24 autocontido.
- SQLite via `better-sqlite3`.
- Sharp para processamento de imagens.
- Os ativos web de produção.

Como Node.js, SQLite e os ativos estão dentro do pacote, o usuário não precisa
de nada instalado previamente — nem Node.js, nem npm, nem configuração de banco
de dados.

## Primeiro Uso

O primeiro lançamento é a promessa central do produto: abra o app, e ele
funciona.

1. O shell inicia o sidecar.
2. O backend cria o diretório de dados, inicializa o banco de dados SQLite,
   executa migrações pendentes (com um backup antes de mudanças de esquema
   pendentes), e semeia temas empacotados e o personagem inicial.
3. A webview abre no aplicativo pronto.

Não há terminal, nenhum assistente de instalação além do da plataforma, nenhum
`npm install` e nenhuma configuração manual. Se o usuário escolheu um fundo de
chat ou instalou plugins, nada disso vive no executável — os dados do usuário
são separados do pacote, de modo que as atualizações substituem o núcleo sem
tocar nos arquivos do usuário.

## Atualizações

Builds de release assinam seus artefatos e integram o updater do Tauri. O
updater verifica o manifesto e uma assinatura minisign antes de instalar um
artefato da plataforma e então reinicia o shell. Rollback significa publicar o
código anterior revisado como uma nova release assinada — downgrades não
assinados não são permitidos. Plugins e temas são atualizados
independentemente pelos gerenciadores de Plugin e Tema; arquivos do usuário
nunca entram em um artefato de atualização executável.

## Construção

A partir do repositório, os comandos de empacotamento são:

```bash
pnpm desktop:prepare
pnpm desktop:build
pnpm desktop:portable
pnpm desktop:release
```

`desktop:prepare` constrói o servidor e o web, copia addons nativos
específicos do alvo e cria o sidecar com o sufixo de target-triple do Tauri.
`desktop:portable` adicionalmente constrói os instaladores NSIS/MSI e o ZIP
portátil com checksum e executa um smoke test headless do shell.
`desktop:release` produz artefatos de atualização assinados e exige os
segredos de release. Construir instaladores exige Rust stable MSVC, Windows
C++ Build Tools e WebView2 na máquina de build — nada disso é necessário para
os usuários finais.
