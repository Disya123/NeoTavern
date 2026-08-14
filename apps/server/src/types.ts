/** Shared app types: the typed Fastify instance and the dependency context. */
import Fastify from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppDatabase } from '@neotavern/db';
import type { ProviderRegistry } from '@neotavern/provider-sdk';
import type { PluginEventBus } from '@neotavern/plugin-sdk';
import type { Logger } from '@neotavern/shared';
import type { ServerConfig } from './config.js';
import type { DataPaths } from './lib/paths.js';
import type { MaintenanceController } from './lib/maintenance.js';
import type { ContextStrategyRegistry } from './pipeline/contextShift.js';
import type { PostProcessorRegistry } from './pipeline/postProcess.js';

/** JSON request body cap for all API routes (ТЗ §13 size checks). */
export const API_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** Create a Fastify instance with the TypeBox type provider wired in. */
export function createAppInstance() {
  return Fastify({
    logger: false,
    bodyLimit: API_BODY_LIMIT_BYTES,
    ajv: { customOptions: { coerceTypes: 'array', removeAdditional: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();
}

/** Fastify instance typed with the TypeBox provider (schema-derived types). */
export type TypedApp = ReturnType<typeof createAppInstance>;

/** Dependencies shared by all route modules. */
export interface AppContext {
  database: AppDatabase;
  providers: ProviderRegistry;
  contextStrategies: ContextStrategyRegistry;
  postProcessors: PostProcessorRegistry;
  events: PluginEventBus;
  config: ServerConfig;
  logger: Logger;
  paths: DataPaths;
  /** Global maintenance lock (ТЗ §10.4): restore runs under it exclusively. */
  maintenance: MaintenanceController;
}

/** Dependencies accepted by app assembly; an event bus is created when omitted. */
export type AppContextInput = Omit<AppContext, 'events' | 'maintenance'> & {
  events?: PluginEventBus;
  maintenance?: MaintenanceController;
};
