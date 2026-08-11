import { describe, expect, it } from 'vitest';
import { maskSecretValue } from '@neotavern/contracts';
import { createTestApp } from './helpers.js';

describe('connection profiles', () => {
  it('masks headers, preserves their masks on update, and atomically applies a full profile', async () => {
    const { app, database } = await createTestApp();
    const provider = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: { kind: 'echo', name: 'Profile echo', model: 'echo', apiKey: 'first-secret' },
    });
    expect(provider.statusCode, provider.payload).toBe(200);
    const providerId = provider.json().id as string;
    const extraSecret = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'second-secret', label: 'Secondary' },
    });
    expect(extraSecret.statusCode, extraSecret.payload).toBe(200);
    const preset = await app.inject({
      method: 'POST',
      url: '/api/v2/presets',
      payload: {
        kind: 'generation',
        name: 'Profile preset',
        data: {
          maxContextTokens: 16032,
          generationDefaults: { temperature: 1.2, stop: ['preset-stop'] },
        },
      },
    });
    expect(preset.statusCode, preset.payload).toBe(200);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/connection-profiles',
      payload: {
        name: 'Complete echo profile',
        mode: 'chat',
        providerConfigId: providerId,
        model: 'echo-profile',
        secretId: extraSecret.json().id,
        presetId: preset.json().id,
        promptPostProcessing: 'merge',
        includeBody: { profile: true },
        excludeBody: ['unused'],
        includeHeaders: { 'X-Profile-Key': 'header-secret' },
        stopStrings: ['profile-stop', 'profile-stop'],
        startReplyWith: 'Prefill: ',
      },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const profileId = created.json().id as string;

    const listed = await app.inject({ method: 'GET', url: '/api/v2/connection-profiles' });
    expect(listed.statusCode, listed.payload).toBe(200);
    const publicProfile = listed.json().items.find((item: { id: string }) => item.id === profileId);
    expect(publicProfile.includeHeaders).toEqual({
      'X-Profile-Key': maskSecretValue('header-secret'),
    });
    expect(listed.payload).not.toContain('header-secret');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v2/connection-profiles/${profileId}`,
      payload: { name: 'Renamed profile', includeHeaders: publicProfile.includeHeaders },
    });
    expect(patched.statusCode, patched.payload).toBe(200);
    expect(patched.json().includeHeaders).toEqual({
      'X-Profile-Key': maskSecretValue('header-secret'),
    });

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/connection-profiles/${profileId}/apply`,
    });
    expect(applied.statusCode, applied.payload).toBe(200);
    expect(applied.json()).toMatchObject({
      activeProviderConfigId: providerId,
      activeGenerationPresetId: preset.json().id,
      appliedFields: expect.arrayContaining([
        'providerConfigId',
        'secretId',
        'presetId',
        'stopStrings',
        'startReplyWith',
      ]),
    });
    const full = await database.repos.providerConfigs.getFullConfig(providerId);
    expect(full).toMatchObject({
      model: 'echo-profile',
      apiKey: 'second-secret',
      settings: {
        promptPostProcessing: 'merge',
        customIncludeBody: { profile: true },
        customExcludeBody: ['unused'],
        customIncludeHeaders: { 'X-Profile-Key': 'header-secret' },
        connectionStopStrings: ['profile-stop', 'profile-stop'],
        assistantPrefill: 'Prefill: ',
      },
    });
    expect(await database.repos.settings.getAll()).toMatchObject({
      activeProviderConfigId: providerId,
      activeGenerationPresetId: preset.json().id,
      maxContextTokens: 16032,
      generationDefaults: { temperature: 1.2, stop: ['preset-stop'] },
    });
  });

  it('rejects incompatible mode and foreign secrets without partially changing a provider', async () => {
    const { app, database } = await createTestApp();
    const first = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: { kind: 'echo', name: 'First', model: 'echo', apiKey: 'first-key' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: { kind: 'echo', name: 'Second', model: 'echo', apiKey: 'second-key' },
    });
    const firstId = first.json().id as string;
    const secondId = second.json().id as string;
    const foreignSecret = (await database.repos.providerSecrets.listByProvider(firstId))[0];
    expect(foreignSecret).toBeDefined();

    const foreignProfile = await app.inject({
      method: 'POST',
      url: '/api/v2/connection-profiles',
      payload: {
        name: 'Foreign secret',
        mode: 'chat',
        providerConfigId: secondId,
        model: 'must-not-persist',
        secretId: foreignSecret?.id,
      },
    });
    const before = await database.repos.providerConfigs.getFullConfig(secondId);
    const rejectedSecret = await app.inject({
      method: 'POST',
      url: `/api/v2/connection-profiles/${foreignProfile.json().id}/apply`,
    });
    expect(rejectedSecret.statusCode).toBe(422);
    expect(rejectedSecret.json().code).toBe('CONNECTION_PROFILE_SECRET_INVALID');
    expect(await database.repos.providerConfigs.getFullConfig(secondId)).toEqual(before);

    const wrongMode = await app.inject({
      method: 'POST',
      url: '/api/v2/connection-profiles',
      payload: { name: 'Wrong mode', mode: 'text', providerConfigId: secondId },
    });
    const rejectedMode = await app.inject({
      method: 'POST',
      url: `/api/v2/connection-profiles/${wrongMode.json().id}/apply`,
    });
    expect(rejectedMode.statusCode).toBe(422);
    expect(rejectedMode.json().code).toBe('CONNECTION_PROFILE_MODE_MISMATCH');
  });

  it('requires an explicit adapter capability before applying assistant prefill', async () => {
    const { app, providers } = await createTestApp();
    providers.register('plugin-without-prefill', () => ({
      kind: 'plugin-without-prefill',
      async validateConfig() {
        return { valid: true, issues: [] };
      },
      async listModels() {
        return [];
      },
      async *generate() {
        yield { type: 'done' as const, text: 'unused' };
      },
    }));
    const provider = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: { kind: 'plugin-without-prefill', name: 'Plugin', model: 'plugin-model' },
    });
    expect(provider.statusCode, provider.payload).toBe(200);
    const profile = await app.inject({
      method: 'POST',
      url: '/api/v2/connection-profiles',
      payload: {
        name: 'No prefill capability',
        mode: 'chat',
        providerConfigId: provider.json().id,
        startReplyWith: 'Blocked: ',
      },
    });
    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/connection-profiles/${profile.json().id}/apply`,
    });
    expect(applied.statusCode).toBe(422);
    expect(applied.json().code).toBe('CONNECTION_PROFILE_PREFILL_UNSUPPORTED');
  });
});
