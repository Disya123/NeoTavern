---
title: Qué Es NeoTavern
description: Una introducción a NeoTavern, una plataforma local-first de chat y rol con IA.
sidebar_position: 1
---

NeoTavern es una plataforma local-first de chat y rol con IA que se ejecuta
en tu propia computadora. Creas o importas personajes, conversas con ellos a
través de cualquier modelo de IA que conectes y conservas cada mensaje,
ficha de personaje y ajuste en tu máquina.

## Local-First por Diseño

- Tus datos viven en un directorio de datos local en tu computadora. No hay
  cuenta, ni sincronización obligatoria en la nube, ni telemetría por
  defecto.
- Puedes explorar tu biblioteca, editar personajes y revisar los ajustes sin
  conexión. Solo la generación necesita un proveedor accesible.
- Antes de enviar algo a un servicio de IA externo por primera vez, la app
  te muestra exactamente qué proveedor recibirá la solicitud.

## Cómo Funciona

- La app de escritorio está disponible para Windows, macOS y Linux. Incluye
  Node.js y SQLite, por lo que nunca tienes que instalar un runtime por tu
  cuenta.
- La app inicia su propio backend local, un sidecar de Node.js integrado que
  escucha en `127.0.0.1:8000` por defecto y se apaga junto con la ventana.
- Una PWA adaptable permite que teléfonos y tabletas se conecten a un
  backend que se ejecuta en tu PC o servidor doméstico.

## Qué Necesitas

- Un sistema operativo de escritorio de 64 bits compatible. No se requiere
  terminal, Git ni gestor de paquetes en ningún momento.
- Un proveedor para generar respuestas: un servidor de modelos local o una
  API remota con tu clave. El proveedor Echo integrado te permite verificar
  todo el flujo sin conexión, sin ningún servicio externo.
- Opcional pero útil: un respaldo de datos existente de SillyTavern para
  migrar tus personajes, chats, lorebooks y personas.

## A Dónde Ir Después

- [Instalación](getting-started/installation) — descarga y configura la app en tu sistema
  operativo.
- [Inicio rápido](getting-started/quick-start) — conecta un proveedor y envía tu primer
  mensaje.
- [Actualización](getting-started/upgrading) — cómo funcionan las actualizaciones y por qué
  tus datos permanecen a salvo.
- [Solución de problemas](getting-started/troubleshooting) — soluciones para problemas
  comunes de instalación y ejecución.
- [Guía de usuario](user-guide/) — páginas detalladas sobre chat,
  personajes, lorebooks, memoria, temas y plugins.
- [Preguntas frecuentes](faq) — respuestas breves a las preguntas más
  frecuentes.
