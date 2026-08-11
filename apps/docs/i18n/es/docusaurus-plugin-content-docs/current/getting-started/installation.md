---
title: Instalación
description: Cómo instalar NeoTavern en Windows, macOS y Linux.
sidebar_position: 2
---

Esta página explica cómo instalar NeoTavern en Windows, macOS y Linux.
Descarga la compilación para tu plataforma desde la
[página de versiones de GitHub](https://github.com/Disya123/NeoTavern/releases).

## Objetivos de Instalación

- **Instalador de Windows.** Un ejecutable de instalación que instala la app
  y agrega accesos directos. Recomendado para la mayoría de los usuarios de
  Windows.
- **Versión portátil de Windows.** Una carpeta autónoma que se ejecuta sin
  instalar nada. Guarda todos los datos dentro de su propio directorio, por
  lo que puedes llevarla en una unidad USB.
- **Paquete de macOS.** Un paquete `.app` estándar. Arrástralo a Applications
  (Aplicaciones) y ábrelo desde allí.
- **AppImage y archivo de Linux.** La AppImage se ejecuta en la mayoría de
  las distribuciones de escritorio. La variante de archivo es una carpeta
  simple que puedes colocar en cualquier lugar y abrir con doble clic.

Las cuatro opciones son funcionalmente idénticas. Elige la que mejor se
adapte a cómo gestionas el software en tu máquina.

## Requisitos del Sistema

- Un sistema operativo de escritorio de 64 bits: Windows 10 o posterior,
  macOS o una distribución de Linux convencional.
- Memoria y espacio en disco suficientes para tu biblioteca. El backend en
  reposo usa unos 180 MB de RAM en una máquina de referencia, y la app
  alcanza una interfaz lista en unos cuatro segundos en esa misma máquina.
- No se necesita instalar Node.js, Python, SQLite ni un navegador por
  separado. Todo lo que la app necesita viene incluido.

## Qué Viene Incluido

La distribución incluye Node.js 24 LTS y SQLite, y el shell de escritorio
ejecuta el backend local como un proceso sidecar integrado. Esto significa:

- El primer inicio nunca ejecuta `npm install` y nunca requiere una
  terminal.
- El backend solo se vincula a `127.0.0.1`. El acceso remoto o por LAN nunca
  se habilita en silencio; requiere una aceptación explícita.
- Cerrar la ventana de la app apaga el sidecar correctamente, por lo que no
  queda ningún proceso de backend rezagado.

## Después de la Instalación

El primer inicio crea tu directorio de datos, inicializa una pequeña
biblioteca inicial y abre la pantalla de inicio. Consulta
[Inicio rápido](quick-start) para los siguientes pasos.

Si algo sale mal durante la instalación o el primer inicio, consulta
[Solución de problemas](troubleshooting).
