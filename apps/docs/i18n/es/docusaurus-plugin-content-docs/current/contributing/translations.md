---
title: Traducciones
description: >-
  Contribuye una traducción del sitio de documentación de NeoTavern o mejora
  una existente
sidebar_position: 5
---

El sitio de documentación se publica en inglés más ocho locales, y cada
traducción es una contribución de la comunidad. Esta página explica cómo
contribuir una o corregir una existente.

## Locales Actuales

El idioma base es el inglés. Los locales traducidos son ruso (`ru`), chino
simplificado (`zh-Hans`), japonés (`ja`), coreano (`ko`), español (`es`),
francés (`fr`), alemán (`de`) y portugués de Brasil (`pt-BR`).

## Dónde Viven las Traducciones

Cada locale refleja el árbol en inglés bajo `apps/docs/i18n/`:

```
apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/<path>.md
```

Las cadenas de interfaz — la barra de navegación, el pie de página, el
tagline y las etiquetas de la barra lateral — viven en archivos JSON bajo
`apps/docs/i18n/<locale>/docusaurus-theme-classic/`, generados por el
comando write-translations.

## Integridad

Cada página en inglés debería tener una contraparte traducida en la misma
ruta relativa. Las páginas sin traducir recurren automáticamente al inglés,
por lo que el progreso parcial es visible de inmediato — pero apunta a la
cobertura completa y nunca envíes archivos a medio traducir.

## Qué Traducir

- Encabezados, texto del cuerpo, leyendas y texto alternativo.
- El `title` y la `description` del front matter; mantén `sidebar_position`
  idéntico.
- Las etiquetas de `_category_.json`.

## Qué Dejar Intacto

- Enlaces, bloques de código, código en línea y sintaxis de admoniciones
  (`:::note` ... `:::`), byte por byte.
- El nombre del producto: NeoTavern nunca se traduce.
- Los identificadores de API, nombres de archivo, comandos y banderas
  permanecen en su forma en inglés.

## Terminología

Usa la redacción de la interfaz de la propia app donde exista; de lo
contrario, usa el término comunitario estándar en tu idioma. Donde ya
exista un término comunitario estándar, prefíjalo — nunca inventes una
palabra nueva.

## Corregir una Traducción

Edita el archivo de tu locale en la misma ruta relativa y abre un pull
request. Cuando cambie la fuente en inglés de una página, actualiza la
traducción de esa página en el mismo cambio.

## Agregar un Locale Nuevo

1. Agrega el código del locale y su etiqueta visible a `i18n.locales` y
   `localeConfigs` en `apps/docs/docusaurus.config.ts`.
2. Prepara la carpeta del locale:

   ```bash
   pnpm docs:translations -- --locale <code>
   ```

3. Traduce cada página bajo
   `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/` y los
   archivos JSON generados.
4. Abre un pull request que contenga tanto el cambio de configuración como
   los archivos nuevos.

Los códigos de locale siguen convenciones estándar, por ejemplo `zh-Hans`
para chino simplificado y `pt-BR` para portugués de Brasil.
