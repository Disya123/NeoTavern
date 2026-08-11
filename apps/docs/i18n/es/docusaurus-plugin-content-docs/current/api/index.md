---
title: Referencia del SDK
description: >-
  Información general de la referencia TypeDoc generada automáticamente para
  los cuatro paquetes públicos del SDK.
sidebar_position: 1
---

La Referencia del SDK es una referencia de API generada automáticamente
para los cuatro paquetes públicos de TypeScript que NeoTavern expone a los
autores de plugins, temas y proveedores.

## Qué Se Genera

La referencia la produce TypeDoc desde el punto de entrada `src/index.ts`
de cada paquete durante cada compilación del sitio. Documenta la superficie
exportada exacta de:

- **Plugin SDK** — `@neotavern/plugin-sdk`: validación de manifiesto, el modelo de
  permisos, eventos tipados y los contratos de API de plugins de frontend y
  backend.
- **Theme SDK** — `@neotavern/theme-sdk`: el contrato de tokens de diseño, la
  validación del manifiesto de temas, la resolución de herencia y la
  generación de variables CSS.
- **Provider SDK** — `@neotavern/provider-sdk`: el contrato de adaptador de
  proveedor, los adaptadores integrados, la estimación de tokens y el
  registro de runtime.
- **Contracts** — `@neotavern/contracts`: los esquemas compartidos de solicitud,
  respuesta y entidad de los que derivan tanto las rutas del backend como
  los tipos del frontend.

Las páginas generadas no están escritas a mano y no se confirman en el
repositorio. Se recrean en cada compilación, por lo que siempre coinciden
con el `src/` actual de los paquetes.

## Regenerar la Referencia

Cualquier compilación de Docusaurus regenera la referencia como parte del
pipeline:

```bash
pnpm --filter @neotavern/docs build
```

Ejecuta el mismo comando localmente cuando quieras una referencia nueva
después de cambiar un archivo fuente del SDK.

## Explorar los Paquetes

- [Referencia del Plugin SDK](api/plugin-sdk/)
- [Referencia del Theme SDK](api/theme-sdk/)
- [Referencia del Provider SDK](api/provider-sdk/)
- [Referencia de Contracts](api/contracts/)

Para guías de uso en lugar de listados de API sin procesar, consulta las
secciones Plugin SDK, Theme SDK y Proveedores de esta documentación.
Explican los contratos en prosa, con ejemplos, y enlazan a las páginas
generadas para las firmas precisas.
