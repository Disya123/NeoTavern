/**
 * Contract schema tests (ТЗ §17 plugin/API contract coverage): schemas accept
 * valid payloads, reject invalid ones, and apply documented defaults.
 */
import { describe, expect, it } from 'vitest';
import {
  AppSettingsUpdateSchema,
  BuiltinProviderKinds,
  BrokerCallRequestSchema,
  BrokerCallResultSchema,
  BrokerRevokeCommandSchema,
  BrokerTrustLevel,
  BROKER_DEFAULT_DEADLINE_MS,
  BROKER_MAX_CAUSAL_CHAIN,
  BROKER_MAX_DEADLINE_MS,
  CharacterCardV2Schema,
  CustomExcludeBodySchema,
  CustomIncludeBodySchema,
  CustomIncludeHeadersSchema,
  EVENTS_MAX_NAME_BYTES,
  EVENTS_MAX_REPLAY_LIMIT,
  EVENTS_MAX_SUBSCRIPTIONS_PER_PLUGIN,
  EVENTS_MAX_WAITERS,
  EVENTS_MAX_WAIT_MS,
  EVENTS_PER_NAME,
  EVENTS_TOTAL,
  EVENTS_TTL_MS,
  FORBIDDEN_CUSTOM_HEADERS,
  GenerationEventSchema,
  GenerationRequestSchema,
  ReasoningEfforts,
  MemoryCreateSchema,
  MessageCreateSchema,
  MessageGenerationMetaSchema,
  MessageGenerationUsageSchema,
  MessageUpdateSchema,
  PluginRuntimeBridgeMessageSchema,
  PluginRuntimeFatalDiagnosticBodySchema,
  PluginRuntimeLogBatchPayloadSchema,
  PLUGIN_RUNTIME_FATAL_MAX_BYTES,
  PLUGIN_RUNTIME_LOG_BATCH_MAX_BYTES,
  PLUGIN_RUNTIME_LOG_BATCH_MAX_RECORDS,
  PLUGIN_RUNTIME_LOG_MAX_COALESCED_COUNT,
  PLUGIN_RUNTIME_LOG_MAX_MESSAGE_BYTES,
  PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES,
  PromptPostProcessingModeSchema,
  ProviderCatalogEntrySchema,
  ProviderSecretCreateSchema,
  ProviderSecretSchema,
  ProviderSourceIds,
  SearchQuerySchema,
  SdkEventsReplayArgsSchema,
  SdkEventsReplayResultSchema,
  SdkEventsSubscribeArgsSchema,
  SdkEventsSubscribeResultSchema,
  SdkEventsUnsubscribeArgsSchema,
  SdkEventsUnsubscribeResultSchema,
  SdkKvDeleteArgsSchema,
  SdkKvGetArgsSchema,
  SdkKvListArgsSchema,
  SdkKvSetArgsSchema,
  SdkChatsListArgsSchema,
  SdkChatsListResultSchema,
  SdkChatsReadArgsSchema,
  SdkChatsReadResultSchema,
  SdkCharactersListArgsSchema,
  SdkCharactersListResultSchema,
  SdkCharactersReadArgsSchema,
  SdkCharactersReadResultSchema,
  SdkLorebookEntriesArgsSchema,
  SdkLorebookEntriesResultSchema,
  SdkLorebookListArgsSchema,
  SdkLorebookListResultSchema,
  SdkLorebookReadArgsSchema,
  SdkLorebookReadResultSchema,
  SdkDatabaseQueryArgsSchema,
  SdkDatabaseQueryResultSchema,
  SdkFilesPathArgsSchema,
  SdkFilesRenameArgsSchema,
  SdkFilesWriteArgsSchema,
  SdkModelsListArgsSchema,
  SdkModelsListResultSchema,
  SdkNetworkFetchArgsSchema,
  SdkNetworkFetchResultSchema,
  SdkNetworkListenAcceptArgsSchema,
  SdkNetworkListenOpenArgsSchema,
  SdkNetworkSocketIdArgsSchema,
  SdkNetworkSocketReceiveArgsSchema,
  SdkNetworkSocketSendArgsSchema,
  SdkNetworkTcpConnectArgsSchema,
  SdkNetworkUdpOpenArgsSchema,
  SdkNetworkUdpSendArgsSchema,
  SdkNetworkWebsocketOpenArgsSchema,
  SdkProcessIdArgsSchema,
  SdkProcessOutputArgsSchema,
  SdkProcessSignalArgsSchema,
  SdkProcessSpawnArgsSchema,
  SdkJobsRegisterArgsSchema,
  SdkJobsCancelArgsSchema,
  SdkJobsListArgsSchema,
  SdkServicesProvideArgsSchema,
  SdkServicesConnectArgsSchema,
  SdkServicesRespondArgsSchema,
  SdkSecretsUseArgsSchema,
  SdkSecretsManageOwnArgsSchema,
  SdkSecretsRevealArgsSchema,
  SdkSettingsGetArgsSchema,
  SdkSettingsSetArgsSchema,
  SDK_OPERATION_CATALOG,
  SDK_MAX_KV_KEY_BYTES,
  SDK_MAX_KV_VALUE_BYTES,
  SDK_MAX_SETTINGS_PATH_BYTES,
  SDK_MAX_SETTINGS_VALUE_BYTES,
  SdkOperationMethod,
  CHATS_MAX_LIST,
  CHATS_MAX_CURSOR_BYTES,
  CHARACTERS_MAX_LIST,
  CHARACTERS_MAX_CURSOR_BYTES,
  LOREBOK_MAX_ENTRIES,
  LOREBOK_MAX_LIST,
  LOREBOK_MAX_CURSOR_BYTES,
  DATABASE_MAX_COLUMNS,
  DATABASE_MAX_PARAMS,
  DATABASE_MAX_ROWS,
  DATABASE_MAX_SQL_BYTES,
  MODELS_MAX_LIST,
  NETWORK_MAX_BODY_BYTES,
  NETWORK_MAX_HEADERS,
  NETWORK_MAX_HEADER_NAME_BYTES,
  NETWORK_MAX_HEADER_VALUE_BYTES,
  NETWORK_MAX_REDIRECTS,
  NETWORK_MAX_SECRET_ID_BYTES,
  NETWORK_MAX_URL_BYTES,
  NETWORK_POOL_CONNECT_TIMEOUT_MS,
  NETWORK_POOL_KEEP_ALIVE_MS,
  NETWORK_POOL_MAX_FREE_SOCKETS,
  NETWORK_POOL_MAX_SOCKETS_PER_ORIGIN,
  NETWORK_SCOPE_CAPABILITIES,
  NETWORK_SCOPE_LOCAL,
  NETWORK_SCOPE_METADATA,
  NETWORK_SCOPE_PRIVATE,
  DEFAULT_NETWORK_SCOPE,
  PluginRuntimeFrameType,
  RPC_STREAM_CHUNK_BYTES,
  RPC_STREAM_INITIAL_CREDIT_BYTES,
  RPC_STREAM_MAX_ACCUMULATED_BYTES,
  RPC_STREAM_MAX_CONCURRENT,
  SpeechRequestSchema,
  TextAdapterKinds,
  isValid,
  maskSecretValue,
  parseMessageGenerationMeta,
  validateSchema,
} from '../src/index.js';

const PROVIDER_ID = '018f0000-0000-7000-8000-000000000001';

