/**
 * Echo adapter — a fully offline provider used for tests, demos, and verifying
 * the streaming pipeline without any network or API key. It streams back the
 * last user message word-by-word.
 */
import type {
  GenerationEvent,
  GenerationRequest,
  ImageEvent,
  ImageRequest,
  ModelInfo,
  ProviderModality,
  SpeechEvent,
  SpeechRequest,
  TranscriptionRequest,
  TranscriptionResult,
} from '@neotavern/contracts';
import { ErrorCodes, randomToken } from '@neotavern/shared';
import { estimateRequestTokens, estimateTokens } from '../tokenizer.js';
import type {
  ProviderAdapter,
  ProviderRuntimeConfig,
  TokenCount,
  TokenCountRequest,
  ValidationResult,
} from '../types.js';

/** 1x1 transparent PNG — the offline echo image. */
const ECHO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const ECHO_PNG_MIME = 'image/png';
const ECHO_WAV_MIME = 'audio/wav';

export class EchoAdapter implements ProviderAdapter {
  readonly kind = 'echo';
  readonly modalities: readonly ProviderModality[] = ['text', 'speech', 'transcription', 'image'];
  readonly capabilities = { assistantPrefill: true } as const;

  constructor(private readonly config: ProviderRuntimeConfig = emptyConfig()) {
    void this.config;
  }

  async validateConfig(): Promise<ValidationResult> {
    return { valid: true, issues: [] };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    return [{ id: 'echo', name: 'Echo (offline)', contextLimit: 8192 }];
  }

  async *generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const requestId = randomToken(8);
    yield { type: 'start', requestId };

    const last = request.messages[request.messages.length - 1];
    const reply = last
      ? `You said: "${last.content}". This is the offline echo provider.`
      : 'This is the offline echo provider.';

    // Stream in small chunks so the UI batching path is exercised. Pace the
    // chunks (≈5ms) so the stop/abort path has a real window to act on —
    // an instantaneous stream makes the composer's Stop button unclickable.
    const words = reply.split(/(\s+)/);
    let fullText = '';
    for (const word of words) {
      if (signal.aborted) {
        yield {
          type: 'error',
          code: ErrorCodes.GENERATION_CANCELLED,
          message: 'Generation aborted',
        };
        return;
      }
      if (word.length === 0) continue;
      fullText += word;
      yield { type: 'delta', text: word };
      await new Promise((resolve) => setTimeout(resolve, 12));
    }

    const promptTokens = estimateRequestTokens({
      model: request.model,
      messages: request.messages,
    }).tokens;
    const completionTokens = estimateTokens(fullText);
    yield {
      type: 'done',
      text: fullText,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }

  /**
   * Offline TTS: a valid silent WAV whose length scales with the input, so
   * clients exercise the real audio path without any network.
   */
  async *speech(request: SpeechRequest, signal: AbortSignal): AsyncIterable<SpeechEvent> {
    const requestId = randomToken(8);
    yield { type: 'start', requestId };
    if (signal.aborted) {
      yield {
        type: 'error',
        code: ErrorCodes.GENERATION_CANCELLED,
        message: 'Generation aborted',
      };
      return;
    }
    // ~120ms of silence per input word at 8kHz mono 8-bit.
    const words = Math.max(1, request.input.split(/\s+/).filter(Boolean).length);
    const samples = words * 960;
    const wav = silentWav(samples);
    yield { type: 'audio', dataBase64: toBase64(wav), mime: ECHO_WAV_MIME };
    yield { type: 'done', bytes: wav.byteLength, mime: ECHO_WAV_MIME };
  }

  /** Offline image generation: a 1x1 PNG per requested image. */
  async *image(request: ImageRequest, signal: AbortSignal): AsyncIterable<ImageEvent> {
    const requestId = randomToken(8);
    yield { type: 'start', requestId };
    const count = request.count ?? 1;
    for (let index = 0; index < count; index += 1) {
      if (signal.aborted) {
        yield {
          type: 'error',
          code: ErrorCodes.GENERATION_CANCELLED,
          message: 'Generation aborted',
        };
        return;
      }
      yield { type: 'image', dataBase64: ECHO_PNG_BASE64, mime: ECHO_PNG_MIME };
    }
    yield { type: 'done', count };
  }

  /** Offline transcription: reports the byte size instead of guessing words. */
  async transcribe(
    request: TranscriptionRequest,
    _signal: AbortSignal,
  ): Promise<TranscriptionResult> {
    const bytes = Math.floor((request.audioBase64.length * 3) / 4);
    return { text: `[echo: received ${bytes} bytes of ${request.mime}]` };
  }

  async countTokens(request: TokenCountRequest): Promise<TokenCount> {
    return estimateRequestTokens(request);
  }
}

/** Build a valid PCM WAV (8kHz, 8-bit mono) of silent samples. */
function silentWav(sampleCount: number): Uint8Array {
  const dataSize = sampleCount;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 8000, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);
  const bytes = new Uint8Array(buffer);
  bytes.fill(0x80, 44); // 8-bit unsigned silence
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function emptyConfig(): ProviderRuntimeConfig {
  return { baseUrl: null, model: 'echo', apiKey: null, settings: {} };
}
