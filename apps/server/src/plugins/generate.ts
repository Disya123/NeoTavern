/**
 * Streaming generation route: POST /api/v2/chats/:id/generate (SSE).
 * Runs the prompt pipeline, streams provider events, persists the user and
 * assistant messages, and aborts when the client disconnects.
 */
import {
  IdSchema,
  ChatGenerateRequestSchema,
  GenerationMessageSchema,
  PromptContextAuditResponseSchema,
  PromptContextPreviewRequestSchema,
  PromptContextPreviewResponseSchema,
  PromptPostProcessingModes,
  type GenerationMessage,
  type Message,
  type PromptContextAudit,
  type PromptContextPreview,
  type PromptContextPreviewRequest,
  type PromptPostProcessingMode,
} from '@neotavern/contracts';
import {
  AppError,
  ErrorCodes,
  randomToken,
  safeErrorMessage,
  toAppError,
  uuidv7,
} from '@neotavern/shared';
import { Type } from '@sinclair/typebox';
import type { AppContext, TypedApp } from '../types.js';
import { endSse, initSse, sendSseEvent, waitForDrain } from '../lib/sse.js';
import { runPromptPipeline, type PipelineInterceptor } from '../pipeline/promptPipeline.js';
import { runPostProcessors } from '../pipeline/postProcess.js';
import { retrieveLoreBlocks } from '../lib/lorebookRetrieval.js';
import { retrieveMemoryBlocks } from '../lib/memoryRetrieval.js';
import { readPersonaPlacement } from '../lib/personaPlacement.js';
import type { PromptMessage } from '../pipeline/contextShift.js';
import { assertProviderConfigValid } from './providers.js';

