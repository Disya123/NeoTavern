---
title: Instalação
description: Como instalar o NeoTavern no Windows, macOS e Linux.
sidebar_position: 2
---

Esta página explica como instalar o NeoTavern no Windows, macOS e Linux. Baixe
a versão para sua plataforma na
[página de releases do GitHub](https://github.com/Disya123/NeoTavern/releases).

## Destinos de Instalação

- **Instalador do Windows.** Um executável de configuração que instala o
  aplicativo e adiciona atalhos. Recomendado para a maioria dos usuários do
  Windows.
- **Versão portátil para Windows.** Uma pasta autocontida que roda sem instalar
  nada. Ela mantém todos os dados dentro do próprio diretório, então você pode
  levá-la em um pendrive.
- **Pacote macOS.** Um bundle `.app` padrão. Arraste-o para a pasta Aplicativos
  e execute-o de lá.
- **AppImage e arquivo para Linux.** O AppImage roda na maioria das
  distribuições desktop. A variante em arquivo é uma pasta simples que você
  pode colocar em qualquer lugar e abrir com um duplo clique.

Os quatro destinos são funcionalmente idênticos. Escolha o que melhor se adequa
a como você gerencia software na sua máquina.

## Requisitos de Sistema

- Um sistema operacional de desktop 64 bits: Windows 10 ou mais recente, macOS
  ou uma distribuição Linux convencional.
- Memória e espaço em disco suficientes para sua biblioteca. O backend ocioso
  usa cerca de 180 MB de RAM em uma máquina de referência, e o aplicativo
  atinge a interface pronta em cerca de quatro segundos nessa mesma máquina.
- Nenhuma instalação separada de Node.js, Python, SQLite ou navegador. Tudo o
  que o aplicativo precisa está incluído.

## O Que Está Incluído

A distribuição incorpora Node.js 24 LTS e SQLite, e o shell de desktop executa
o backend local como um processo sidecar embutido. Isso significa:

- A primeira execução nunca executa `npm install` e nunca exige um terminal.
- O backend vincula-se apenas a `127.0.0.1`. Acesso LAN ou remoto nunca é
  ativado silenciosamente; exige um consentimento explícito.
- Fechar a janela do aplicativo encerra o sidecar de forma graciosa, então
  nenhum processo de backend é deixado para trás.

## Após a Instalação

O primeiro lançamento cria seu diretório de dados, semeia uma pequena
biblioteca inicial e abre a tela inicial. Veja [Quick Start](quick-start) para
os próximos passos.

Se algo der errado durante a instalação ou a primeira execução, veja
[Troubleshooting](troubleshooting).
