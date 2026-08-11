---
title: Datos y respaldos
description: >-
  Dónde guarda NeoTavern tus datos, cómo exportar e importar y cómo
  funcionan los respaldos.
sidebar_position: 10
---

Esta página explica dónde viven tus datos, qué contiene el directorio de
datos y cómo exportar, importar y respaldar tu biblioteca.

## El Directorio de Datos

Todos los datos de usuario viven en un único directorio de datos, creado en
el primer inicio. Su ubicación exacta se muestra en Configuración → Datos;
puedes apuntar el servidor a otra ubicación con la variable de entorno
`NEOTA_DATA_DIR`. La estructura:

- `app.db` — la base de datos SQLite: personajes, chats, mensajes, lorebooks,
  entradas de memoria, personas, presets y ajustes. Se ejecuta en modo WAL
  con claves foráneas habilitadas y búsqueda de texto completo para
  personajes, chats y mensajes.
- `files/` — archivos de usuario originales: avatares, fondos, archivos
  adjuntos, audio e imágenes generadas. Nunca son datos derivados.
- `cache/` — datos regenerables: miniaturas, datos del tokenizador y
  descargas de plugins. Limpiar una caché nunca toca tus originales.
- `backups/` — archivos de respaldo que creas desde la interfaz.
- `logs/` — registros de servidor depurados.
- `plugins/` y `themes/` — paquetes instalados, cada uno confinado a su
  propio directorio.

## Qué Se Guarda

Personajes y sus fichas, chats con el historial completo de mensajes y las
variantes de swipe, lorebooks, entradas de memoria, personas, presets de
generación, perfiles de conexión, temas, plugins y tus ajustes. Las claves
de API se guardan localmente en un administrador de claves cifrado y nunca
se escriben en los registros, el almacenamiento del navegador ni las
exportaciones de diagnóstico.

## Exportar e Importar

- **Las fichas de personaje** se exportan como PNG o JSON, y los chats se
  exportan como archivos que puedes conservar o mover a otra máquina.
  Consulta [Personajes](characters).
- **La migración de SillyTavern** vive en Configuración → Datos: elige un
  ZIP de respaldo de datos completo, y la app primero ejecuta un análisis de
  solo lectura que informa de los objetos, los registros anidados, los
  daños, el tamaño y los conflictos por categoría — personajes, chats,
  personas, lorebooks y presets. Nada se escribe antes de que revises el
  informe y confirmes. Luego eliges las categorías y una política de
  conflictos explícita (conservar lo existente, crear copias, fusionar de
  forma segura o reemplazar desde el archivo). Los secretos, plugins, temas
  y categorías no compatibles se enumeran como omitidos, y repetir la
  importación nunca crea duplicados.

## Respaldos

Los respaldos se crean y restauran por completo desde la interfaz en
Configuración → Datos:

- **Crea** un respaldo cuando quieras; crearlo no bloquea la lectura de tus
  datos.
- La pantalla de respaldo muestra fecha, tamaño, versión de esquema, fuente y
  estado.
- **Restaurar** pide confirmación, primero crea un respaldo protector del
  estado actual y te avisa de que la app debe reiniciarse después.
- La restauración solo se informa como exitosa después de verificar la
  integridad; si falla, la app ofrece un retorno automático a la copia
  protectora.

Antes de cualquier migración de esquema peligrosa, la app crea un respaldo
por su cuenta. Combinado con la base de datos WAL, eso significa que una
actualización o restauración siempre tiene un respaldo conocido y bueno.
Consulta [Actualización](../getting-started/upgrading).