const FrontendInterceptResponseSchema = Type.Object(
  {
    responseToken: Type.String({ minLength: 32, maxLength: 256 }),
    messages: Type.Array(
      Type.Intersect([
        GenerationMessageSchema,
        Type.Object({ id: Type.Optional(Type.String({ maxLength: 200 })) }),
      ]),
      { maxItems: 500 },
    ),
    meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export async function registerGenerateRoutes(app: TypedApp, ctx: AppContext): Promise<void> {
  const { chats, messages, characters, personas, settings, providerConfigs, promptContextAudits } =
    ctx.database.repos;
  const frontendInterceptors = new FrontendInterceptorBroker();
  app.addHook('onClose', () => frontendInterceptors.close());

  app.post(
    '/api/v2/plugin-intercepts/:requestId',
    {
      schema: {
        params: Type.Object({ requestId: Type.String({ minLength: 16, maxLength: 200 }) }),
        body: FrontendInterceptResponseSchema,
      },
    },
    async (request, reply) => {
      frontendInterceptors.resolve(
        request.params.requestId,
        request.body.responseToken,
        request.body.messages,
        request.body.meta ?? {},
      );
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v2/chats/:id/context-audit',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        response: { 200: PromptContextAuditResponseSchema },
      },
    },
    async (req) => {
      const chat = await chats.getById(req.params.id);
      if (!chat) {
        throw new AppError({
          code: ErrorCodes.CHAT_NOT_FOUND,
          params: { chatId: req.params.id },
        });
      }
      return { audit: promptContextAudits.getLatest(req.params.id) };
    },
  );

  app.post(
    '/api/v2/context-preview',
    {
      schema: {
        body: PromptContextPreviewRequestSchema,
        response: { 200: PromptContextPreviewResponseSchema },
      },
    },
    async (request) => {
      const abort = new AbortController();
      const abortPreview = (): void => abort.abort();
      request.raw.once('aborted', abortPreview);
      try {
        return { preview: await buildPromptContextPreview(ctx, request.body, abort.signal) };
      } finally {
        request.raw.off('aborted', abortPreview);
      }
    },
  );

  app.post(
    '/api/v2/chats/:id/generate',
    {
      schema: {
        params: Type.Object({ id: IdSchema }),
        body: ChatGenerateRequestSchema,
      },
    },
    async (req, reply) => {
      reply.hijack();
      const chatId = req.params.id;
      const body = req.body;
      const generationId = uuidv7();
      const auditCreatedAt = Date.now();
      const abort = new AbortController();
      // Abort when the client disconnects. 'close' on the response socket fires
      // both on normal end (writableEnded === true) and on early disconnect —
      // only the latter should cancel generation.
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) abort.abort();
      });

      initSse(reply);
      let terminalAuditWritten = false;
      try {
        const chat = await chats.getById(chatId);
        if (!chat) {
          sendSseEvent(reply, {
            type: 'error',
            code: ErrorCodes.CHAT_NOT_FOUND,
            message: 'Chat not found',
          });
          endSse(reply);
          return;
        }
        const branch = chat.activeBranchId ?? (await chats.createBranch(chatId, 'main'));
        if (!chat.activeBranchId) await chats.update(chatId, { activeBranchId: branch });

        // On regenerate the previous reply is preserved as a swipe variant
        // (ТЗ §10.2 message_variants) and rewritten in place when the new
        // generation completes. The archive happens ONLY with the done write
        // (one atomic replaceContentAsVariant), so a failed or aborted stream
        // destroys nothing. A stale regenerateMessageId (the target is no
        // longer the last assistant message of the active branch) fails fast
        // here — before any streaming and before any archive.
        let regenerateMessageId: string | null = null;
        if (body.regenerate || body.regenerateMessageId) {
          const latest = await messages.recentAscending(chatId, branch, 1);
          const lastMessage = latest.at(-1) ?? null;
          if (body.regenerateMessageId) {
            if (
              !lastMessage ||
              lastMessage.id !== body.regenerateMessageId ||
              lastMessage.role !== 'assistant'
            ) {
              throw new AppError({
                code: ErrorCodes.REGENERATE_TARGET_MOVED,
                params: { chatId, messageId: body.regenerateMessageId },
              });
            }
            regenerateMessageId = lastMessage.id;
          } else if (lastMessage?.role === 'assistant') {
            // Legacy regenerate: true — derive the last assistant message.
            regenerateMessageId = lastMessage.id;
          }
        }
        // The content being replaced; captured now so the done write can
        // archive it atomically with the replacement.
        const regeneratedContent = regenerateMessageId
          ? ((await messages.getById(regenerateMessageId))?.content ?? null)
          : null;

        // Persist the user message first so it appears in the chat immediately.
        const userMessage =
          body.regenerate || body.regenerateMessageId ? undefined : body.userMessage;
        if (userMessage && userMessage.trim().length > 0) {
          await messages.create(chatId, branch, { role: 'user', content: userMessage });
          await chats.setMessageCount(chatId, await messages.count(chatId, branch));
        }

        const character = chat.characterId ? await characters.getById(chat.characterId) : null;
        const appSettings = await settings.getAll();
        const persona = await personas.resolveActive(chat.personaId, appSettings.activePersonaId);

        const history = (await messages.recentAscending(chatId, branch, 200)).filter(
          // The message being regenerated must not feed its old content back
          // into the prompt.
          (message) => message.id !== regenerateMessageId,
        );

        // Lorebook stage (ТЗ §4.4): keyword-scan the current input plus recent
        // history against the character's books and all global books.
        const candidateEntries = await ctx.database.repos.lorebooks.retrievalEntries(
          chat.characterId ?? null,
        );
        const loreScanText = [body.userMessage ?? '', ...history.slice(-10).map((m) => m.content)]
          .filter((part) => part.length > 0)
          .join('\n');
        const loreBlocks = retrieveLoreBlocks(candidateEntries, loreScanText);

        // Memory/RAG stage (ТЗ §4.4): keyword-retrieved long-lived knowledge
        // blocks, ranked after lorebook context.
        const memoryCandidates = await ctx.database.repos.memories.retrievalEntries(
          chat.characterId ?? null,
        );
        const memoryFtsRanks = await ctx.database.repos.memories.ftsMatchRanks(loreScanText);
        const memoryBlocks = retrieveMemoryBlocks(memoryCandidates, loreScanText, memoryFtsRanks);

        // Resolve provider: explicit → settings default → first enabled → echo.
        const full = await resolveProviderConfig(
          providerConfigs,
          body.providerConfigId ?? appSettings.activeProviderConfigId ?? null,
        );
        if (full && (!full.model || full.model.trim().length === 0)) {
          throw new AppError({
            code: ErrorCodes.PROVIDER_CONFIG_INVALID,
            params: {
              kind: full.kind,
              issues: [{ path: 'model', message: 'model is required' }],
            },
            message: 'A model is required before generation',
          });
        }
        const providerRuntime = full
          ? await assertProviderConfigValid(ctx, full.kind, {
              baseUrl: full.baseUrl,
              model: full.model,
              apiKey: full.apiKey,
              settings: full.settings,
            })
          : null;
        const adapter =
          full && providerRuntime
            ? ctx.providers.create(full.kind, {
                ...providerRuntime,
                timeouts: ctx.config.providerTimeouts,
              })
            : ctx.providers.create('echo', {
                baseUrl: null,
                model: 'echo',
                apiKey: null,
                settings: {},
                timeouts: ctx.config.providerTimeouts,
              });

        const model = full?.model ?? 'echo';
        const tokenizer = await ctx.providers.tokenizers.resolve(model);
        const contextStrategy = ctx.contextStrategies.resolve(appSettings.contextStrategy);

        const pipeline = await runPromptPipeline({
          character,
          persona,
          history,
          contextBlocks:
            loreBlocks.length > 0 || memoryBlocks.length > 0
              ? [...loreBlocks, ...memoryBlocks]
              : undefined,
          model,
          maxContextTokens: appSettings.maxContextTokens,
          instructFormatId: appSettings.instructFormatId ?? undefined,
          instructFormat: appSettings.instructFormat,
          promptTemplate: appSettings.promptTemplate,
          generationType:
            body.regenerate || body.regenerateMessageId
              ? 'regenerate'
              : (body.generationType ?? 'normal'),
          generationOverrides: {
            ...appSettings.generationDefaults,
            ...body.overrides,
          },
          providerKind: full?.kind,
          connectionStopStrings: readConnectionStopStrings(full?.settings['connectionStopStrings']),
          assistantPrefill: readAssistantPrefill(full?.settings['assistantPrefill']),
          promptPostProcessing: resolvePostProcessingMode(full?.settings['promptPostProcessing']),
          promptNames: {
            ...(character?.name ? { charName: character.name } : {}),
            ...(persona?.name ? { userName: persona.name } : {}),
          },
          countTokens: tokenizer.count,
          tokenizerProfile: tokenizer.profile,
          tokenizerApproximate: tokenizer.approximate,
          contextStrategy,
          signal: abort.signal,
          variables: appSettings.macroVariables,
          personaPlacement: readPersonaPlacement(appSettings),
          interceptors: body.frontendInterceptors
            ? [frontendInterceptors.create(chatId, reply, abort.signal)]
            : [],
        });

        const providerSourceValue = full?.settings['source'];
        const preparedAudit: PromptContextAudit = {
          generationId,
          chatId,
          providerConfigId: full?.id ?? null,
          providerKind: full?.kind ?? 'echo',
          providerSource: typeof providerSourceValue === 'string' ? providerSourceValue : null,
          model,
          createdAt: auditCreatedAt,
          status: 'prepared',
          errorCode: null,
          chatTemplateId: appSettings.instructFormat?.id ?? appSettings.instructFormatId ?? null,
          promptTemplateId: appSettings.activePromptTemplatePresetId,
          promptTemplateMode: appSettings.promptTemplate.mode,
          tokenizer: {
            profile: pipeline.tokenBudget.profile,
            approximate: pipeline.tokenBudget.approximate,
          },
          budget: {
            contextLimit: pipeline.tokenBudget.contextLimit,
            reservedForReply: pipeline.tokenBudget.reservedForReply,
            promptTokens: pipeline.tokenBudget.promptTokens,
          },
          contextStrategy: pipeline.contextStrategy,
          entries: pipeline.auditEntries,
          providerMessages: pipeline.request.messages,
          diagnostics: pipeline.diagnostics
            .slice(0, 500)
            .map((diagnostic) => diagnostic.slice(0, 4096)),
          usage: null,
        };
        promptContextAudits.prepare(preparedAudit);

        const assistantPrefill = pipeline.request.assistantPrefill;
        let prefillSentWithDelta = false;
        ctx.events.emit('generation.started', { chatId });
        // Wall-clock duration of the provider call itself (measured directly
        // around the whole stream; persisted under meta.generation.durationMs).
        const t0 = performance.now();
        for await (const event of adapter.generate(pipeline.request, abort.signal)) {
          if (event.type !== 'done') {
            if (event.type === 'error') {
              const errorCode = /^[A-Z][A-Z0-9_]{0,127}$/.test(event.code)
                ? event.code
                : ErrorCodes.GENERATION_FAILED;
              promptContextAudits.finish(chatId, generationId, {
                status:
                  abort.signal.aborted || errorCode === ErrorCodes.GENERATION_CANCELLED
                    ? 'cancelled'
                    : 'failed',
                errorCode,
                usage: null,
              });
              terminalAuditWritten = true;
            }
            const outgoingText =
              event.type === 'delta' &&
              assistantPrefill &&
              !prefillSentWithDelta &&
              event.text.length > 0
                ? `${assistantPrefill}${event.text}`
                : undefined;
            const outgoingEvent = outgoingText ? { ...event, text: outgoingText } : event;
            if (event.type === 'delta' && event.text.length > 0) prefillSentWithDelta = true;
            const flushed = sendSseEvent(reply, outgoingEvent);
            if (!flushed) {
              // Dead socket or kernel buffer full: honor backpressure instead
              // of buffering without bound; a dead client aborts generation
              // (the 'close' listener also aborts independently).
              await waitForDrain(reply);
              if (reply.raw.destroyed || reply.raw.writableEnded) abort.abort();
            }
            if (event.type === 'delta') {
              ctx.events.emit('generation.delta', { chatId, text: outgoingText ?? event.text });
            }
            if (event.type === 'error') {
              const errorCode = /^[A-Z][A-Z0-9_]{0,127}$/.test(event.code)
                ? event.code
                : ErrorCodes.GENERATION_FAILED;
              ctx.events.emit('generation.error', { chatId, code: errorCode });
              break;
            }
            continue;
          }
          // Post-processing stage (ТЗ §4.4): hooks run between the finished
          // stream and the saved message. The corrected terminal event is what
          // the client and the database both see.
          const postDiagnostics: string[] = [];
          const providerText = assistantPrefill ? `${assistantPrefill}${event.text}` : event.text;
          const finalText = await runPostProcessors({
            text: providerText,
            context: { chatId, characterId: chat.characterId ?? null, model },
            processors: ctx.postProcessors.ordered(),
            diagnostics: postDiagnostics,
          });
          if (finalText.trim().length === 0) {
            // An empty completion is a failure, not an assistant message:
            // saving it would leave a blank bubble and report success
            // (PROV-33 L7; reachable e.g. after malformed SSE chunks). The
            // shared catch path writes the failed audit and the SSE error.
            throw new AppError({
              code: ErrorCodes.EMPTY_RESPONSE,
              message: 'Provider returned an empty response',
            });
          }
          const messageMeta = {
            model,
            diagnostics: pipeline.diagnostics,
            tokenBudget: pipeline.tokenBudget,
            contextStrategy: pipeline.contextStrategy,
            excludedContextCount: pipeline.excludedCount,
            ...(postDiagnostics.length > 0 ? { postProcess: postDiagnostics } : {}),
            // Terminal generation bookkeeping (see MessageGenerationMetaSchema
            // in @neotavern/contracts). The legacy top-level `model` stays for
            // compatibility with older messages.
            generation: {
              generationId,
              providerConfigId: full?.id ?? null,
              providerKind: full?.kind ?? null,
              providerSource: typeof providerSourceValue === 'string' ? providerSourceValue : null,
              model,
              durationMs: Math.round(performance.now() - t0),
              usage: event.usage ?? null,
            },
          };
          // Persist BEFORE the terminal event: the client resolves on `done`
          // and immediately refetches messages — a late archive would make
          // that refetch see the stale variant state (ST1-race).
          if (regenerateMessageId && regeneratedContent !== null) {
            // Archive the old content and write the replacement as ONE atomic
            // write (replaceContentAsVariant): the swipe variant appears in
            // the exact moment the new content does. Unconditional (no CAS
            // guard) — generation owns the message it just streamed.
            const updated = await messages.replaceContentAsVariant(regenerateMessageId, {
              archiveContent: regeneratedContent,
              content: finalText,
              meta: messageMeta,
            });
            if (updated.status !== 'updated') {
              throw new AppError({
                code: ErrorCodes.MESSAGE_NOT_FOUND,
                params: { messageId: regenerateMessageId },
              });
            }
            ctx.events.emit('chat.message.updated', {
              chatId,
              messageId: regenerateMessageId,
              role: updated.message.role,
              revision: updated.message.revision,
            });
          } else {
            const saved = await messages.create(chatId, branch, {
              role: 'assistant',
              content: finalText,
              meta: messageMeta,
            });
            await chats.setMessageCount(chatId, await messages.count(chatId, branch));
            ctx.events.emit('chat.message.created', {
              chatId,
              messageId: saved.id,
              role: saved.role,
            });
          }
          sendSseEvent(
            reply,
            finalText === providerText
              ? { ...event, text: providerText }
              : { ...event, text: finalText },
          );
          promptContextAudits.finish(chatId, generationId, {
            status: 'completed',
            errorCode: null,
            usage: event.usage ?? null,
          });
          terminalAuditWritten = true;
          ctx.events.emit('generation.finished', { chatId, text: finalText });
        }
        if (!terminalAuditWritten) {
          throw new AppError({
            code: ErrorCodes.GENERATION_FAILED,
            message: 'Provider stream ended without a terminal event',
          });
        }
      } catch (error) {
        const normalized = toAppError(error);
        // Client disconnects surface as generic abort errors; report them with
        // the dedicated cancellation code rather than INTERNAL.
        const appError =
          abort.signal.aborted && normalized.code === ErrorCodes.INTERNAL
            ? new AppError({ code: ErrorCodes.GENERATION_CANCELLED, cause: error })
            : normalized;
        if (!terminalAuditWritten) {
          promptContextAudits.finish(chatId, generationId, {
            status:
              abort.signal.aborted ||
              appError.code === ErrorCodes.GENERATION_CANCELLED ||
              appError.code === ErrorCodes.ABORTED
                ? 'cancelled'
                : 'failed',
            errorCode: appError.code,
            usage: null,
          });
        }
        // The hijacked reply bypasses the global error handler, so generation
        // failures must be logged explicitly. Uses the app logger (with secret
        // redaction): Fastify's own logger is disabled, req.log is a no-op
        // (PROV-31).
        ctx.logger.error(`generation failed: ${appError.message}`, {
          code: appError.code,
          chatId,
          error:
            error instanceof Error ? { message: error.message, stack: error.stack } : undefined,
        });
        ctx.events.emit('generation.error', { chatId, code: appError.code });
        sendSseEvent(reply, {
          type: 'error',
          code: appError.code,
          // Never forward raw error text across the boundary: unknown errors
          // can contain SQL, filesystem paths or provider internals (ТЗ §13).
          message: safeErrorMessage(error, `Generation failed: ${appError.code}`),
        });
      } finally {
        endSse(reply);
      }
    },
  );
}

