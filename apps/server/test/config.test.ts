/**
 * Resource profile configuration tests (ТЗ §8.1, §20, §20.1, MIG-05):
 * preset selection, legacy `low-vps` → `low-vps-2gb` mapping, env-alias
 * precedence over the config file, config-file schema validation and a
 * frozen snapshot of the reference `low-vps-3gb` budgets.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'neotavern-config-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('low-vps-3gb reference profile (ТЗ §8.1)', () => {
  it('is the default and carries the exact §8.1 budgets', () => {
    const resources = loadConfig({}).resources;
    expect(resources.profile).toBe('low-vps-3gb');
    expect(resources).toEqual({
      profile: 'low-vps-3gb',
      server: {
        nodeHeapMiB: 512,
        processTreeRssSoftMiB: 2048,
        processTreeRssHardMiB: 2432,
        // target lowered below the §23.2 B01 SLO (idle tree ≤ 500 MiB p95)
        mainRssTargetMiB: 450,
        mainRssHardMiB: 640,
      },
      plugins: {
        maxActiveBackends: 5,
        maxWarmBackends: 2,
        defaultIdleTimeoutSec: 90,
        aggregateRssSoftMiB: 1152,
        aggregateRssHardMiB: 1536,
        defaultProcessHeapMiB: 96,
        defaultProcessRssSoftMiB: 128,
        defaultProcessRssHardMiB: 192,
        cpuHeavyConcurrency: 1,
        backgroundCpuPercent: 100,
        networkGlobalConcurrency: 12,
        networkPerPluginConcurrency: 3,
        serviceGlobalConcurrency: 12,
        servicePerPluginConcurrency: 3,
        serviceInFlightMiBPerPlugin: 4,
        jobsGlobalConcurrency: 2,
        jobsPerPluginConcurrency: 1,
        eventReplayBytesMiB: 16,
        eventReplayBytesPerNameMiB: 4,
        ipcInFlightBytesMiB: 32,
        ipcInFlightBytesPerPluginMiB: 4,
        installConcurrency: 1,
        dependencyUnpackedMiBPerPlugin: 96,
      },
      database: { cacheMiB: 64, maintenancePriority: 'background' },
    });
  });
});

describe('profile selection', () => {
  it('selects low-vps-2gb explicitly with the frozen 2 GiB budgets', () => {
    const resources = loadConfig({ NEOTA_RESOURCE_PROFILE: 'low-vps-2gb' }).resources;
    expect(resources.profile).toBe('low-vps-2gb');
    expect(resources.server.processTreeRssSoftMiB).toBe(1280);
    expect(resources.server.processTreeRssHardMiB).toBe(1536);
    expect(resources.plugins.defaultProcessHeapMiB).toBe(64);
    expect(resources.plugins.maxActiveBackends).toBe(3);
    expect(resources.database.cacheMiB).toBe(32);
  });

  it('maps the legacy v1.0 name `low-vps` to the frozen low-vps-2gb (MIG-05)', () => {
    const resources = loadConfig({ NEOTA_RESOURCE_PROFILE: 'low-vps' }).resources;
    expect(resources.profile).toBe('low-vps-2gb');
    expect(resources.plugins.aggregateRssSoftMiB).toBe(640);
  });

  it('supports the standard preset', () => {
    const resources = loadConfig({ NEOTA_RESOURCE_PROFILE: 'standard' }).resources;
    expect(resources.profile).toBe('standard');
    expect(resources.server.nodeHeapMiB).toBe(1024);
  });

  it('rejects unknown profile names loudly', () => {
    expect(() => loadConfig({ NEOTA_RESOURCE_PROFILE: 'bogus' })).toThrow(
      /Unknown NEOTA_RESOURCE_PROFILE/,
    );
  });
});

describe('env aliases (ТЗ §20.1)', () => {
  it('NEOTA_MEMORY_BUDGET_MB overrides the process-tree hard budget', () => {
    const resources = loadConfig({ NEOTA_MEMORY_BUDGET_MB: '2500' }).resources;
    expect(resources.server.processTreeRssHardMiB).toBe(2500);
  });

  it('plugin env aliases override preset values', () => {
    const resources = loadConfig({
      NEOTA_PLUGIN_MAX_ACTIVE_BACKENDS: '4',
      NEOTA_PLUGIN_DEFAULT_HEAP_MB: '128',
      NEOTA_PLUGIN_DEFAULT_RSS_HARD_MB: '256',
      NEOTA_PLUGIN_CPU_HEAVY_CONCURRENCY: '1',
    }).resources;
    expect(resources.plugins.maxActiveBackends).toBe(4);
    expect(resources.plugins.defaultProcessHeapMiB).toBe(128);
    expect(resources.plugins.defaultProcessRssHardMiB).toBe(256);
    expect(resources.plugins.cpuHeavyConcurrency).toBe(1);
  });

  it('ignores empty env values (falls back to the preset)', () => {
    const resources = loadConfig({ NEOTA_MEMORY_BUDGET_MB: '' }).resources;
    expect(resources.server.processTreeRssHardMiB).toBe(2432);
  });
});

describe('config file (NEOTA_CONFIG_FILE)', () => {
  it('applies overrides on top of the named profile and reports it', () => {
    const file = join(tempDir, 'config.yaml');
    writeFileSync(
      file,
      [
        'resourceProfile: low-vps-3gb',
        'plugins:',
        '  maxActiveBackends: 7',
        '  networkGlobalConcurrency: 20',
        'database:',
        '  cacheMiB: 128',
      ].join('\n'),
      'utf8',
    );
    const resources = loadConfig({ NEOTA_CONFIG_FILE: file }).resources;
    expect(resources.profile).toBe('low-vps-3gb');
    expect(resources.plugins.maxActiveBackends).toBe(7);
    expect(resources.plugins.networkGlobalConcurrency).toBe(20);
    expect(resources.plugins.networkPerPluginConcurrency).toBe(3);
    expect(resources.database.cacheMiB).toBe(128);
  });

  it('env aliases win over the config file', () => {
    const file = join(tempDir, 'config.yaml');
    writeFileSync(file, 'resourceProfile: low-vps-3gb\nplugins:\n  maxActiveBackends: 7\n', 'utf8');
    const resources = loadConfig({
      NEOTA_CONFIG_FILE: file,
      NEOTA_PLUGIN_MAX_ACTIVE_BACKENDS: '2',
    }).resources;
    expect(resources.plugins.maxActiveBackends).toBe(2);
  });

  it('accepts the legacy profile name in the file (mapped to low-vps-2gb)', () => {
    const file = join(tempDir, 'config.yaml');
    writeFileSync(file, 'resourceProfile: low-vps\n', 'utf8');
    expect(loadConfig({ NEOTA_CONFIG_FILE: file }).resources.profile).toBe('low-vps-2gb');
  });

  it('rejects invalid YAML', () => {
    const file = join(tempDir, 'config.yaml');
    writeFileSync(file, 'resourceProfile: [unclosed', 'utf8');
    expect(() => loadConfig({ NEOTA_CONFIG_FILE: file })).toThrow(/not valid YAML/);
  });

  it('rejects unknown fields (additionalProperties: false)', () => {
    const file = join(tempDir, 'config.yaml');
    writeFileSync(file, 'resourceProfile: low-vps-3gb\nbogus: 1\n', 'utf8');
    expect(() => loadConfig({ NEOTA_CONFIG_FILE: file })).toThrow(/schema validation/);
  });

  it('fails loudly when the file is unreadable', () => {
    expect(() => loadConfig({ NEOTA_CONFIG_FILE: join(tempDir, 'missing.yaml') })).toThrow(
      /not readable/,
    );
  });
});

describe('CORS origin default by deployment mode', () => {
  it('defaults to the Vite dev origin without NEOTA_WEB_DIR', () => {
    expect(loadConfig({}).corsOrigin).toBe('http://127.0.0.1:5173');
  });

  it('defaults to the server own origin in single-process mode (NEOTA_WEB_DIR)', () => {
    const config = loadConfig({ NEOTA_WEB_DIR: 'web', NEOTA_PORT: '9000' });
    expect(config.corsOrigin).toBe('http://127.0.0.1:9000');
  });

  it('canonicalizes loopback hosts in the own-origin default', () => {
    const config = loadConfig({ NEOTA_WEB_DIR: 'web', NEOTA_HOST: 'localhost' });
    expect(config.corsOrigin).toBe('http://127.0.0.1:8000');
  });

  it('keeps the effective port in the own-origin default', () => {
    expect(loadConfig({ NEOTA_WEB_DIR: 'web', NEOTA_PORT: '8765' }).corsOrigin).toBe(
      'http://127.0.0.1:8765',
    );
  });

  it('lets NEOTA_CORS_ORIGIN override the single-process default', () => {
    const config = loadConfig({ NEOTA_WEB_DIR: 'web', NEOTA_CORS_ORIGIN: 'http://localhost:9000' });
    expect(config.corsOrigin).toBe('http://localhost:9000');
  });
});
