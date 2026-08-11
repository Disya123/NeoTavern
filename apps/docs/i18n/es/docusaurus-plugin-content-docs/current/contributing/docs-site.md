---
title: Sitio de documentación
description: Cómo funciona el sitio de documentación de NeoTavern y cómo agregar o corregir páginas
sidebar_position: 4
---

El sitio público de documentación es un proyecto de Docusaurus en
`apps/docs`. Esta página explica su estructura y cómo agregar o actualizar
páginas.

## Estructura

- Las páginas fuente en inglés viven en `apps/docs/docs/`, un archivo
  markdown por página, organizadas en los mismos directorios que muestra la
  barra lateral.
- Las traducciones viven en
  `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/`,
  reflejando el árbol en inglés con un archivo por página; consulta
  [Traducciones](./translations).
- La referencia del SDK bajo `apps/docs/docs/api/` se genera y está en
  gitignore; no la edites a mano.

## Agregar una Página

1. Crea el archivo markdown en el directorio que coincida con dónde debería
   aparecer la página.
2. Agrega front matter con `title`, `description` y `sidebar_position`:

   ```yaml
   ---
   title: Page Title
   description: One sentence describing the page.
   sidebar_position: 3
   ---
   ```

3. Abre con un resumen de una oración de lo que cubre la página.
4. Usa `##` y `###` para las secciones; el `title` del front matter
   proporciona el único H1.
5. Si agregas un directorio nuevo, crea un `_category_.json` en él:

   ```json
   { "label": "Category Label", "position": 2 }
   ```

`sidebar_position` ordena las páginas dentro de su directorio; la página de
información general es la 1. Las secciones de la barra lateral de contenido
se generan automáticamente a partir de la estructura de directorios.

## Límites de MDX

Las páginas son Markdown plano más las admoniciones de Docusaurus
únicamente:

```md
:::note
Text inside the admonition.
:::
```

Sin sentencias `import`, sin componentes JSX personalizados, sin pestañas y
sin HTML sin procesar. Cada página debe poder copiarse textualmente en
cualquiera de los ocho locales de traducción. Los ejemplos de código usan
bloques delimitados con una etiqueta de idioma.

## Referencia del SDK

La referencia del SDK la genera TypeDoc desde el punto de entrada de cada
paquete:

- `packages/plugin-sdk/src/index.ts` -> `apps/docs/docs/api/plugin-sdk/`
- `packages/theme-sdk/src/index.ts` -> `apps/docs/docs/api/theme-sdk/`
- `packages/provider-sdk/src/index.ts` -> `apps/docs/docs/api/provider-sdk/`
- `packages/contracts/src/index.ts` -> `apps/docs/docs/api/contracts/`

La referencia se regenera en cada compilación del sitio, por lo que las
ediciones a las páginas generadas se pierden. Para corregir una página de
referencia, corrige el TSDoc en la fuente del paquete en su lugar. La
información general en `apps/docs/docs/api/index.md` está escrita a mano y
permanece confirmada.

## Ejecutar el Sitio

```bash
pnpm docs:site        # servidor de desarrollo local con recarga en caliente
pnpm docs:site:build  # compilación de producción: todos los locales más la referencia del SDK
```

La compilación de producción es la puerta — los enlaces rotos y los enlaces
markdown rotos la hacen fallar — así que ejecútala antes de hacer push de
cambios de contenido.

## Reglas de Enlaces

Los enlaces internos deben apuntar a páginas que existen en el sitio.
Prefiere rutas absolutas del sitio desde la página de inicio
(`/getting-started/`) y rutas relativas desde las páginas más profundas
(`../developers/` desde una página bajo `contributing/`). Los enlaces
externos se limitan a la documentación de Docusaurus y al repositorio de
NeoTavern.

## Documentación Interna de Desarrollo

El repositorio también mantiene documentación interna de desarrollo en
`docs/` en la raíz del repositorio, validada por `pnpm docs:check` y
`pnpm docs:build`. Ese es un conjunto de documentos separado de este sitio
público; no confundas los dos árboles.
