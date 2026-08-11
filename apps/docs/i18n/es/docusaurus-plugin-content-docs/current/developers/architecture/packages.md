---
title: Paquetes
description: >-
  La responsabilidad de cada paquete del workspace y la dirección de las
  dependencias que mantiene el monorepo libre de ciclos.
sidebar_position: 4
---

Cada paquete del workspace tiene exactamente una responsabilidad, y las
dependencias solo apuntan hacia abajo, lo que mantiene el monorepo libre de
ciclos.

## Dirección de las Dependencias

El código solo puede depender de paquetes "por debajo" de él:

```text
apps (server, web, desktop, plugin-runtime)
  → packages
  → shared, contracts (el piso)
```

`server` y `web` dependen de los paquetes; los paquetes dependen como máximo
de `shared` y `contracts`. Las dependencias cíclicas están prohibidas. Cuando
agregues código nuevo, ponlo en el paquete más reducido que pueda alojarlo:
los helpers compartidos van a `@neotavern/shared`, las formas de API a
`@neotavern/contracts` y todo lo relacionado con la base de datos a `@neotavern/db`.

## Responsabilidades de los Paquetes

- `@neotavern/shared` — utilidades isomórficas sin dependencias de runtime:
  IDs UUIDv7, `Result`, la estructura `AppError`, un logger estructurado con
  redacción de secretos, helpers de tiempo de espera y señal, y macros de
  prompt.
- `@neotavern/contracts` — esquemas TypeBox para cada entrada y salida de API. La
  única fuente de verdad compartida por servidor y web; nunca se duplica a
  mano.
- `@neotavern/db` — SQLite: el esquema de Drizzle, las migraciones, los
  repositorios y la búsqueda FTS5. El único paquete que habla con la base de
  datos.
- `@neotavern/ui` — componentes base headless construidos sobre primitivas Radix,
  tokens de diseño y los hooks `data-*` en los que se apoyan los temas.
- `@neotavern/i18n` — configuración de i18next, espacios de nombres, recursos `en`
  y `ru`, y el localizador de códigos de error que mapea los códigos de
  error de máquina a texto localizado.
- `@neotavern/plugin-sdk` — el Plugin SDK versionado: esquema de manifiesto,
  permisos y concesiones de capacidades, y los contratos de API de frontend
  y backend contra los que compilan los plugins.
- `@neotavern/theme-sdk` — el Theme SDK: esquema de manifiesto, los niveles de
  token/componente/shell y la resolución de herencia.
- `@neotavern/provider-sdk` — el contrato unificado de adaptador de proveedor más
  los adaptadores integrados para proveedores LLM, TTS, STT e imágenes, y el
  registro de adaptadores.
- `@neotavern/legacy-compat` — la capa de compatibilidad heredada: variables
  globales de `window`, el bus de eventos e islas DOM no gestionadas para
  scripts de la era de SillyTavern.
- `@neotavern/gestures` — gestos de fila independientes del framework: menús
  contextuales (clic derecho y pulsación larga) y reconocimiento de
  reordenamiento por arrastrar y soltar.
- `@neotavern/plugin-build` — el pipeline de compilación y publicación de plugins:
  analizar, firmar y compilar paquetes de plugins.

## Qué Vive Dónde

- **Las formas de API** siempre vienen de `@neotavern/contracts`. El backend y el
  frontend nunca declaran el mismo tipo dos veces.
- **El acceso a la base de datos** ocurre solo a través de los repositorios
  de `@neotavern/db`. El código de los plugins nunca recibe una conexión SQLite.
- **El comportamiento del proveedor** vive en los adaptadores de
  `@neotavern/provider-sdk`. El núcleo del servidor no está acoplado al SDK de
  ningún proveedor, con una excepción documentada: el adaptador de Anthropic
  usa el SDK oficial para superficies beta.
- **Los bloques de construcción de la interfaz** vienen de `@neotavern/ui`; las
  pantallas de la aplicación los componen. Los gestos independientes del
  framework permanecen en `@neotavern/gestures` para poder reutilizarlos fuera de
  React.

## Agregar un Paquete

Un paquete nuevo necesita un `README.md` que declare su propósito, sus
puntos de entrada públicos, sus dependencias y sus restricciones — la
documentación es parte de la implementación. Antes de crear uno, verifica si
el código encaja en un paquete existente; la respuesta predeterminada es no
crear un paquete nuevo.
