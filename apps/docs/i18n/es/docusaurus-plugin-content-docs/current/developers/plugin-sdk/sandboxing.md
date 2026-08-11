---
title: Sandbox de plugins
description: >-
  El modelo de seguridad para el código de plugins no confiable: aislamiento
  de procesos y modo seguro.
sidebar_position: 7
---

El código de plugins no confiable se aísla en cada capa: el backend se
ejecuta en un proceso restringido separado, el frontend se ejecuta en un
iframe en sandbox, y los temas nunca reciben acceso sensible.

## Sin Sandbox de JavaScript

`node:vm` no se usa deliberadamente como sandbox de seguridad. Un sandbox de
intérprete de JavaScript no puede impedir que un atacante decidido alcance
el proceso del host. En su lugar, el aislamiento lo impone el sistema
operativo: procesos separados con capacidades limitadas y contextos de
navegación separados.

## Aislamiento del Backend

Un plugin de backend no confiable se ejecuta en su propio proceso de
Node.js 24 con restricciones:

- Un cargador limitado resuelve solo el ESM local del paquete y la API del
  SDK.
- El proceso no puede importar los integrados de `node:*` más allá de lo que
  permite el cargador, resolver módulos fuera de la raíz del paquete ni
  alcanzar la base de datos del host.
- Todas las capacidades llegan a través de un canal IPC; el host impone los
  permisos en cada llamada.
- El proceso escucha los eventos principales de la aplicación solo a través
  del bus de eventos del SDK, y solo puede emitir bajo su propio espacio de
  nombres.
- Si el proceso falla, el host elimina cada registro que poseía.

El proceso del plugin nunca recibe la raíz de Fastify, la conexión SQLite,
las rutas absolutas, el entorno completo ni las claves de API de otros
proveedores. El acceso a la red se limita a los hosts concedidos a través
del `fetch` verificado por permisos.

## Aislamiento del Frontend

Un plugin de frontend nativo se ejecuta dentro de un iframe en sandbox con
`sandbox="allow-scripts"` y sin `allow-same-origin`:

- El iframe no tiene acceso de mismo origen al documento de la aplicación.
- La comunicación con el host ocurre a través de un único `MessagePort`
  transferido con un nonce de arranque, envoltorios estructurados, plazos y
  cancelación.
- El host monta la interfaz de cada registro en una raíz aislada dentro del
  iframe y se comunica por RPC, por lo que el plugin nunca toca el árbol de
  componentes de React ni el DOM interno.
- Un fallo de la interfaz del plugin solo derriba las raíces y las regiones
  recortadas de ese plugin.

Cada plugin es dueño de un iframe sandbox de viewport completo; el host
agrupa los rectángulos de los montajes activos y recorta el área visible e
interactiva del iframe a su unión, por lo que los eventos de puntero fuera
de una superficie del plugin permanecen en la aplicación.

## Modo Heredado de Confianza

Las entradas `legacy.frontend` y `legacy.backend` son un modo de
compatibilidad de confianza separado para extensiones existentes de
SillyTavern — no un bypass del sandbox nativo. Usar cualquiera de las dos
entradas requiere el permiso `legacy.trusted`, que la interfaz muestra con
una advertencia reforzada, y el usuario debe confirmarlo explícitamente. El
código de frontend heredado se ejecuta en la ventana principal, y el código
de backend heredado recibe un enrutador Express con ámbito en su propio
espacio de nombres `/api/plugins/{pluginId}`. El modo seguro no carga
puntos de entrada heredados en absoluto.

## Temas

Los paquetes de tema están aún más restringidos: un tema no recibe acceso a
chats, claves de API ni al sistema de archivos. Los temas son solo CSS y
diseño declarativo — no hay punto de entrada de JavaScript en el Theme SDK.
Consulta el [modo seguro del Theme SDK](../theme-sdk/safe-mode.md) para la
historia del lado de los temas.

## Modo Seguro

El modo seguro (`?safe=1` en la URL) deshabilita por completo los plugins y
temas de terceros. Se maneja antes de que se cargue el código de plugins o
temas: el CSS de los paquetes y las anulaciones de tokens no se agregan al
documento, y los puntos de entrada de terceros nunca se ejecutan. El tema
integrado y el runtime de plugins integrado permanecen, por lo que la
interfaz siempre se recupera. Salir del modo seguro restaura el estado
activo guardado previamente de plugin y tema.

## Validación de Paquetes

Cada paquete se valida antes de que pueda ejecutarse cualquier código: se
rechazan la traversal de rutas, los enlaces simbólicos, los binarios
nativos y las cargas ejecutables; se verifican los campos del manifiesto,
los puntos de entrada y los permisos; las dependencias de npm se obtienen
con verificaciones de integridad y los scripts de instalación nunca se
ejecutan. Para la historia completa de instalación a desmontaje, consulta
[Ciclo de vida](lifecycle.md).
