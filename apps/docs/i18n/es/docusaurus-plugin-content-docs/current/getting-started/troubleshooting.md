---
title: Solución de problemas
description: Soluciones para problemas comunes de instalación e inicio de NeoTavern.
sidebar_position: 5
---

Esta página responde problemas comunes de instalación y ejecución en formato
de preguntas y respuestas. Si tu problema no aparece, recopila las líneas de
registro relevantes y abre un issue en el
[repositorio de GitHub](https://github.com/Disya123/NeoTavern).

## ¿Por Qué Dice la App Que el Puerto Ya Está en Uso?

El backend local escucha en `127.0.0.1:8000` por defecto. Si otro programa
ocupa ese puerto, el sidecar no puede iniciarse. Cierra el programa en
conflicto o inicia el servidor con otro puerto definiendo `NEOTA_PORT` en el
entorno. El mensaje de error de la app incluye el número de puerto y los
detalles que necesitas para resolver el conflicto.

## El Sidecar del Backend No Se Inicia

La app de escritorio ejecuta su backend como un sidecar de Node.js
integrado. Si no logra iniciarse, la ventana de la app muestra un error de
conexión. Verifica lo siguiente:

- Otra instancia de NeoTavern puede estar ejecutándose y reteniendo el
  puerto.
- El directorio de datos puede no ser escribible en su ubicación actual.
- Un antivirus o firewall puede estar bloqueando el runtime de Node
  integrado.

Reinicia la app después de resolver la causa. Si la app entra en un bucle de
fallos, ofrece un inicio en modo seguro que deshabilita los plugins y temas
de terceros antes de que se carguen: úsalo para recuperarte.

## La Base de Datos Está Bloqueada

NeoTavern usa SQLite con modo WAL y un tiempo de espera de ocupación (busy
timeout), por lo que el acceso concurrente breve está previsto y se maneja.
Un error persistente de "base de datos bloqueada" suele significar que una
segunda instancia de la app abrió el mismo directorio de datos, o que una
operación de respaldo o importación sigue en curso. Cierra las instancias
duplicadas y espera a que terminen las operaciones largas antes de
reintentar.

## ¿Cómo Limpio las Cachés?

Las cachés viven en `data/cache/` y son completamente regenerables:
miniaturas, datos del tokenizador y descargas de dependencias de plugins.
Limpiar una caché nunca borra tus originales, que se guardan por separado en
`data/files/`. Usa los controles de mantenimiento en Configuración → Datos
para limpiar las cachés y reconstruir el índice de búsqueda de texto
completo. Ambas acciones confirman la cantidad y el tamaño de lo que se
eliminará antes de hacer nada.

## ¿Dónde Viven los Registros?

Los registros se escriben en `data/logs/server.log` y se rotan a 10 MB. El
archivo de registro está depurado: los secretos, las claves de API y el
contenido de los mensajes del usuario nunca se registran. La salida de
consola se conserva junto al archivo. Al informar de un error, incluye las
líneas de registro relevantes y el ID de seguimiento que se muestra en los
detalles del error.

## ¿Cómo Vuelvo a una Interfaz Funcional?

Usa el modo seguro: es accesible antes de que se carguen los temas y plugins
de terceros y los deshabilita. Después de un tema o plugin roto, el modo
seguro restaura la interfaz integrada sin editar archivos a mano. Consulta
[Temas](../user-guide/themes) y [Extensiones](../user-guide/extensions) para
más detalles.

## ¿Por Qué Está Deshabilitado el Botón Enviar?

El botón se deshabilita solo cuando hay un motivo concreto, que se explica a
su lado; casi siempre es que no hay un proveedor activo o no hay un
personaje seleccionado. Conecta un proveedor en Configuración de IA o elige
un personaje, y el botón estará disponible. Consulta
[Inicio rápido](quick-start).
