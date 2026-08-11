import {
  ReasoningEfforts,
  type GenerationParameterId,
  type ProviderCatalogEntry,
  type ProviderSourceId,
} from '@neotavern/contracts';
import { AI_HORDE_SAMPLERS } from './adapters/aiHorde.js';
import { KOBOLDAI_SAMPLERS } from './adapters/koboldai.js';
import { NOVELAI_SAMPLERS } from './adapters/novelai.js';

const STANDARD_SAMPLERS = [
  'temperature',
  'topP',
] as const satisfies readonly GenerationParameterId[];

// Must stay in sync with what OpenAICompatibleAdapter maps onto the body:
// `reasoning` (the boolean) is not sent by the adapter and was removed
// (PROV-33 L1) so the UI cannot offer a silently-dropped parameter.
const EXTENDED_SAMPLERS = [
  ...STANDARD_SAMPLERS,
  'frequencyPenalty',
  'presencePenalty',
  'seed',
  'reasoningEffort',
  'topK',
  'minP',
  'topA',
  'repetitionPenalty',
] as const satisfies readonly GenerationParameterId[];

/** Samplers commonly accepted by local text-completion backends. */
const TEXT_SAMPLERS = [
  ...STANDARD_SAMPLERS,
  'frequencyPenalty',
  'presencePenalty',
  'seed',
  'topK',
  'minP',
  'topA',
  'repetitionPenalty',
] as const satisfies readonly GenerationParameterId[];

/** Built-in connection sources exposed by the provider settings UI and API. */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  compatible('nanogpt', 'https://nano-gpt.com/api/v1', EXTENDED_SAMPLERS, [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ]),
  compatible('openai', 'https://api.openai.com/v1', [
    ...STANDARD_SAMPLERS,
    'frequencyPenalty',
    'presencePenalty',
    'seed',
    'reasoningEffort',
  ]),
  {
    id: 'openai-compatible',
    adapterKind: 'openai-compatible',
    defaultBaseUrl: null,
    apiKeyRequired: false,
    baseUrlEditable: true,
    samplerSupport: [...EXTENDED_SAMPLERS],
    reasoningEfforts: [...ReasoningEfforts],
  },
  {
    id: 'anthropic',
    adapterKind: 'anthropic',
    defaultBaseUrl: null,
    apiKeyRequired: true,
    baseUrlEditable: false,
    samplerSupport: ['reasoning', 'reasoningEffort'],
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  compatible('deepseek', 'https://api.deepseek.com'),
  compatible('google-ai-studio', 'https://generativelanguage.googleapis.com/v1beta/openai', [
    ...STANDARD_SAMPLERS,
    'reasoningEffort',
  ]),
  compatible('groq', 'https://api.groq.com/openai/v1'),
  compatible('fireworks-ai', 'https://api.fireworks.ai/inference/v1'),
  compatible('cohere', 'https://api.cohere.com/compatibility/v1'),
  compatible('mistralai', 'https://api.mistral.ai/v1'),
  compatible('chutes', 'https://llm.chutes.ai/v1'),
  compatible('electron-hub', 'https://api.electronhub.ai/v1'),
  // Text-completion backends (classic SillyTavern "Text Completion" API). They
  // consume a serialized prompt via an OpenAI-compatible /v1/completions
  // endpoint (or Kobold /api/v1/generate for the generic source).
  textCompletion('text-completion', null),
  textCompletion('ooba', 'http://127.0.0.1:5000/v1'),
  textCompletion('koboldcpp', 'http://127.0.0.1:5001/v1'),
  textCompletion('vllm', 'http://127.0.0.1:8000/v1'),
  textCompletion('ollama', 'http://127.0.0.1:11434/v1'),
  // Standalone classic SillyTavern backends.
  {
    id: 'novelai',
    adapterKind: 'novelai',
    defaultBaseUrl: 'https://api.novelai.net',
    apiKeyRequired: true,
    baseUrlEditable: true,
    samplerSupport: [...NOVELAI_SAMPLERS],
  },
  {
    id: 'ai-horde',
    adapterKind: 'ai-horde',
    defaultBaseUrl: 'https://stablehorde.net',
    apiKeyRequired: false,
    baseUrlEditable: true,
    samplerSupport: [...AI_HORDE_SAMPLERS],
  },
  {
    id: 'koboldai',
    adapterKind: 'koboldai',
    defaultBaseUrl: null,
    apiKeyRequired: false,
    baseUrlEditable: true,
    samplerSupport: [...KOBOLDAI_SAMPLERS],
  },
];

const CATALOG_BY_ID = Object.fromEntries(
  PROVIDER_CATALOG.map((entry) => [entry.id, entry]),
) as Record<ProviderSourceId, ProviderCatalogEntry>;
/** Return the catalog entry for a built-in source id. */
export function getProviderCatalogEntry(source: ProviderSourceId): ProviderCatalogEntry {
  return CATALOG_BY_ID[source];
}

/** Safely resolve an unknown persisted settings.source value. */
export function findProviderCatalogEntry(source: unknown): ProviderCatalogEntry | undefined {
  return typeof source === 'string' ? CATALOG_BY_ID[source as ProviderSourceId] : undefined;
}

function compatible(
  id: Exclude<
    ProviderSourceId,
    'openai-compatible' | 'anthropic' | 'text-completion' | 'novelai' | 'ai-horde' | 'koboldai'
  >,
  defaultBaseUrl: string,
  samplerSupport: readonly GenerationParameterId[] = STANDARD_SAMPLERS,
  reasoningEfforts?: ProviderCatalogEntry['reasoningEfforts'],
): ProviderCatalogEntry {
  return {
    id,
    adapterKind: 'openai-compatible',
    defaultBaseUrl,
    apiKeyRequired: true,
    baseUrlEditable: true,
    samplerSupport: [...samplerSupport],
    ...(reasoningEfforts ? { reasoningEfforts: [...reasoningEfforts] } : {}),
  };
}

/** A local/OpenAI-compatible text-completion source (prompt serialized as text). */
function textCompletion(
  id: 'text-completion' | 'ooba' | 'koboldcpp' | 'vllm' | 'ollama',
  defaultBaseUrl: string | null,
): ProviderCatalogEntry {
  return {
    id,
    adapterKind: 'text-completion',
    defaultBaseUrl,
    apiKeyRequired: false,
    baseUrlEditable: true,
    samplerSupport: [...TEXT_SAMPLERS],
  };
}