/** Build the next prompt without persisting chat state or contacting a provider. */
async function buildPromptContextPreview(
  ctx: AppContext,
  input: PromptContextPreviewRequest,
  signal: AbortSignal,
): Promise<PromptContextPreview> {
  const { characters, chats, messages, personas, settings, providerConfigs, lorebooks, memories } =
    ctx.database.repos;
  const appSettings = await settings.getAll();
  let character: Awaited<ReturnType<typeof characters.getById>> = null;
  let persona: Awaited<ReturnType<typeof personas.resolveActive>> = null;
  let history: Message[] = [];
  let previewChatId: string;
  let previewBranchId: string;

  if ('chatId' in input) {
    const chat = await chats.getById(input.chatId);
    if (!chat) {
      throw new AppError({
        code: ErrorCodes.CHAT_NOT_FOUND,
        params: { chatId: input.chatId },
      });
    }
    previewChatId = chat.id;
    previewBranchId = chat.activeBranchId ?? uuidv7();
    character = chat.characterId ? await characters.getById(chat.characterId) : null;
    persona = await personas.resolveActive(chat.personaId, appSettings.activePersonaId);
    history = chat.activeBranchId
      ? await messages.recentAscending(chat.id, chat.activeBranchId, 200)
      : [];
  } else {
    character = await characters.getById(input.characterId);
    if (!character) {
      throw new AppError({
        code: ErrorCodes.CHARACTER_NOT_FOUND,
        params: { characterId: input.characterId },
      });
    }
    previewChatId = uuidv7();
    previewBranchId = uuidv7();
    // Same resolution rule as real generation (ARCH-13): a preview-level
    // persona override wins over the app-wide active persona.
    persona = await personas.resolveActive(input.personaId, appSettings.activePersonaId);
  }

  let parentId: string | null = history.at(-1)?.id ?? null;
  const appendHistory = (role: Message['role'], content: string): void => {
    const id = uuidv7();
    history.push({
      id,
      chatId: previewChatId,
      branchId: previewBranchId,
      parentId,
      role,
      content,
      name: null,
      meta: {},
      createdAt: Date.now(),
      revision: 1,
      updatedAt: null,
      variantCount: 1,
      activeVariantPosition: 0,
      contentRevisionCount: 0,
      checkpointChatId: null,
    });
    parentId = id;
  };
  const firstMessage = 'chatId' in input ? null : character?.firstMessage;
  if (firstMessage && firstMessage.trim().length > 0) {
    appendHistory('assistant', firstMessage);
  }
  if (input.userMessage.trim().length > 0) {
    appendHistory('user', input.userMessage);
  }

  const loreScanText = [input.userMessage, ...history.slice(-10).map((message) => message.content)]
    .filter((part) => part.length > 0)
    .join('\n');
  const characterId = character?.id ?? null;
  const loreBlocks = retrieveLoreBlocks(
    await lorebooks.retrievalEntries(characterId),
    loreScanText,
  );
  const memoryBlocks = retrieveMemoryBlocks(
    await memories.retrievalEntries(characterId),
    loreScanText,
    await memories.ftsMatchRanks(loreScanText),
  );

  const full = await resolveProviderConfig(
    providerConfigs,
    input.providerConfigId ?? appSettings.activeProviderConfigId ?? null,
  );
  // Preview must remain useful while a provider profile is still being
  // configured. Without a model there is no model-specific tokenizer to
  // select, so the registry returns its visibly approximate fallback for the
  // provider kind; generation still performs strict provider validation.
  const model = full?.model?.trim() || full?.kind || 'echo';
  const tokenizer = await ctx.providers.tokenizers.resolve(model);
  const pipeline = await runPromptPipeline({
    character,
    persona,
    history,
    contextBlocks:
      loreBlocks.length > 0 || memoryBlocks.length > 0
        ? [...loreBlocks, ...memoryBlocks]
        : undefined,
    model,
    maxContextTokens: appSettings.maxContextTokens,
    instructFormatId: appSettings.instructFormatId ?? undefined,
    instructFormat: appSettings.instructFormat,
    promptTemplate: appSettings.promptTemplate,
    generationType: 'normal',
    generationOverrides: appSettings.generationDefaults,
    providerKind: full?.kind,
    connectionStopStrings: readConnectionStopStrings(full?.settings['connectionStopStrings']),
    assistantPrefill: readAssistantPrefill(full?.settings['assistantPrefill']),
    promptPostProcessing: resolvePostProcessingMode(full?.settings['promptPostProcessing']),
    promptNames: {
      ...(character?.name ? { charName: character.name } : {}),
      ...(persona?.name ? { userName: persona.name } : {}),
    },
    countTokens: tokenizer.count,
    tokenizerProfile: tokenizer.profile,
    tokenizerApproximate: tokenizer.approximate,
    contextStrategy: ctx.contextStrategies.resolve(appSettings.contextStrategy),
    signal,
    variables: appSettings.macroVariables,
    personaPlacement: readPersonaPlacement(appSettings),
  });
  const providerSource = full?.settings['source'];

  return {
    providerConfigId: full?.id ?? null,
    providerKind: full?.kind ?? 'echo',
    providerSource: typeof providerSource === 'string' ? providerSource : null,
    model,
    chatTemplateId: appSettings.instructFormat?.id ?? appSettings.instructFormatId ?? null,
    promptTemplateId: appSettings.activePromptTemplatePresetId,
    promptTemplateMode: appSettings.promptTemplate.mode,
    tokenizer: {
      profile: pipeline.tokenBudget.profile,
      approximate: pipeline.tokenBudget.approximate,
    },
    budget: {
      contextLimit: pipeline.tokenBudget.contextLimit,
      reservedForReply: pipeline.tokenBudget.reservedForReply,
      promptTokens: pipeline.tokenBudget.promptTokens,
    },
    contextStrategy: pipeline.contextStrategy,
    entries: pipeline.auditEntries,
    providerMessages: pipeline.request.messages,
    diagnostics: pipeline.diagnostics.slice(0, 500).map((diagnostic) => diagnostic.slice(0, 4096)),
  };
}

