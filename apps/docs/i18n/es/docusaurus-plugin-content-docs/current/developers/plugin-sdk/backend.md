---
title: API de backend del plugin
description: Las abstracciones restringidas del lado del servidor que recibe un plugin de backend.
sidebar_position: 5
---

La API de backend es lo que recibe un plugin del lado del servidor en su
llamada `activate()`: abstracciones restringidas para rutas,
almacenamiento, eventos, registro, acceso a la red, proveedores y archivos —
y nada más.

## Punto de Entrada

Un plugin de backend exporta una definición con una función `activate(api)`
que recibe el objeto `ServerPluginApi`:

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const off = api.routes.get('/hello', async (request) => ({
      status: 200,
      body: { hello: 'world' },
    }));
  },
});
```

La entrada de backend se ejecuta como un proceso de Node.js separado. El
plugin nunca recibe la instancia raíz de Fastify, la conexión SQLite, las
tablas internas, las rutas absolutas, el entorno completo ni las claves de
API de otros proveedores.

## Rutas

`api.routes` es un enrutador con ámbito montado bajo
`/api/plugins/{pluginId}/`. Cada método toma una ruta y un manejador, y
devuelve una función de limpieza:

- `api.routes.get(path, handler)`
- `api.routes.post(path, handler)`
- `api.routes.put(path, handler)`
- `api.routes.delete(path, handler)`

Un `PluginRequest` lleva `params`, `query`, `headers`, un `body` JSON
analizado y un `AbortSignal`. Un `PluginResponse` es
`{ status, body, headers }`. Los manejadores pueden devolver un valor
directamente o una promesa; el host impone los tiempos de espera y cancela
el trabajo a través de la señal.

## Almacenamiento

`api.storage` es un almacén de clave/valor con espacio de nombres, aislado
por plugin:

```ts
await api.storage.set('state', { count: 1 });
const state = await api.storage.get('state');
await api.storage.delete('state');
const keys = await api.storage.keys();
```

Los datos tienen el ámbito de tu ID de plugin, por lo que dos plugins nunca
pueden chocar.

## Eventos y Registro

`api.events` es el mismo bus de eventos tipado que usa el frontend.
Suscribirse devuelve una función de cancelación, y todas las suscripciones
se eliminan automáticamente al deshabilitar, fallar o apagar. Emitir está
restringido a tu propio espacio de nombres (`{pluginId}.event`), las cargas
útiles deben ser compatibles con JSON, y el host limita el tamaño de la
carga útil y el número de nombres de eventos por runtime.

`api.logger` proporciona métodos `debug`, `info`, `warn` y `error`, cada uno
con un mensaje y metadatos opcionales. Los registros nunca incluyen
secretos.

## Fetch Verificado por Permisos

`api.fetch` es `fetch` protegido por los permisos `network:<host>` del
plugin:

```ts
const response = await api.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: { Accept: 'application/json' },
  signal,
});
```

Las solicitudes a hosts no concedidos se rechazan antes de cualquier
actividad de red. Los secretos de otros proveedores nunca se inyectan en tus
solicitudes. El objeto de respuesta expone `ok`, `status`, `text()` y
`json()`.

## Proveedores y Estrategias de Contexto

`api.providers` permite que un plugin amplíe la generación:

- `api.providers.register(kind, factory, options)` registra un nuevo tipo de
  adaptador de proveedor (requiere `providers.register`). El registro
  devuelve una función de limpieza.
- `api.providers.registerTokenizer(profile)` registra un tokenizador local
  específico de modelo. Un perfil declara `id`, `approximate`,
  `matches(model)` y `count(text)`. Los tokenizadores exactos pueden
  construirse desde JSON de tokenizador de tiktoken, SentencePiece o Hugging
  Face; hasta que se registre uno para un modelo, el host recurre a una
  heurística consciente de la escritura y marca los conteos como
  aproximados. El registro se elimina automáticamente al desactivar.

`api.contextStrategies.register(strategy)` agrega una estrategia de ajuste
de contexto. El host verifica que los bloques de sistema, fijados y del
usuario actual sobrevivan, y aplica el presupuesto final de tokens por sí
mismo — el valor `fitsBudget` que devuelve una estrategia no es de
confianza.

`api.postProcessors.register(processor)` agrega un hook posterior a la
generación. Se ejecuta después de que el flujo se completa y antes de que se
guarde el mensaje; devolver una cadena nueva reemplaza la respuesta del
asistente. Requiere `prompt.modify`.

## Sistema de Archivos Virtual

`api.files` es un sistema de archivos virtual en sandbox enraizado en el
propio directorio de datos del plugin:

```ts
await api.files.write('notes.txt', 'content');
const content = await api.files.read('notes.txt');
const entries = await api.files.list('.');
await api.files.delete('notes.txt');
```

Las rutas no pueden escapar de la raíz del plugin, por lo que un plugin solo
puede tocar sus propios datos.

## Lo Que No Puede Hacer un Plugin de Backend

La superficie de API es deliberadamente pequeña. No hay forma de alcanzar la
base de datos del host, el almacenamiento de otros plugins, rutas
arbitrarias del sistema de archivos ni hosts de red no verificados. Si el
SDK no lo expone, no es accesible. La
[referencia del Plugin SDK](../../api/plugin-sdk/) generada enumera la
superficie completa de `ServerPluginApi`, y [Proveedores](../providers/index.md)
explica cómo encajan los plugins de proveedor en el modelo.
