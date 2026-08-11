---
title: Inicio rápido
description: Conecta un proveedor, elige un personaje y envía tu primer mensaje en NeoTavern.
sidebar_position: 3
---

Esta página te lleva desde una instalación nueva hasta tu primer mensaje
generado en unos cinco minutos. Necesitas un proveedor activo; todo lo demás
es opcional.

## 1. Inicia la App

Abre NeoTavern. Se abre directamente la pantalla de inicio y, en el primer
inicio, aparece una lista de verificación no bloqueante donde eliges tu
idioma y la escala de texto. Puedes ignorarla y volver a ella más tarde —
nada de esto bloquea la galería de personajes, las importaciones ni los
ajustes locales.

## 2. Conecta un Proveedor

La generación necesita un proveedor: un servidor de modelos local en tu
máquina o una API remota. Abre el panel de Configuración de IA o la sección
Proveedores:

1. Elige un tipo de API (por ejemplo, Chat Completions) y una fuente, que
   define el proveedor.
2. Ingresa tu clave de API. Las claves se guardan localmente, nunca se
   muestran completas después de guardarlas y por defecto no se incluyen en
   las exportaciones.
3. Opcionalmente, carga la lista de modelos de ese proveedor y elige un
   modelo.
4. Usa **Probar conexión** para verificar la disponibilidad y la latencia, y
   luego **Conectar** para activar el perfil.

¿Aún no tienes proveedor? Selecciona el proveedor **Echo** integrado para
probar todo el pipeline sin conexión. Echo responde con un eco predefinido y
no necesita clave ni acceso a la red.

Mientras no haya un proveedor activo, el botón Enviar está deshabilitado y
la app muestra el motivo a su lado. Los errores del proveedor nunca te
bloquean el acceso a tu biblioteca local.

## 3. Elige o Crea un Personaje

Abre la sección Personajes desde la barra de navegación:

- Explora la galería y abre una ficha para empezar a chatear.
- Importa una ficha de personaje (PNG o JSON) desde el disco.
- Crea un personaje nuevo desde cero: solo se requiere un nombre.

Consulta [Personajes](../user-guide/characters) para conocer todos los
detalles.

## 4. Envía Tu Primer Mensaje

Con un personaje seleccionado, se abre el lienzo de chat con el saludo del
personaje como primer mensaje de asistente. Escribe abajo y pulsa `Enter`
para enviar. El chat se crea en el backend solo después de que envías un
primer mensaje no vacío, por lo que explorar nunca deja chats vacíos.

La respuesta se transmite mientras se genera. Puedes detenerla en cualquier
momento o desplazarte por el historial mientras se transmite. Consulta
[Chat](../user-guide/chat) para conocer todo lo que puede hacer la vista de
chat.

## Siguientes Pasos

- [Solución de problemas](troubleshooting) si el backend no arranca o un
  puerto ya está en uso.
- [Ajustes](../user-guide/settings) para ajustar los parámetros de
  generación y los perfiles de conexión.
- [Datos y respaldos](../user-guide/data-and-backups) para importar un
  respaldo existente de SillyTavern o crear el tuyo.