describe('contracts', () => {
  it('validates SearchQuery bounds and the new sort/tag fields', () => {
    // Defaults are applied by the Fastify schema layer, not validateSchema —
    // here we verify accept/reject semantics and field constraints.
    const decoded = validateSchema(SearchQuerySchema, { q: 'hero', limit: 7 });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.limit).toBe(7);

    expect(isValid(SearchQuerySchema, { q: '' })).toBe(false);
    expect(isValid(SearchQuerySchema, { q: 'x', limit: 0 })).toBe(false);
    expect(isValid(SearchQuerySchema, { q: 'x', limit: 201 })).toBe(false);
    expect(isValid(SearchQuerySchema, { q: 'x', sort: 'usage' })).toBe(false);
    expect(isValid(SearchQuerySchema, { q: 'x', sort: 'relevance', tag: 'fantasy' })).toBe(true);
    expect(isValid(SearchQuerySchema, { q: 'x', sort: 'date' })).toBe(true);
  });

  it('validates message creation input', () => {
    expect(isValid(MessageCreateSchema, { role: 'user', content: 'hi' })).toBe(true);
    expect(isValid(MessageCreateSchema, { role: 'martian', content: 'hi' })).toBe(false);
    // rev4 chats: plugin-authored narration is a first-class role.
    expect(isValid(MessageCreateSchema, { role: 'plugin', content: 'hi' })).toBe(true);
    expect(isValid(MessageUpdateSchema, { role: 'assistant', content: 'done' })).toBe(true);
    expect(isValid(MessageCreateSchema, { role: 'user' })).toBe(false);
  });

  it('parses meta.generation into a typed object and rejects malformed values', () => {
    const valid = {
      generationId: '018f0000-0000-7000-8000-000000000001',
      providerConfigId: '018f0000-0000-7000-8000-000000000002',
      providerKind: 'echo',
      providerSource: 'manual',
      model: 'echo',
      durationMs: 42,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
    expect(isValid(MessageGenerationMetaSchema, valid)).toBe(true);
    expect(
      isValid(MessageGenerationUsageSchema, {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      }),
    ).toBe(true);
    expect(parseMessageGenerationMeta(valid)).toEqual(valid);

    // Echo fallback: no configured provider — nulls, never fabricated strings.
    const fallback = { ...valid, providerConfigId: null, providerKind: null, providerSource: null };
    expect(parseMessageGenerationMeta(fallback)).toEqual(fallback);

    // The parser is a safe reader: null for missing/malformed, never throws.
    expect(parseMessageGenerationMeta(undefined)).toBeNull();
    expect(parseMessageGenerationMeta(null)).toBeNull();
    expect(parseMessageGenerationMeta('nope')).toBeNull();
    expect(parseMessageGenerationMeta(42)).toBeNull();
    expect(parseMessageGenerationMeta({})).toBeNull();
    expect(parseMessageGenerationMeta({ ...valid, generationId: '' })).toBeNull();
    expect(parseMessageGenerationMeta({ ...valid, generationId: 7 })).toBeNull();
    expect(parseMessageGenerationMeta({ ...valid, providerKind: '' })).toBeNull();
    expect(parseMessageGenerationMeta({ ...valid, model: '' })).toBeNull();
    expect(parseMessageGenerationMeta({ ...valid, durationMs: -1 })).toBeNull();
    expect(parseMessageGenerationMeta({ ...valid, durationMs: 1.5 })).toBeNull();
    expect(parseMessageGenerationMeta({ ...valid, durationMs: '42' })).toBeNull();
    expect(parseMessageGenerationMeta({ ...valid, usage: null })).toEqual({
      ...valid,
      usage: null,
    });
    expect(parseMessageGenerationMeta({ ...valid, usage: {} })).toBeNull();
    expect(parseMessageGenerationMeta({ ...valid, usage: { promptTokens: 1 } })).toBeNull();
    expect(
      parseMessageGenerationMeta({
        ...valid,
        usage: { promptTokens: -1, completionTokens: 0, totalTokens: -1 },
      }),
    ).toBeNull();
    expect(parseMessageGenerationMeta({ ...valid, usage: 'x' })).toBeNull();
    expect(parseMessageGenerationMeta([...Object.entries(valid)])).toBeNull();

    // `meta` is an open Record: extra top-level keys are allowed and ignored
    // so future fields never break readers of messages written today.
    expect(parseMessageGenerationMeta({ ...valid, reasoning: 'low' })).toEqual(valid);
  });

  it('discriminates generation event unions', () => {
    expect(isValid(GenerationEventSchema, { type: 'start', requestId: 'abc' })).toBe(true);
    expect(isValid(GenerationEventSchema, { type: 'delta', text: 'x' })).toBe(true);
    expect(isValid(GenerationEventSchema, { type: 'done', text: 'x' })).toBe(true);
    expect(isValid(GenerationEventSchema, { type: 'error', code: 'E', message: 'm' })).toBe(true);
    expect(isValid(GenerationEventSchema, { type: 'bogus' })).toBe(false);
    expect(isValid(GenerationEventSchema, { type: 'delta' })).toBe(false);
  });

  it('accepts the full provider-neutral reasoning effort superset', () => {
    const request = {
      model: 'reasoning-model',
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 1024,
      temperature: 1,
      stream: true,
    };
    for (const reasoningEffort of ReasoningEfforts) {
      expect(isValid(GenerationRequestSchema, { ...request, reasoningEffort })).toBe(true);
    }
    expect(isValid(GenerationRequestSchema, { ...request, reasoningEffort: 'ultra' })).toBe(false);
  });

  it('enforces the Character Card V2 shape', () => {
    const minimal = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'n',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {},
      },
    };
    expect(isValid(CharacterCardV2Schema, minimal)).toBe(true);
    expect(isValid(CharacterCardV2Schema, { ...minimal, spec: 'chara_card_v1' })).toBe(false);
  });

  it('validates memory creation input', () => {
    expect(isValid(MemoryCreateSchema, { content: 'User prefers tea.' })).toBe(true);
    expect(
      isValid(MemoryCreateSchema, { content: 'x', scope: 'character', characterId: null }),
    ).toBe(true);
    expect(isValid(MemoryCreateSchema, { content: '' })).toBe(false);
    expect(isValid(MemoryCreateSchema, { content: 'x', scope: 'galaxy' })).toBe(false);
  });

  it('validates speech (TTS) requests', () => {
    expect(isValid(SpeechRequestSchema, { model: 'echo', input: 'hello' })).toBe(true);
    expect(isValid(SpeechRequestSchema, { model: 'echo', input: '' })).toBe(false);
    expect(isValid(SpeechRequestSchema, { model: 'echo', input: 'x', format: 'flac' })).toBe(false);
  });

  describe('provider secrets', () => {
    it('masks values, keeping only a short suffix visible', () => {
      expect(maskSecretValue('')).toBe('');
      expect(maskSecretValue('abc')).toBe('•••');
      expect(maskSecretValue('sk-abcdefgh1234')).toBe('••••••••1234');
      // Never leaks more than the visible suffix.
      expect(maskSecretValue('sk-abcdefgh1234')).not.toContain('abcd');
    });

    it('rejects a secret value smuggled into the public projection', () => {
      const projection = {
        id: '018f0000-0000-7000-8000-000000000001',
        providerId: '018f0000-0000-7000-8000-000000000002',
        label: 'primary',
        active: true,
        masked: '••••••••1234',
        createdAt: 1,
      };
      expect(isValid(ProviderSecretSchema, projection)).toBe(true);
      // `value` is write-only and must not be accepted on the public schema.
      expect(isValid(ProviderSecretSchema, { ...projection, value: 'sk-leak' })).toBe(false);
    });

    it('bounds the create payload value length', () => {
      expect(isValid(ProviderSecretCreateSchema, { value: 'sk-x', label: 'a' })).toBe(true);
      expect(isValid(ProviderSecretCreateSchema, { value: '' })).toBe(true);
      expect(isValid(ProviderSecretCreateSchema, { value: 'x'.repeat(8193) })).toBe(false);
      expect(isValid(ProviderSecretCreateSchema, { value: 'x', label: 'y'.repeat(201) })).toBe(
        false,
      );
      expect(isValid(ProviderSecretCreateSchema, {})).toBe(false);
    });
  });

  describe('auto-connect and last server', () => {
    it('accepts autoConnect and a well-formed lastServer on the update schema', () => {
      expect(isValid(AppSettingsUpdateSchema, { autoConnect: true })).toBe(true);
      expect(isValid(AppSettingsUpdateSchema, { autoConnect: false })).toBe(true);
      expect(
        isValid(AppSettingsUpdateSchema, {
          lastServer: { providerConfigId: PROVIDER_ID, source: 'openai', model: 'gpt-4o' },
        }),
      ).toBe(true);
      // providerConfigId alone is enough; source/model are optional.
      expect(
        isValid(AppSettingsUpdateSchema, { lastServer: { providerConfigId: PROVIDER_ID } }),
      ).toBe(true);
      // Explicit null clears the last server.
      expect(isValid(AppSettingsUpdateSchema, { lastServer: null })).toBe(true);
    });

    it('rejects a malformed lastServer', () => {
      // providerConfigId must be a non-empty id.
      expect(isValid(AppSettingsUpdateSchema, { lastServer: { providerConfigId: '' } })).toBe(
        false,
      );
      // additionalProperties is closed.
      expect(
        isValid(AppSettingsUpdateSchema, {
          lastServer: { providerConfigId: PROVIDER_ID, surprise: 1 },
        }),
      ).toBe(false);
      expect(isValid(AppSettingsUpdateSchema, { lastServer: {} })).toBe(false);
    });
  });

  describe('prompt post-processing and additional parameters', () => {
    it('accepts every documented post-processing mode and rejects unknowns', () => {
      for (const mode of [
        '',
        'merge',
        'merge_tools',
        'semi',
        'semi_tools',
        'strict',
        'strict_tools',
        'single',
      ]) {
        expect(isValid(PromptPostProcessingModeSchema, mode)).toBe(true);
      }
      expect(isValid(PromptPostProcessingModeSchema, 'bogus')).toBe(false);
      expect(isValid(PromptPostProcessingModeSchema, null)).toBe(false);
    });

    it('validates the additional-parameter shapes', () => {
      expect(isValid(CustomIncludeBodySchema, { top_k: 20, repetition_penalty: 1.1 })).toBe(true);
      expect(isValid(CustomIncludeBodySchema, { nested: { a: 1 } })).toBe(true);
      expect(isValid(CustomIncludeBodySchema, 'nope')).toBe(false);

      expect(isValid(CustomExcludeBodySchema, ['frequency_penalty', 'presence_penalty'])).toBe(
        true,
      );
      expect(isValid(CustomExcludeBodySchema, [])).toBe(true);
      expect(isValid(CustomExcludeBodySchema, ['ok', 1])).toBe(false);
      expect(isValid(CustomExcludeBodySchema, 'frequency_penalty')).toBe(false);

      expect(isValid(CustomIncludeHeadersSchema, { 'X-Custom': 'value' })).toBe(true);
      expect(isValid(CustomIncludeHeadersSchema, { 'X-Custom': 1 })).toBe(false);
    });

    it('protects the headers that custom values may never override', () => {
      expect(FORBIDDEN_CUSTOM_HEADERS).toContain('authorization');
      expect(FORBIDDEN_CUSTOM_HEADERS).toContain('content-type');
      expect(FORBIDDEN_CUSTOM_HEADERS).toContain('content-length');
    });
  });

  describe('provider kinds, sources and catalog', () => {
    it('lists the classic SillyTavern backends as built-in kinds', () => {
      expect(BuiltinProviderKinds).toEqual(
        expect.arrayContaining(['text-completion', 'novelai', 'ai-horde', 'koboldai']),
      );
    });

    it('accepts the new sources and adapter kinds in the catalog schema', () => {
      const entry = {
        id: 'novelai',
        adapterKind: 'novelai',
        defaultBaseUrl: 'https://api.novelai.net',
        apiKeyRequired: true,
        baseUrlEditable: true,
        samplerSupport: ['temperature', 'topP'],
      };
      expect(isValid(ProviderCatalogEntrySchema, entry)).toBe(true);
      expect(
        isValid(ProviderCatalogEntrySchema, {
          ...entry,
          reasoningEfforts: ['none', 'low', 'xhigh'],
        }),
      ).toBe(true);
      expect(
        isValid(ProviderCatalogEntrySchema, {
          ...entry,
          id: 'ooba',
          adapterKind: 'text-completion',
        }),
      ).toBe(true);
      expect(isValid(ProviderCatalogEntrySchema, { ...entry, adapterKind: 'not-a-kind' })).toBe(
        false,
      );
    });

    it('classifies text adapter kinds', () => {
      expect(TextAdapterKinds).toEqual(
        expect.arrayContaining(['text-completion', 'novelai', 'ai-horde', 'koboldai']),
      );
      expect(ProviderSourceIds).toEqual(
        expect.arrayContaining(['novelai', 'ai-horde', 'koboldai', 'ooba', 'koboldcpp']),
      );
    });
  });

  describe('capability broker contracts (Stage C)', () => {
    const brokerCall = {
      requestId: 'req-0001-aaaaaaaa',
      caller: { pluginId: 'plugin-a', installationId: 'inst-a', trustLevel: 'sandbox' },
      method: 'echo',
      args: { x: 1 },
      capability: { name: 'services.connect' },
      deadlineAt: 1_800_000_000_000,
      causalChain: [],
    };

    it('accepts a well-formed broker call and rejects malformed ones', () => {
      expect(isValid(BrokerCallRequestSchema, brokerCall)).toBe(true);
      expect(isValid(BrokerCallRequestSchema, { ...brokerCall, requestId: 'short' })).toBe(false);
      expect(
        isValid(BrokerCallRequestSchema, {
          ...brokerCall,
          caller: { pluginId: 'p', installationId: 'i', trustLevel: 'root' },
        }),
      ).toBe(false);
      expect(isValid(BrokerCallRequestSchema, { ...brokerCall, causalChain: [42] })).toBe(false);
      expect(
        isValid(BrokerCallRequestSchema, {
          ...brokerCall,
          causalChain: Array.from({ length: 17 }, (_, i) => `p${i}`),
        }),
      ).toBe(false);
      expect(isValid(BrokerCallRequestSchema, { ...brokerCall, method: 'x'.repeat(257) })).toBe(
        false,
      );
      expect(isValid(BrokerCallRequestSchema, { ...brokerCall, extraField: 'rejected' })).toBe(
        false,
      );
    });

    it('validates broker call results and revoke commands', () => {
      expect(
        isValid(BrokerCallResultSchema, {
          requestId: brokerCall.requestId,
          ok: true,
          result: { hello: 'world' },
        }),
      ).toBe(true);
      expect(
        isValid(BrokerCallResultSchema, {
          requestId: brokerCall.requestId,
          ok: false,
          error: { code: 'CAPABILITY_DENIED', message: 'CAPABILITY_DENIED', retryable: false },
        }),
      ).toBe(true);
      expect(
        isValid(BrokerCallResultSchema, {
          requestId: brokerCall.requestId,
          ok: false,
          error: { code: 'X', message: 'y' },
        }),
      ).toBe(false);
      expect(
        isValid(BrokerRevokeCommandSchema, {
          kind: 'broker-revoke',
          pluginId: 'plugin-a',
          name: 'services.connect',
          revision: 3,
          reason: 'user revoked',
        }),
      ).toBe(true);
      expect(
        isValid(BrokerRevokeCommandSchema, { kind: 'broker-revoke', pluginId: 'plugin-a' }),
      ).toBe(false);
    });

    it('keeps bridge rpc messages typed to broker envelopes', () => {
      expect(
        isValid(PluginRuntimeBridgeMessageSchema, {
          kind: 'rpc-request',
          call: brokerCall,
        }),
      ).toBe(true);
      expect(
        isValid(PluginRuntimeBridgeMessageSchema, {
          kind: 'rpc-request',
          requestId: brokerCall.requestId,
          method: 'echo',
        }),
      ).toBe(false);
      expect(
        isValid(PluginRuntimeBridgeMessageSchema, {
          kind: 'rpc-response',
          requestId: brokerCall.requestId,
          ok: true,
          result: 42,
        }),
      ).toBe(true);
    });

    it('exposes broker trust levels and limits as stable constants', () => {
      expect(BrokerTrustLevel).toEqual({
        SANDBOX: 'sandbox',
        EXTENDED: 'extended',
        TRUSTED: 'trusted',
      });
      expect(BROKER_MAX_CAUSAL_CHAIN).toBe(16);
      expect(BROKER_DEFAULT_DEADLINE_MS).toBe(10_000);
      expect(BROKER_MAX_DEADLINE_MS).toBe(60_000);
    });
  });

  describe('core sdk operation contracts (Stage D)', () => {
    it('validates kv operation args and results', () => {
      expect(isValid(SdkKvGetArgsSchema, { key: 'greeting' })).toBe(true);
      expect(isValid(SdkKvGetArgsSchema, { key: '' })).toBe(false);
      expect(isValid(SdkKvGetArgsSchema, { key: 'x'.repeat(SDK_MAX_KV_KEY_BYTES + 1) })).toBe(
        false,
      );
      expect(isValid(SdkKvGetArgsSchema, { key: 42 })).toBe(false);
      expect(isValid(SdkKvGetArgsSchema, { key: 'a', extra: 1 })).toBe(false);

      expect(isValid(SdkKvSetArgsSchema, { key: 'a', value: { nested: [1, 2] } })).toBe(true);
      expect(isValid(SdkKvSetArgsSchema, { key: 'a' })).toBe(false);
      expect(isValid(SdkKvDeleteArgsSchema, { key: 'a' })).toBe(true);
      expect(isValid(SdkKvDeleteArgsSchema, {})).toBe(false);
      expect(isValid(SdkKvListArgsSchema, {})).toBe(true);
      expect(isValid(SdkKvListArgsSchema, { key: 'a' })).toBe(false);
    });

    it('validates settings operation args', () => {
      expect(isValid(SdkSettingsGetArgsSchema, { path: 'general.temperature' })).toBe(true);
      expect(isValid(SdkSettingsGetArgsSchema, { path: '' })).toBe(false);
      expect(
        isValid(SdkSettingsGetArgsSchema, { path: 'x'.repeat(SDK_MAX_SETTINGS_PATH_BYTES + 1) }),
      ).toBe(false);
      expect(isValid(SdkSettingsSetArgsSchema, { path: 'p', value: 0.9 })).toBe(true);
      expect(isValid(SdkSettingsSetArgsSchema, { path: 'p' })).toBe(false);
      expect(isValid(SdkSettingsSetArgsSchema, { value: 1 })).toBe(false);
    });

    it('validates event replay args and results', () => {
      expect(isValid(SdkEventsReplayArgsSchema, { name: 'chat.message.created' })).toBe(true);
      expect(
        isValid(SdkEventsReplayArgsSchema, { name: 'x', cursor: 7, limit: 4, waitMs: 200 }),
      ).toBe(true);
      expect(isValid(SdkEventsReplayArgsSchema, { name: '' })).toBe(false);
      expect(isValid(SdkEventsReplayArgsSchema, { name: 'x', cursor: 0 })).toBe(false);
      expect(isValid(SdkEventsReplayArgsSchema, { name: 'x', cursor: 1.5 })).toBe(false);
      expect(isValid(SdkEventsReplayArgsSchema, { name: 'x', limit: 0 })).toBe(false);
      expect(isValid(SdkEventsReplayArgsSchema, { name: 'x', limit: 65 })).toBe(false);
      expect(isValid(SdkEventsReplayArgsSchema, { name: 'x', waitMs: -1 })).toBe(false);
      expect(isValid(SdkEventsReplayArgsSchema, { name: 'x', waitMs: 5001 })).toBe(false);
      expect(isValid(SdkEventsReplayArgsSchema, { name: 'x', surprise: 1 })).toBe(false);

      expect(
        isValid(SdkEventsReplayResultSchema, {
          events: [{ seq: 1, name: 'x', emittedAt: 1, payload: { a: 1 } }],
          nextCursor: 1,
        }),
      ).toBe(true);
      expect(isValid(SdkEventsReplayResultSchema, { events: [], nextCursor: null })).toBe(true);
      expect(
        isValid(SdkEventsReplayResultSchema, {
          events: [{ seq: 0, name: 'x', emittedAt: 1 }],
          nextCursor: 0,
        }),
      ).toBe(false);
    });

    it('validates event subscribe/unsubscribe args and results (§18 live)', () => {
      expect(isValid(SdkEventsSubscribeArgsSchema, { name: 'live.tick' })).toBe(true);
      expect(isValid(SdkEventsSubscribeArgsSchema, { name: 'x', cursor: 3 })).toBe(true);
      expect(isValid(SdkEventsSubscribeArgsSchema, { name: '' })).toBe(false);
      expect(isValid(SdkEventsSubscribeArgsSchema, { name: 'x', cursor: 0 })).toBe(false);
      expect(isValid(SdkEventsSubscribeArgsSchema, { name: 'x', limit: 1 })).toBe(false);
      expect(isValid(SdkEventsSubscribeArgsSchema, { surprise: 1 })).toBe(false);

      expect(isValid(SdkEventsSubscribeResultSchema, { subscriptionId: 'sub-12345678' })).toBe(
        true,
      );
      expect(isValid(SdkEventsSubscribeResultSchema, { subscriptionId: 'short' })).toBe(false);
      expect(isValid(SdkEventsSubscribeResultSchema, {})).toBe(false);

      expect(isValid(SdkEventsUnsubscribeArgsSchema, { subscriptionId: 'sub-12345678' })).toBe(
        true,
      );
      expect(isValid(SdkEventsUnsubscribeArgsSchema, { subscriptionId: '' })).toBe(false);
      expect(isValid(SdkEventsUnsubscribeResultSchema, { ok: true })).toBe(true);
      expect(isValid(SdkEventsUnsubscribeResultSchema, { ok: false })).toBe(false);
    });

    it('validates network fetch args and results (§29)', () => {
      expect(isValid(SdkNetworkFetchArgsSchema, { url: 'https://example.com' })).toBe(true);
      expect(
        isValid(SdkNetworkFetchArgsSchema, {
          url: 'https://example.com/api',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"x":1}',
          redirect: 'follow',
        }),
      ).toBe(true);
      expect(isValid(SdkNetworkFetchArgsSchema, { url: '' })).toBe(false);
      expect(
        isValid(SdkNetworkFetchArgsSchema, { url: 'x'.repeat(NETWORK_MAX_URL_BYTES + 1) }),
      ).toBe(false);
      expect(isValid(SdkNetworkFetchArgsSchema, { url: 'https://x', method: 'TRACE' })).toBe(false);
      expect(isValid(SdkNetworkFetchArgsSchema, { url: 'https://x', redirect: 'auto' })).toBe(
        false,
      );
      expect(
        isValid(SdkNetworkFetchArgsSchema, {
          url: 'https://x',
          body: 'x'.repeat(NETWORK_MAX_BODY_BYTES + 1),
        }),
      ).toBe(false);
      expect(isValid(SdkNetworkFetchArgsSchema, { url: 'https://x', surprise: 1 })).toBe(false);

      expect(
        isValid(SdkNetworkFetchResultSchema, {
          status: 200,
          statusText: 'OK',
          headers: { 'x-test': '1' },
          body: 'hello',
          url: 'https://example.com',
          redirects: [],
        }),
      ).toBe(true);
      expect(
        isValid(SdkNetworkFetchResultSchema, {
          status: 302,
          statusText: '',
          headers: {},
          body: '',
          url: 'https://example.com',
          redirects: ['https://api.example.com/v2'],
        }),
      ).toBe(true);
      expect(
        isValid(SdkNetworkFetchResultSchema, {
          status: 99,
          headers: {},
          body: '',
          url: 'x',
          redirects: [],
        }),
      ).toBe(false);
      expect(
        isValid(SdkNetworkFetchResultSchema, {
          status: 600,
          headers: {},
          body: '',
          url: 'x',
          redirects: [],
        }),
      ).toBe(false);
    });

    it('validates models.list args and results (§12 Models)', () => {
      expect(isValid(SdkModelsListArgsSchema, { providerId: 'prov-123' })).toBe(true);
      expect(isValid(SdkModelsListArgsSchema, { providerId: '' })).toBe(false);
      expect(isValid(SdkModelsListArgsSchema, { providerId: 'x'.repeat(65) })).toBe(false);
      expect(isValid(SdkModelsListArgsSchema, {})).toBe(false);
      expect(isValid(SdkModelsListArgsSchema, { providerId: 'x', extra: 1 })).toBe(false);

      expect(
        isValid(SdkModelsListResultSchema, {
          models: [{ id: 'gpt-4', name: 'GPT-4', contextLimit: 8192 }],
        }),
      ).toBe(true);
      expect(isValid(SdkModelsListResultSchema, { models: [] })).toBe(true);
      expect(
        isValid(SdkModelsListResultSchema, {
          models: [{ id: 'x' }],
        }),
      ).toBe(false);
      expect(isValid(SdkModelsListResultSchema, { models: 'no' })).toBe(false);
    });

    it('validates chats.list and chats.read args and results (§12 Application)', () => {
      expect(isValid(SdkChatsListArgsSchema, {})).toBe(true);
      expect(isValid(SdkChatsListArgsSchema, { limit: 50 })).toBe(true);
      expect(isValid(SdkChatsListArgsSchema, { cursor: 'abc', limit: 10, characterId: 'c1' })).toBe(
        true,
      );
      expect(isValid(SdkChatsListArgsSchema, { limit: 0 })).toBe(false);
      expect(isValid(SdkChatsListArgsSchema, { limit: 201 })).toBe(false);
      expect(
        isValid(SdkChatsListArgsSchema, { cursor: 'x'.repeat(CHATS_MAX_CURSOR_BYTES + 1) }),
      ).toBe(false);
      expect(isValid(SdkChatsListArgsSchema, { surprise: 1 })).toBe(false);

      const summary = {
        id: 'chat-1',
        characterId: 'char-1',
        title: 'Hello',
        messageCount: 3,
        createdAt: 1,
        updatedAt: 2,
        origin: null,
        parentChatId: null,
        sourceMessageId: null,
      };
      expect(isValid(SdkChatsListResultSchema, { items: [summary], nextCursor: null })).toBe(true);
      expect(isValid(SdkChatsListResultSchema, { items: [], nextCursor: 'abc' })).toBe(true);
      expect(isValid(SdkChatsListResultSchema, { items: [], nextCursor: 1 })).toBe(false);
      expect(
        isValid(SdkChatsListResultSchema, {
          items: [
            {
              id: 'x',
              characterId: null,
              title: 't',
              messageCount: 0,
              createdAt: 1,
              updatedAt: 1,
              origin: null,
              parentChatId: null,
              sourceMessageId: null,
            },
          ],
          nextCursor: null,
        }),
      ).toBe(true);

      expect(isValid(SdkChatsReadArgsSchema, { chatId: 'chat-1' })).toBe(true);
      expect(isValid(SdkChatsReadArgsSchema, { chatId: '' })).toBe(false);
      expect(isValid(SdkChatsReadArgsSchema, {})).toBe(false);
      expect(isValid(SdkChatsReadArgsSchema, { chatId: 'x', extra: 1 })).toBe(false);

      const chat = {
        id: 'chat-1',
        characterId: 'char-1',
        personaId: null,
        title: 'Hello',
        activeBranchId: null,
        backgroundId: null,
        summary: '',
        messageCount: 3,
        createdAt: 1,
        updatedAt: 2,
        deletedAt: null,
        origin: null,
        parentChatId: null,
        sourceMessageId: null,
      };
      expect(isValid(SdkChatsReadResultSchema, { chat })).toBe(true);
      expect(isValid(SdkChatsReadResultSchema, { chat: { ...chat, id: '' } })).toBe(false);
    });

    it('validates characters.list and characters.read args and results (§12 Application)', () => {
      expect(isValid(SdkCharactersListArgsSchema, {})).toBe(true);
      expect(isValid(SdkCharactersListArgsSchema, { limit: 50 })).toBe(true);
      expect(isValid(SdkCharactersListArgsSchema, { cursor: 'abc', limit: 10 })).toBe(true);
      expect(isValid(SdkCharactersListArgsSchema, { limit: 0 })).toBe(false);
      expect(isValid(SdkCharactersListArgsSchema, { limit: 201 })).toBe(false);
      expect(
        isValid(SdkCharactersListArgsSchema, {
          cursor: 'x'.repeat(CHARACTERS_MAX_CURSOR_BYTES + 1),
        }),
      ).toBe(false);
      expect(isValid(SdkCharactersListArgsSchema, { surprise: 1 })).toBe(false);

      const summary = {
        id: 'char-1',
        name: 'Alice',
        avatar: null,
        description: 'A character',
        tags: ['fantasy'],
        createdAt: 1,
        updatedAt: 2,
      };
      expect(isValid(SdkCharactersListResultSchema, { items: [summary], nextCursor: null })).toBe(
        true,
      );
      expect(isValid(SdkCharactersListResultSchema, { items: [], nextCursor: 'abc' })).toBe(true);
      expect(isValid(SdkCharactersListResultSchema, { items: [], nextCursor: 1 })).toBe(false);

      expect(isValid(SdkCharactersReadArgsSchema, { characterId: 'char-1' })).toBe(true);
      expect(isValid(SdkCharactersReadArgsSchema, { characterId: '' })).toBe(false);
      expect(isValid(SdkCharactersReadArgsSchema, {})).toBe(false);
      expect(isValid(SdkCharactersReadArgsSchema, { characterId: 'x', extra: 1 })).toBe(false);

      const character = {
        id: 'char-1',
        name: 'Alice',
        avatar: null,
        description: 'A character',
        personality: '',
        scenario: '',
        firstMessage: 'Hello',
        exampleDialogues: '',
        systemPrompt: null,
        postHistoryInstructions: null,
        creator: null,
        creatorNotes: null,
        tags: [],
        ext: {},
        createdAt: 1,
        updatedAt: 2,
        lastUsedAt: null,
        deletedAt: null,
      };
      expect(isValid(SdkCharactersReadResultSchema, { character })).toBe(true);
      expect(isValid(SdkCharactersReadResultSchema, { character: { ...character, id: '' } })).toBe(
        false,
      );
    });

    it('validates lorebook.list, lorebook.read and lorebook.entries args and results (§12 Application)', () => {
      expect(isValid(SdkLorebookListArgsSchema, {})).toBe(true);
      expect(isValid(SdkLorebookListArgsSchema, { limit: 50, characterId: 'char-1' })).toBe(true);
      expect(isValid(SdkLorebookListArgsSchema, { limit: 0 })).toBe(false);
      expect(isValid(SdkLorebookListArgsSchema, { limit: 201 })).toBe(false);
      expect(
        isValid(SdkLorebookListArgsSchema, {
          cursor: 'x'.repeat(LOREBOK_MAX_CURSOR_BYTES + 1),
        }),
      ).toBe(false);
      expect(isValid(SdkLorebookListArgsSchema, { surprise: 1 })).toBe(false);

      const book = {
        id: 'book-1',
        name: 'World',
        description: 'A lorebook',
        characterId: null,
        metadata: {},
        createdAt: 1,
        updatedAt: 2,
      };
      expect(isValid(SdkLorebookListResultSchema, { items: [book], nextCursor: null })).toBe(true);
      expect(isValid(SdkLorebookListResultSchema, { items: [], nextCursor: 'abc' })).toBe(true);
      expect(isValid(SdkLorebookListResultSchema, { items: [], nextCursor: 1 })).toBe(false);

      expect(isValid(SdkLorebookReadArgsSchema, { bookId: 'book-1' })).toBe(true);
      expect(isValid(SdkLorebookReadArgsSchema, { bookId: '' })).toBe(false);
      expect(isValid(SdkLorebookReadArgsSchema, {})).toBe(false);
      expect(isValid(SdkLorebookReadResultSchema, { book })).toBe(true);
      expect(isValid(SdkLorebookReadResultSchema, { book: { ...book, id: '' } })).toBe(false);

      const entry = {
        id: 'entry-1',
        lorebookId: 'book-1',
        keys: ['castle'],
        secondaryKeys: [],
        content: 'The castle is old.',
        enabled: true,
        position: 1,
        constant: false,
        selective: false,
        metadata: {},
        createdAt: 1,
        updatedAt: 2,
      };
      expect(isValid(SdkLorebookEntriesArgsSchema, { bookId: 'book-1' })).toBe(true);
      expect(isValid(SdkLorebookEntriesArgsSchema, { bookId: 'x', extra: 1 })).toBe(false);
      expect(isValid(SdkLorebookEntriesResultSchema, { items: [entry] })).toBe(true);
      expect(isValid(SdkLorebookEntriesResultSchema, { items: [entry], extra: 1 })).toBe(false);
      expect(
        isValid(SdkLorebookEntriesResultSchema, {
          items: [{ ...entry, id: '' }],
        }),
      ).toBe(false);
    });

    it('validates database.core.query args and results (§31 Core DB)', () => {
      expect(isValid(SdkDatabaseQueryArgsSchema, { sql: 'SELECT 1' })).toBe(true);
      expect(
        isValid(SdkDatabaseQueryArgsSchema, { sql: 'SELECT ?', params: [1, 'a', null, true] }),
      ).toBe(true);
      expect(isValid(SdkDatabaseQueryArgsSchema, { sql: 'SELECT ?', params: [] })).toBe(true);
      expect(isValid(SdkDatabaseQueryArgsSchema, { sql: '' })).toBe(false);
      expect(
        isValid(SdkDatabaseQueryArgsSchema, { sql: 'x'.repeat(DATABASE_MAX_SQL_BYTES + 1) }),
      ).toBe(false);
      expect(
        isValid(SdkDatabaseQueryArgsSchema, { sql: 'SELECT ?', params: [{ nested: 1 }] }),
      ).toBe(false);
      expect(
        isValid(SdkDatabaseQueryArgsSchema, {
          sql: 'SELECT ?',
          params: Array.from({ length: DATABASE_MAX_PARAMS + 1 }, () => 1),
        }),
      ).toBe(false);
      expect(isValid(SdkDatabaseQueryArgsSchema, { sql: 'SELECT 1', extra: 1 })).toBe(false);

      expect(isValid(SdkDatabaseQueryResultSchema, { columns: ['id'], rows: [[1]] })).toBe(true);
      expect(isValid(SdkDatabaseQueryResultSchema, { columns: [], rows: [] })).toBe(true);
      expect(isValid(SdkDatabaseQueryResultSchema, { columns: ['id'], rows: [[{ x: 1 }]] })).toBe(
        false,
      );
      expect(isValid(SdkDatabaseQueryResultSchema, { columns: [1], rows: [] })).toBe(false);
      expect(
        isValid(SdkDatabaseQueryResultSchema, {
          columns: ['id'],
          rows: [Array.from({ length: DATABASE_MAX_COLUMNS + 1 }, () => 1)],
        }),
      ).toBe(false);
      expect(
        isValid(SdkDatabaseQueryResultSchema, {
          columns: Array.from({ length: DATABASE_MAX_COLUMNS + 1 }, (_, i) => `c${i}`),
          rows: [],
        }),
      ).toBe(false);
      expect(
        isValid(SdkDatabaseQueryResultSchema, {
          columns: ['id'],
          rows: Array.from({ length: DATABASE_MAX_ROWS + 1 }, () => [1]),
        }),
      ).toBe(false);
    });

    it('maps every catalog method to a §12 capability and an args schema', () => {
      const expected: Record<string, [string | null, unknown]> = {
        [SdkOperationMethod.KV_GET]: ['storage.kv', SdkKvGetArgsSchema],
        [SdkOperationMethod.KV_SET]: ['storage.kv', SdkKvSetArgsSchema],
        [SdkOperationMethod.KV_DELETE]: ['storage.kv', SdkKvDeleteArgsSchema],
        [SdkOperationMethod.KV_LIST]: ['storage.kv', SdkKvListArgsSchema],
        [SdkOperationMethod.SETTINGS_GET]: ['settings.read', SdkSettingsGetArgsSchema],
        [SdkOperationMethod.SETTINGS_SET]: ['settings.write', SdkSettingsSetArgsSchema],
        // §18 events: core channel, no grant required.
        [SdkOperationMethod.EVENTS_REPLAY]: [null, SdkEventsReplayArgsSchema],
        [SdkOperationMethod.EVENTS_SUBSCRIBE]: [null, SdkEventsSubscribeArgsSchema],
        [SdkOperationMethod.EVENTS_UNSUBSCRIBE]: [null, SdkEventsUnsubscribeArgsSchema],
        [SdkOperationMethod.NETWORK_HTTP_FETCH]: ['network.http', SdkNetworkFetchArgsSchema],
        [SdkOperationMethod.MODELS_LIST]: ['models.list', SdkModelsListArgsSchema],
        [SdkOperationMethod.CHATS_LIST]: ['chats.read', SdkChatsListArgsSchema],
        [SdkOperationMethod.CHATS_READ]: ['chats.read', SdkChatsReadArgsSchema],
        [SdkOperationMethod.CHARACTERS_LIST]: ['characters.read', SdkCharactersListArgsSchema],
        [SdkOperationMethod.CHARACTERS_READ]: ['characters.read', SdkCharactersReadArgsSchema],
        [SdkOperationMethod.LOREBOK_LIST]: ['lorebook.read', SdkLorebookListArgsSchema],
        [SdkOperationMethod.LOREBOK_READ]: ['lorebook.read', SdkLorebookReadArgsSchema],
        [SdkOperationMethod.LOREBOK_ENTRIES]: ['lorebook.read', SdkLorebookEntriesArgsSchema],
        [SdkOperationMethod.DATABASE_CORE_QUERY]: [
          'database.core.read',
          SdkDatabaseQueryArgsSchema,
        ],
        // §30 Files API (Stage E): plugin-owned data directory.
        [SdkOperationMethod.FILES_READ]: ['files.plugin', SdkFilesPathArgsSchema],
        [SdkOperationMethod.FILES_WRITE]: ['files.plugin', SdkFilesWriteArgsSchema],
        [SdkOperationMethod.FILES_STAT]: ['files.plugin', SdkFilesPathArgsSchema],
        [SdkOperationMethod.FILES_LIST]: ['files.plugin', SdkFilesPathArgsSchema],
        [SdkOperationMethod.FILES_RENAME]: ['files.plugin', SdkFilesRenameArgsSchema],
        [SdkOperationMethod.FILES_REMOVE]: ['files.plugin', SdkFilesPathArgsSchema],
        // §29 Socket API (Stage E): one capability per family.
        [SdkOperationMethod.NETWORK_WEBSOCKET_OPEN]: [
          'network.websocket',
          SdkNetworkWebsocketOpenArgsSchema,
        ],
        [SdkOperationMethod.NETWORK_WEBSOCKET_SEND]: [
          'network.websocket',
          SdkNetworkSocketSendArgsSchema,
        ],
        [SdkOperationMethod.NETWORK_WEBSOCKET_RECEIVE]: [
          'network.websocket',
          SdkNetworkSocketReceiveArgsSchema,
        ],
        [SdkOperationMethod.NETWORK_WEBSOCKET_CLOSE]: [
          'network.websocket',
          SdkNetworkSocketIdArgsSchema,
        ],
        [SdkOperationMethod.NETWORK_TCP_CONNECT]: ['network.tcp', SdkNetworkTcpConnectArgsSchema],
        [SdkOperationMethod.NETWORK_TCP_SEND]: ['network.tcp', SdkNetworkSocketSendArgsSchema],
        [SdkOperationMethod.NETWORK_TCP_RECEIVE]: [
          'network.tcp',
          SdkNetworkSocketReceiveArgsSchema,
        ],
        [SdkOperationMethod.NETWORK_TCP_CLOSE]: ['network.tcp', SdkNetworkSocketIdArgsSchema],
        [SdkOperationMethod.NETWORK_LISTEN_OPEN]: [
          'network.listen',
          SdkNetworkListenOpenArgsSchema,
        ],
        [SdkOperationMethod.NETWORK_LISTEN_ACCEPT]: [
          'network.listen',
          SdkNetworkListenAcceptArgsSchema,
        ],
        [SdkOperationMethod.NETWORK_LISTEN_CLOSE]: ['network.listen', SdkNetworkSocketIdArgsSchema],
        [SdkOperationMethod.NETWORK_UDP_OPEN]: ['network.udp', SdkNetworkUdpOpenArgsSchema],
        [SdkOperationMethod.NETWORK_UDP_SEND]: ['network.udp', SdkNetworkUdpSendArgsSchema],
        [SdkOperationMethod.NETWORK_UDP_RECEIVE]: ['network.udp', SdkNetworkSocketIdArgsSchema],
        [SdkOperationMethod.NETWORK_UDP_CLOSE]: ['network.udp', SdkNetworkSocketIdArgsSchema],
        // §13/§32 Process API (Stage E): all methods admit with process.spawn.
        [SdkOperationMethod.PROCESS_SPAWN]: ['process.spawn', SdkProcessSpawnArgsSchema],
        [SdkOperationMethod.PROCESS_OUTPUT]: ['process.spawn', SdkProcessOutputArgsSchema],
        [SdkOperationMethod.PROCESS_SIGNAL]: ['process.spawn', SdkProcessSignalArgsSchema],
        [SdkOperationMethod.PROCESS_WAIT]: ['process.spawn', SdkProcessOutputArgsSchema],
        [SdkOperationMethod.PROCESS_CLOSE]: ['process.spawn', SdkProcessIdArgsSchema],
        // §19/§27 Jobs API (Stage E): host scheduler, one capability.
        [SdkOperationMethod.JOBS_REGISTER]: ['jobs.background', SdkJobsRegisterArgsSchema],
        [SdkOperationMethod.JOBS_CANCEL]: ['jobs.background', SdkJobsCancelArgsSchema],
        [SdkOperationMethod.JOBS_LIST]: ['jobs.background', SdkJobsListArgsSchema],
        // §34 Services API (Stage E): provider/caller split.
        [SdkOperationMethod.SERVICES_PROVIDE]: ['services.provide', SdkServicesProvideArgsSchema],
        [SdkOperationMethod.SERVICES_CONNECT]: ['services.connect', SdkServicesConnectArgsSchema],
        [SdkOperationMethod.SERVICES_RESPOND]: ['services.provide', SdkServicesRespondArgsSchema],
        // §33 Secrets API (Stage E): Main Host keeps the tokens.
        [SdkOperationMethod.SECRETS_USE]: ['secrets.use', SdkSecretsUseArgsSchema],
        [SdkOperationMethod.SECRETS_MANAGE_OWN]: [
          'secrets.manageOwn',
          SdkSecretsManageOwnArgsSchema,
        ],
        [SdkOperationMethod.SECRETS_REVEAL]: ['secrets.reveal', SdkSecretsRevealArgsSchema],
      };
      expect(SDK_OPERATION_CATALOG).toHaveLength(Object.keys(expected).length);
      for (const entry of SDK_OPERATION_CATALOG) {
        const [capability, schema] = expected[entry.method as keyof typeof expected] ?? [];
        expect(entry.capability).toBe(capability);
        expect(entry.argsSchema).toBe(schema);
      }
    });

    it('exposes the sdk value bounds as stable constants', () => {
      expect(SDK_MAX_KV_KEY_BYTES).toBe(512);
      expect(SDK_MAX_KV_VALUE_BYTES).toBe(8 * 1024 * 1024);
      expect(SDK_MAX_SETTINGS_PATH_BYTES).toBe(256);
      expect(SDK_MAX_SETTINGS_VALUE_BYTES).toBe(8 * 1024 * 1024);
    });

    it('exposes the events ring bounds as stable constants (§18, ADR-0025)', () => {
      expect(EVENTS_PER_NAME).toBe(128);
      expect(EVENTS_TOTAL).toBe(4096);
      expect(EVENTS_TTL_MS).toBe(60_000);
      expect(EVENTS_MAX_WAITERS).toBe(64);
      expect(EVENTS_MAX_REPLAY_LIMIT).toBe(64);
      expect(EVENTS_MAX_WAIT_MS).toBe(5_000);
      expect(EVENTS_MAX_NAME_BYTES).toBe(128);
      expect(EVENTS_MAX_SUBSCRIPTIONS_PER_PLUGIN).toBe(8);
    });

    it('exposes the network fetch bounds as stable constants (§29)', () => {
      expect(NETWORK_MAX_URL_BYTES).toBe(2048);
      expect(NETWORK_MAX_HEADERS).toBe(32);
      expect(NETWORK_MAX_HEADER_NAME_BYTES).toBe(128);
      expect(NETWORK_MAX_HEADER_VALUE_BYTES).toBe(8 * 1024);
      expect(NETWORK_MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
      expect(NETWORK_MAX_REDIRECTS).toBe(8);
    });

    it('exposes the §29 secret and pool bounds as stable constants', () => {
      expect(NETWORK_MAX_SECRET_ID_BYTES).toBe(128);
      expect(NETWORK_POOL_MAX_SOCKETS_PER_ORIGIN).toBe(6);
      expect(NETWORK_POOL_MAX_FREE_SOCKETS).toBe(4);
      expect(NETWORK_POOL_KEEP_ALIVE_MS).toBe(60_000);
      expect(NETWORK_POOL_CONNECT_TIMEOUT_MS).toBe(10_000);
    });

    it('exposes the §29.1.1 scope capability names and default scope', () => {
      expect(NETWORK_SCOPE_LOCAL).toBe('network.local');
      expect(NETWORK_SCOPE_PRIVATE).toBe('network.private');
      expect(NETWORK_SCOPE_METADATA).toBe('network.metadata');
      expect(NETWORK_SCOPE_CAPABILITIES).toEqual([
        'network.local',
        'network.private',
        'network.metadata',
      ]);
      expect(DEFAULT_NETWORK_SCOPE).toEqual({
        local: false,
        private: false,
        metadata: false,
      });
    });

    it('exposes the §17 credit-stream bounds as stable constants', () => {
      expect(RPC_STREAM_CHUNK_BYTES).toBe(256 * 1024);
      expect(RPC_STREAM_INITIAL_CREDIT_BYTES).toBe(RPC_STREAM_CHUNK_BYTES);
      expect(RPC_STREAM_MAX_CONCURRENT).toBe(16);
      expect(RPC_STREAM_MAX_ACCUMULATED_BYTES).toBe(16 * 1024 * 1024);
      // The streaming cap leaves headroom over the largest single body
      // (network fetch, 8 MiB) for the response envelope + JSON escaping.
      expect(RPC_STREAM_MAX_ACCUMULATED_BYTES).toBeGreaterThan(NETWORK_MAX_BODY_BYTES);
      expect(PluginRuntimeFrameType.RPC_RESPONSE_STREAM).toBe(0x1a);
    });

    it('exposes the §9.1.1 log-channel frames and bounds as stable constants', () => {
      expect(PluginRuntimeFrameType.LOG_BATCH).toBe(0x1b);
      expect(PluginRuntimeFrameType.LOG_BATCH_ACK).toBe(0x1c);
      expect(PluginRuntimeFrameType.FATAL_DIAGNOSTIC).toBe(0x1d);
      expect(PLUGIN_RUNTIME_LOG_BATCH_MAX_BYTES).toBe(16 * 1024);
      expect(PLUGIN_RUNTIME_LOG_BATCH_MAX_RECORDS).toBe(256);
      expect(PLUGIN_RUNTIME_LOG_MAX_MESSAGE_BYTES).toBe(4000);
      expect(PLUGIN_RUNTIME_LOG_MAX_COALESCED_COUNT).toBe(1_000_000);
      expect(PLUGIN_RUNTIME_FATAL_MAX_BYTES).toBe(8000);
      // The whole batch must fit the control path (§15.3: control frames
      // stay small; logs are diagnostics, not bulk data).
      expect(PLUGIN_RUNTIME_LOG_BATCH_MAX_BYTES).toBeLessThan(
        PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES,
      );
    });

    it('validates log-batch and fatal-diagnostic bridge messages', () => {
      const batchBytes = new TextEncoder().encode(
        JSON.stringify({
          seq: 3,
          droppedCount: 0,
          records: [{ level: 'info', message: 'hello', at: 1 }],
        }),
      );
      expect(
        isValid(PluginRuntimeBridgeMessageSchema, {
          kind: 'log-batch',
          workerId: 1,
          workerEpoch: 1,
          seq: 3,
          droppedCount: 0,
          payloadBytes: batchBytes,
        }),
      ).toBe(true);
      // Over-budget batch is rejected at the bridge before transport.
      expect(
        isValid(PluginRuntimeBridgeMessageSchema, {
          kind: 'log-batch',
          workerId: 1,
          workerEpoch: 1,
          seq: 3,
          droppedCount: 0,
          payloadBytes: new Uint8Array(PLUGIN_RUNTIME_LOG_BATCH_MAX_BYTES + 1),
        }),
      ).toBe(false);
      // Records inside the payload stay bounded (§9.1.2).
      expect(
        isValid(PluginRuntimeLogBatchPayloadSchema, {
          seq: 0,
          droppedCount: 0,
          records: [
            { level: 'trace', message: 'x'.repeat(PLUGIN_RUNTIME_LOG_MAX_MESSAGE_BYTES), at: 0 },
          ],
        }),
      ).toBe(true);
      expect(
        isValid(PluginRuntimeLogBatchPayloadSchema, {
          seq: 0,
          droppedCount: 0,
          records: [
            {
              level: 'trace',
              message: 'x'.repeat(PLUGIN_RUNTIME_LOG_MAX_MESSAGE_BYTES + 1),
              at: 0,
            },
          ],
        }),
      ).toBe(false);
      expect(
        isValid(PluginRuntimeFatalDiagnosticBodySchema, {
          workerId: 1,
          workerEpoch: 2,
          envelope: {
            kind: 'uncaught-exception',
            name: 'TypeError',
            message: 'boom',
            stack: 'at neotavern-plugin://test.plugin/src/index.js:1:1',
          },
        }),
      ).toBe(true);
      expect(
        isValid(PluginRuntimeFatalDiagnosticBodySchema, {
          workerId: 1,
          workerEpoch: 2,
          envelope: { kind: 'uncaught-exception', name: 'TypeError', message: 'boom' },
        }),
      ).toBe(true);
      expect(
        isValid(PluginRuntimeFatalDiagnosticBodySchema, {
          workerId: 1,
          workerEpoch: 2,
          envelope: { kind: 'uncaught-exception', name: 'TypeError' },
        }),
      ).toBe(false);
    });

    it('exposes the models.list bounds as stable constants (§12 Models)', () => {
      expect(MODELS_MAX_LIST).toBe(256);
    });

    it('exposes the chats bounds as stable constants (§12 Application)', () => {
      expect(CHATS_MAX_LIST).toBe(200);
      expect(CHATS_MAX_CURSOR_BYTES).toBe(256);
    });

    it('exposes the characters bounds as stable constants (§12 Application)', () => {
      expect(CHARACTERS_MAX_LIST).toBe(200);
      expect(CHARACTERS_MAX_CURSOR_BYTES).toBe(256);
    });

    it('exposes the lorebook bounds as stable constants (§12 Application)', () => {
      expect(LOREBOK_MAX_LIST).toBe(200);
      expect(LOREBOK_MAX_CURSOR_BYTES).toBe(256);
      expect(LOREBOK_MAX_ENTRIES).toBe(1000);
    });

    it('exposes the core DB bounds as stable constants (§31)', () => {
      expect(DATABASE_MAX_SQL_BYTES).toBe(4096);
      expect(DATABASE_MAX_PARAMS).toBe(64);
      expect(DATABASE_MAX_ROWS).toBe(1000);
      expect(DATABASE_MAX_COLUMNS).toBe(64);
    });
  });
});
