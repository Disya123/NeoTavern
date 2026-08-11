/** Health and version endpoints. */
import { HealthResponseSchema, VersionResponseSchema } from '@neotavern/contracts';
import type { AppContext, TypedApp } from '../types.js';

export const APP_VERSION = '0.1.0';
export const API_VERSION = 2;

export async function registerMetaRoutes(app: TypedApp, _ctx: AppContext): Promise<void> {
  app.get('/api/v2/health', { schema: { response: { 200: HealthResponseSchema } } }, async () => ({
    status: 'ok' as const,
    uptime: process.uptime(),
  }));

  app.get(
    '/api/v2/version',
    { schema: { response: { 200: VersionResponseSchema } } },
    async () => ({ name: 'NeoTavern', version: APP_VERSION, apiVersion: API_VERSION }),
  );
}
