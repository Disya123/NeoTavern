/**
 * Application assembly: registers CORS, security headers, the error handler
 * and every route module as an isolated concern. Optionally serves the built
 * web app (single local process, no separate web server required).
 */
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { AppError, ErrorCodes, randomToken } from '@neotavern/shared';
import { EventBus } from '@neotavern/plugin-sdk';
import {
  createAppInstance,
  type AppContext,
  type AppContextInput,
  type TypedApp,
} from './types.js';
import { registerErrorHandler } from './lib/errors.js';
import { MaintenanceController } from './lib/maintenance.js';
import { CONTENT_SECURITY_POLICY } from './lib/security.js';
import { isTrustedOrigin, registerRemoteAuth } from './plugins/remoteAuth.js';
import { registerMetaRoutes } from './plugins/meta.js';
import { registerCharacterRoutes } from './plugins/characters.js';
import { registerCharacterTransferRoutes } from './plugins/characterTransfer.js';
import { registerCharacterGalleryRoutes } from './plugins/characterGallery.js';
import { registerBackgroundRoutes } from './plugins/backgrounds.js';
import { registerChatRoutes } from './plugins/chats.js';
import { registerMessageBlockRoutes } from './plugins/messageBlocks.js';
import { registerPersonaRoutes } from './plugins/personas.js';
import { registerLorebookRoutes } from './plugins/lorebooks.js';
import { registerMemoryRoutes } from './plugins/memories.js';
import { registerPresetRoutes } from './plugins/presets.js';
import { registerProfileRoutes } from './plugins/profiles.js';
import { registerConnectionProfileRoutes } from './plugins/connectionProfiles.js';
import { registerProviderRoutes } from './plugins/providers.js';
import { registerSecretRoutes } from './plugins/secrets.js';
import { registerSettingsRoutes } from './plugins/settings.js';
import { registerSearchRoutes } from './plugins/search.js';
import { registerGenerateRoutes } from './plugins/generate.js';
import { registerEventStreamRoutes } from './plugins/events.js';
import { registerBackupRoutes } from './plugins/backups.js';
import { registerDiagnosticRoutes } from './plugins/diagnostics.js';
import { registerThemeRoutes } from './plugins/themes.js';
import { registerPluginRoutes } from './plugins/plugins.js';
import { MAX_SILLYTAVERN_ARCHIVE_BYTES, registerDataImportRoutes } from './plugins/dataImports.js';
import { registerLegacyHost } from './legacy/host.js';

export async function buildApp(input: AppContextInput): Promise<TypedApp> {
  const ctx: AppContext = {
    ...input,
    events: input.events ?? new EventBus(),
    maintenance: input.maintenance ?? new MaintenanceController(),
  };
  const app = createAppInstance();

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || isTrustedOrigin(origin, ctx.config.corsOrigin)) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed by CORS'), false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    credentials: true,
  });
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: MAX_SILLYTAVERN_ARCHIVE_BYTES,
      fields: 0,
    },
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    return payload;
  });

  // Global maintenance gate (ТЗ §10.4): while maintenance is active (a restore
  // holds the exclusive lock), new product mutations are rejected with the
  // stable MAINTENANCE_MODE error. Read-only requests and maintenance tooling
  // (backup create/list/delete, diagnostics) keep working so the UI can show
  // an honest maintenance state. Backend-internal work (the restore itself,
  // plugin state restoration) is repository-level and unaffected.
  app.addHook('onRequest', async (request) => {
    if (!ctx.maintenance.isActive()) return;
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
      return;
    }
    const url = (request.url.split('?')[0] ?? '').replace(/\/+$/u, '');
    if (
      url === '/api/v2/backups' ||
      url.startsWith('/api/v2/backups/') ||
      url.startsWith('/api/v2/diagnostics')
    ) {
      return;
    }
    throw new AppError({
      code: ErrorCodes.MAINTENANCE_MODE,
      params: { reason: 'MUTATION_BLOCKED' },
      message: 'mutations are paused during maintenance',
    });
  });

  registerErrorHandler(app, ctx.logger);
  await registerRemoteAuth(app, ctx.config);
  // Express compatibility hooks must be installed before any routes they can
  // observe; actual middleware remains confined to the legacy host module.
  await registerLegacyHost(app, ctx);

  await registerMetaRoutes(app, ctx);
  await registerCharacterRoutes(app, ctx);
  await registerCharacterTransferRoutes(app, ctx);
  await registerCharacterGalleryRoutes(app, ctx);
  await registerBackgroundRoutes(app, ctx);
  await registerChatRoutes(app, ctx);
  await registerMessageBlockRoutes(app, ctx);
  await registerPersonaRoutes(app, ctx);
  await registerLorebookRoutes(app, ctx);
  await registerMemoryRoutes(app, ctx);
  await registerPresetRoutes(app, ctx);
  await registerProfileRoutes(app, ctx);
  await registerConnectionProfileRoutes(app, ctx);
  await registerProviderRoutes(app, ctx);
  await registerSecretRoutes(app, ctx);
  await registerSettingsRoutes(app, ctx);
  await registerSearchRoutes(app, ctx);
  await registerGenerateRoutes(app, ctx);
  await registerEventStreamRoutes(app, ctx);
  await registerBackupRoutes(app, ctx);
  await registerDiagnosticRoutes(app, ctx);
  await registerThemeRoutes(app, ctx);
  await registerPluginRoutes(app, ctx);
  await registerDataImportRoutes(app, ctx);

  // Serve the built SPA when a web dir is configured (single-process mode).
  if (ctx.config.webDir) {
    await app.register(fastifyStatic, {
      root: ctx.config.webDir,
      wildcard: false,
      index: 'index.html',
    });
  }

  // Single not-found handler: SPA fallback when serving the web app, otherwise
  // a JSON error envelope for API clients.
  app.setNotFoundHandler((request, reply) => {
    if (ctx.config.webDir && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      code: ErrorCodes.NOT_FOUND,
      params: { path: request.url },
      traceId: randomToken(8),
    });
  });

  return app;
}
