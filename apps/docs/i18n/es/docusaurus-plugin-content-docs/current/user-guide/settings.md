---
title: Ajustes
description: >-
  Ajustes globales y por chat, perfiles de conexión, proveedores y claves de
  API en NeoTavern.
sidebar_position: 7
---

Esta página explica dónde viven los ajustes en NeoTavern y cómo configurar
proveedores, perfiles de conexión y claves de API.

## Dónde Viven los Ajustes

NeoTavern no tiene una página de ajustes separada. Todo se abre como un
panel o modal sobre el espacio de trabajo de chat, y cerrarlo te devuelve
exactamente al mismo chat y borrador:

- **Ajustes** (desde la barra de navegación) agrupa las opciones de toda la
  app en pestañas: **General** (idioma, escala de texto, pantalla de inicio,
  estilo de mensaje, forma del avatar, accesibilidad), **Temas** (instalar y
  activar temas) y **Datos** (migración, respaldos, mantenimiento de caché,
  diagnóstico).
- **Configuración de IA** es el panel de contexto para la generación. Su
  pestaña **Config** contiene los parámetros de solicitud del modelo activo:
  tamaño de contexto, longitud de respuesta, streaming, muestreo,
  penalizaciones, semilla y razonamiento. La pestaña **API** gestiona los
  perfiles de conexión y las claves, y **Avanzado** construye plantillas
  personalizadas de chat e instrucciones a partir de ChatML, Llama 3 o
  Alpaca.

Los cambios de ajustes se aplican inmediatamente cuando son fácilmente
reversibles. Las opciones que difieren de sus valores predeterminados se
marcan y pueden restablecerse individualmente, y la búsqueda de ajustes
cubre nombres, descripciones y palabras clave.

## Ajustes Globales vs. Por Chat

Los ajustes globales en **Ajustes** se aplican a toda la app: idioma, tema,
gestión de datos y valores predeterminados. El comportamiento por chat vive
junto al chat: los parámetros de generación, el proveedor y modelo activos y
la estrategia de contexto se editan en el panel de Configuración de IA
mientras el chat permanece abierto, y los borradores y la posición de
desplazamiento se conservan. La persona también es por chat — cada
conversación puede usar una persona distinta mientras la persona activa de
toda la app sigue siendo la predeterminada.

## Proveedores y Perfiles de Conexión

Un perfil de conexión agrupa todo lo necesario para hablar con un
proveedor: el tipo y la fuente de API, la URL base cuando corresponde, la
clave de API seleccionada y el modelo. La pestaña **API** de Configuración
de IA (y la sección Proveedores) te permite:

1. Elegir la API de nivel superior (Chat Completions o Text Completions).
2. Elegir una fuente, que filtra las fuentes de esa API y se convierte en el
   nombre del perfil.
3. Ingresar la URL base para servidores compatibles con OpenAI, que suele
   terminar en `/v1`.
4. Elegir o escribir un ID de modelo, cargando opcionalmente la lista de
   modelos primero.
5. **Probar conexión** para verificar la disponibilidad y la latencia, y
   luego **Conectar** para activar el perfil.

## Claves de API

Las claves se guardan localmente en un administrador de claves que contiene
varias claves con nombre por proveedor, con una activa a la vez. Los
secretos se verifican antes de guardarse y nunca se muestran completos
después — solo queda visible un sufijo enmascarado. Las exportaciones y el
diagnóstico excluyen los secretos por defecto, y los errores del proveedor
se muestran como mensajes localizados con detalles técnicos y un ID de
seguimiento en un bloque plegable.

Consulta [Temas](themes), [Extensiones](extensions) y
[Datos y respaldos](data-and-backups) para el resto de los ajustes de toda
la app.
