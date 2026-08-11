---
title: Pautas de código
description: Las reglas que debe seguir toda contribución de código a NeoTavern
sidebar_position: 3
---

Las contribuciones de código a NeoTavern siguen un conjunto compartido de
reglas: TypeScript estricto, un contrato de errores explícito, documentación
como parte del cambio y objetivos de rendimiento medibles.

## TypeScript

- El modo estricto está habilitado para todo el código; mantenlo activado.
- Están prohibidos el `any` injustificado, `@ts-ignore`, las aserciones no
  nulas y los casts `as unknown as`.
- En los límites del sistema — análisis, solicitudes, archivos, entrada de
  plugins — usa `unknown` y valida explícitamente antes de confiar en los
  datos.
- Las interfaces públicas exponen tipos exportados. Nunca dupliques a mano
  los tipos de backend y frontend: los tipos de API compartidos viven en
  `packages/contracts` y se importan desde allí.
- Usa ESM en todo el código.
- Prefiere funciones pequeñas con entradas y salidas explícitas sobre
  funciones grandes con estado.

## Errores de API

Cada error de API usa una estructura estable y legible por máquina:

```json
{
  "code": "CHARACTER_NOT_FOUND",
  "params": { "characterId": "0193..." },
  "traceId": "01J4..."
}
```

- `code` es un identificador de error estable y legible por máquina — no lo
  cambies una vez publicado.
- `params` lleva contexto estructurado sobre el que un cliente o plugin
  puede actuar.
- `traceId` correlaciona el error con los registros del servidor.
- El texto orientado al usuario nunca se compone en el backend: el frontend
  localiza el código y los params en texto de interfaz.

## La Documentación Es Parte de la Implementación

La documentación es parte de la implementación, no una cola que viene
después del código. Cualquier cambio que afecte el comportamiento del
usuario o del desarrollador actualiza los archivos relevantes en `docs/` en
el mismo cambio. Esto es obligatorio para:

- la arquitectura y los límites de los paquetes;
- la API REST, SSE, WebSocket y los esquemas de contrato;
- el Plugin SDK, el Theme SDK y la capa de compatibilidad heredada;
- los permisos, el sandbox y el modelo de seguridad;
- el esquema de SQLite, las migraciones, el respaldo y la restauración;
- la importación, exportación, archivos y la caché de miniaturas;
- el pipeline de prompt, los formatos de instrucciones, la tokenización y el
  ajuste de contexto;
- los adaptadores de proveedor;
- el empaquetado de escritorio, el sidecar de Tauri, la PWA y las
  actualizaciones;
- los ajustes de usuario, i18n y la accesibilidad;
- los cambios incompatibles, las deprecaciones y las guías de migración.

Reglas adicionales:

- Cada `app` o `package` nuevo se publica con un `README.md` que cubre el
  propósito, los puntos de entrada públicos, las dependencias, los comandos
  de desarrollo y las restricciones.
- Las exportaciones públicas de TypeScript y los puntos de extensión del SDK
  reciben TSDoc cuando el nombre por sí solo no explica el contrato.
- Los cambios visibles para el usuario se agregan a `CHANGELOG.md`; los
  cambios incompatibles también reciben una guía de migración.
- No documentes funciones no implementadas como listas — márcalas como
  "experimental" o "planificada".
- Mantén una única fuente de verdad por contrato y enlázala; no copies el
  mismo contrato en varios lugares.

## i18n

- Sin cadenas visibles al usuario codificadas en el código de interfaz.
  Todas las cadenas pasan por los espacios de nombres de i18next.
- Formatea plurales, fechas, números y unidades con `Intl`, no con
  concatenación de cadenas.
- Los cambios de idioma se hacen sin recargar la página; actualiza `lang` y
  `dir` en `<html>`.
- Soporta diseños RTL.
- Los plugins y temas usan espacios de nombres aislados para que no puedan
  chocar con la app.
- El backend devuelve códigos de error; el frontend los localiza.
- Agrega verificaciones de pseudo-locale para las pantallas nuevas y verifica
  las interfaces con traducciones largas.

## Objetivos de Rendimiento

No hagas retroceder estos objetivos sin una decisión explícita:

| Objetivo                                                          | Presupuesto    |
| ----------------------------------------------------------------- | -------------- |
| Inicio hasta interfaz lista (PC de referencia)                    | 4 s            |
| Memoria del backend en reposo                                     | 180 MB         |
| Primera página de 100 000 personajes                              | 300 ms         |
| Abrir un chat de 10 000 mensajes hasta los más recientes          | 700 ms         |
| Actualizaciones de interfaz en streaming                          | 30 por segundo |
| Bundle inicial del frontend (gzip, antes de los chunks diferidos) | 2 MB           |

Mide antes y después de optimizar. No agregues una caché sin una estrategia
de invalidación.

## Pruebas

Cada cambio agrega una prueba en el nivel apropiado: pruebas unitarias de
Vitest, pruebas de integración con `inject()` de Fastify, pruebas de
extremo a extremo de Playwright, regresión visual para temas y diseños de
shell, pruebas de accesibilidad, pruebas de migración, pruebas de contrato
de plugins y la suite de compatibilidad heredada. Cubre entradas erróneas y
corruptas, cancelación de solicitudes, re-importación, migraciones y
reversión, restauración de respaldos, limpieza de caché, deshabilitación de
plugins, modo seguro, catálogos grandes y chats largos, ajuste de contexto
en el límite del presupuesto de tokens, renderizado de formatos de
instrucciones y generación e invalidación de miniaturas.

## Definición de Terminado

Antes de hacer push: `pnpm format`, `pnpm lint` con cero advertencias,
`pnpm typecheck`, `pnpm test` y `pnpm test:e2e` para cambios de interfaz.
Confirma que la documentación, los ejemplos y las guías de migración
relacionados estén actualizados y que los enlaces de documentación se
resuelvan.
