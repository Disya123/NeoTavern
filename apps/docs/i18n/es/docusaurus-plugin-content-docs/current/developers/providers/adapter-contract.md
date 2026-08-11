---
title: Contrato de adaptador
description: >-
  Lo que debe implementar todo adaptador de proveedor, desde la validación
  hasta los tiempos de espera.
sidebar_position: 2
---

El contrato de adaptador es el contrato que implementa todo proveedor LLM,
TTS, STT e imágenes. Si escribes un adaptador que lo cumple, todo el
pipeline funciona con tu proveedor.

## La Interfaz

La interfaz `ProviderAdapter` tiene un `kind` estable, declaraciones de
modalidad opcionales y los métodos requeridos. La generación de texto es la
capacidad base; los métodos de voz, imagen y transcripción son opcionales,
por lo que un adaptador solo de LLM sigue siendo un proveedor válido.

```ts
interface ProviderAdapter {
  readonly kind: string;
  readonly modalities?: readonly ProviderModality[];
  readonly capabilities?: {
    assistantPrefill?: boolean;
    textCompletion?: boolean;
  };
  validateConfig(): Promise<ValidationResult>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  speech?(request: SpeechRequest, signal: AbortSignal): AsyncIterable<SpeechEvent>;
  image?(request: ImageRequest, signal: AbortSignal): AsyncIterable<ImageEvent>;
  transcribe?(request: TranscriptionRequest, signal: AbortSignal): Promise<TranscriptionResult>;
  countTokens?(request: TokenCountRequest): Promise<TokenCount>;
}
```

## Comportamiento Requerido

El contrato requiere ocho comportamientos:

- **Validación de configuración** — `validateConfig()` verifica la propia
  configuración del adaptador sin hacer llamadas de red y devuelve una lista
  de problemas.
- **Enumeración de modelos** — `listModels(signal)` devuelve los modelos
  disponibles y debe respetar la señal de aborto.
- **Cancelación** — todo método de larga duración recibe un `AbortSignal` y
  debe abortar con prontitud cuando se dispara.
- **Flujo de eventos unificado** — `generate()` produce un flujo de
  `GenerationEvent`s tipados y debe terminar con exactamente un evento
  terminal, `done` o `error`. La generación de voz e imágenes usa la misma
  forma de streaming.
- **Normalización de errores** — los fallos del proveedor se mapean a códigos
  `AppError` estables con códigos y parámetros legibles por máquina. Los
  estados HTTP del proveedor se diferencian (auth, límite de tasa, modelo
  incorrecto, error del servidor), y los cuerpos del proveedor sin procesar
  nunca se reenvían a los clientes.
- **Tiempos de espera** — un adaptador no debe confiar solo en la señal del
  llamador. Necesita sus propios plazos para la conexión, el silencio de
  streaming inactivo y las lecturas completas de respuesta. El SDK incluye
  `ProviderTimeouts` (valores predeterminados: 30 s de conexión, 60 s de
  inactividad, 30 s de lectura) y un `DeadlineController` que combina la
  señal del llamador con plazos re-armables y aborta con un error `TIMEOUT`.
- **Registro seguro** — la clave de API se proporciona desde un
  almacenamiento seguro y nunca debe registrarse, ni incluirse en el
  diagnóstico ni en la salida de errores.
- **Registro** — los adaptadores se registran por tipo, ya sea en el
  registro del núcleo o a través de la API de backend del Plugin SDK.

## Neutralidad de Proveedores

El núcleo no está atado a ningún SDK de proveedores. Se espera que los
adaptadores nuevos usen el `fetch` global y el analizador SSE del SDK
(`parseSseStream`) para las respuestas en streaming.

Hay exactamente una excepción documentada: el adaptador de Anthropic usa
`@anthropic-ai/sdk`, porque la API de Anthropic — pensamiento extendido y
soporte de encabezados beta — se maneja con más precisión con el SDK
oficial que con un cliente fetch escrito a mano. Es el único adaptador
conectado a una biblioteca de proveedor; todo lo demás habla HTTP
directamente.

## Integración con el Host

El `ProviderRegistry` mapea los tipos de proveedor a fábricas de
adaptadores. `register` devuelve una función de anulación de registro,
`create` instancia un adaptador y lanza `PROVIDER_NOT_FOUND` para tipos
desconocidos, y el registro también aloja el registro local de
tokenizadores. Las capacidades de cable declaradas como `assistantPrefill`
se usan para validar los perfiles de conexión — el host nunca descarta en
silencio una anulación de perfil persistida que un adaptador no soporta.

Para los adaptadores reales incluidos y a qué apunta cada uno, consulta
[Adaptadores](adapters.md). Para registrar un adaptador desde un plugin,
consulta la [API de backend del Plugin SDK](../plugin-sdk/backend.md).