interface PendingFrontendIntercept {
  token: string;
  resolve(value: { messages: PromptMessage[] }): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  removeAbortListener(): void;
}

class FrontendInterceptorBroker {
  private readonly pending = new Map<string, PendingFrontendIntercept>();

  create(
    chatId: string,
    reply: Parameters<typeof sendSseEvent>[0],
    signal: AbortSignal,
  ): PipelineInterceptor {
    return {
      id: 'frontend-plugin-host',
      priority: 100,
      timeoutMs: 3_000,
      // Prompt modification requires prompt.modify. Frontend plugins are
      // permission-checked when they register interceptors (web runtime
      // REQUIRED_PERMISSION map), so the host run trusts this bridge; the
      // declaration keeps the hook auditable in pipeline diagnostics.
      requiredPermission: 'prompt.modify',
      intercept: ({ messages, meta }) => this.request(chatId, reply, signal, messages, meta),
    };
  }

  resolve(
    requestId: string,
    responseToken: string,
    messages: readonly (GenerationMessage & { id?: string })[],
    _meta: Record<string, unknown>,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.token !== responseToken) {
      throw new AppError({
        code: ErrorCodes.NOT_FOUND,
        params: { requestId },
      });
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    pending.resolve({
      messages: messages.map((message) => ({
        ...(message.id ? { id: message.id } : {}),
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
      })),
    });
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(new Error('SERVER_CLOSED'));
    }
    this.pending.clear();
  }

  private request(
    chatId: string,
    reply: Parameters<typeof sendSseEvent>[0],
    signal: AbortSignal,
    messages: PromptMessage[],
    meta: Record<string, unknown>,
  ): Promise<{ messages: PromptMessage[] }> {
    if (this.pending.size >= 32) {
      return Promise.reject(
        new AppError({
          code: ErrorCodes.CONFLICT,
          params: { reason: 'FRONTEND_INTERCEPTOR_CAPACITY' },
        }),
      );
    }
    const requestId = randomToken(24);
    const responseToken = randomToken(32);
    const result = new Promise<{ messages: PromptMessage[] }>((resolveResult, rejectResult) => {
      const abort = (): void => {
        this.reject(requestId, new Error('GENERATION_CANCELLED'));
      };
      const timer = setTimeout(
        () => this.reject(requestId, new Error('FRONTEND_INTERCEPTOR_TIMEOUT')),
        2_500,
      );
      timer.unref();
      this.pending.set(requestId, {
        token: responseToken,
        resolve: resolveResult,
        reject: rejectResult,
        timer,
        removeAbortListener: () => signal.removeEventListener('abort', abort),
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    sendSseEvent(reply, {
      type: 'plugin_intercept',
      requestId,
      responseToken,
      chatId,
      messages: messages.map((message) => ({
        ...(message.id ? { id: message.id } : {}),
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
      })),
      meta,
    });
    return result;
  }

  private reject(requestId: string, error: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    pending.reject(error);
  }
}

type ProviderConfigRepo = AppContext['database']['repos']['providerConfigs'];

async function resolveProviderConfig(
  repo: ProviderConfigRepo,
  preferredId: string | null,
): Promise<{
  id: string;
  kind: string;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  settings: Record<string, unknown>;
  enabled: boolean;
} | null> {
  if (preferredId !== null) {
    const full = await repo.getFullConfig(preferredId);
    if (!full) {
      throw new AppError({
        code: ErrorCodes.PROVIDER_NOT_FOUND,
        params: { providerConfigId: preferredId },
      });
    }
    if (!full.enabled) {
      throw new AppError({
        code: ErrorCodes.PROVIDER_DISABLED,
        params: { providerConfigId: preferredId },
      });
    }
    return full;
  }
  const list = await repo.list();
  const first = list.find((provider) => provider.enabled);
  return first ? repo.getFullConfig(first.id) : null;
}

/**
 * Coerce a provider setting into a valid post-processing mode. The value is
 * validated at write time, but settings persisted before validation (or by a
 * profile) are re-checked here so an unknown value degrades to "none".
 */
function resolvePostProcessingMode(value: unknown): PromptPostProcessingMode | undefined {
  return typeof value === 'string' &&
    (PromptPostProcessingModes as readonly string[]).includes(value)
    ? (value as PromptPostProcessingMode)
    : undefined;
}

function readConnectionStopStrings(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((item) => typeof item !== 'string' || item.length > 1024)
  ) {
    return undefined;
  }
  return value;
}

function readAssistantPrefill(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 2048 ? value : undefined;
}
