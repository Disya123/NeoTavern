/**
 * Resource Governor unit tests (ТЗ §8, ADR-0026): pressure ladder, admission
 * control, per-plugin hard limits, CPU watchdog, victim selection and the
 * fallback IPC usage reports. The sampler, cgroup snapshot and clock are
 * injected, so the suite is deterministic on any OS.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '@neotavern/shared';
import { loadConfig, type PluginResourceConfig } from '../src/config.js';
import type { CgroupInfo } from '../src/plugin/cgroup.js';
import { ResourceGovernor, type ProcessSample } from '../src/plugin/resourceGovernor.js';

const MIB = 1024 * 1024;

interface GovernorHarness {
  governor: ResourceGovernor;
  sampler: (pid: number) => ProcessSample;
  setRss(pluginId: string, rssMiB: number): void;
  setCpuMs(pluginId: string, cpuMs: number): void;
  setTreeMiB(miB: number): void;
  advance(ms: number): void;
  terminated: Array<{ pluginId: string; reason: string }>;
  levels: string[];
  register(pluginId: string): void;
}

function harness(
  options: {
    overrides?: Partial<PluginResourceConfig>;
    plugin?: {
      heapMiB?: number;
      rssSoftMiB?: number;
      rssHardMiB?: number;
      cpuSoftPercent?: number;
      cpuHardPercent?: number;
    };
  } = {},
): GovernorHarness {
  const resources = loadConfig({}).resources as PluginResourceConfig;
  if (options.overrides) {
    resources.plugins = { ...resources.plugins, ...options.overrides.plugins };
    resources.server = { ...resources.server, ...options.overrides.server };
  }
  const rssByPid = new Map<number, number>();
  const cpuByPid = new Map<number, number>();
  const treeOverride: CgroupInfo = {
    available: true,
    controllerPath: '/test.scope',
    root: '/sys/fs/cgroup',
    memoryCurrentMiB: null,
    memoryMaxMiB: null,
    memoryHighMiB: null,
  };
  let clock = 0;
  const sampler = (pid: number): ProcessSample => ({
    rssBytes: rssByPid.get(pid) ?? null,
    cpuMs: cpuByPid.get(pid) ?? null,
  });
  const terminated: GovernorHarness['terminated'] = [];
  const levels: string[] = [];
  const governor = new ResourceGovernor({
    config: resources,
    logger: createLogger({ level: 'error' }),
    sampler,
    cgroup: treeOverride,
    sampleIntervalMs: 1000,
    hardViolationSamples: 2,
    cpuHardConsecutiveSamples: 2,
    now: () => clock,
  });
  governor.onTerminate = (pluginId, reason) => {
    terminated.push({ pluginId, reason });
  };
  governor.onPressureChange = (level) => levels.push(level);
  const setRss = (pluginId: string, rssMiB: number): void => {
    const state = governor.snapshot().processes.find((p) => p.pluginId === pluginId);
    if (state) rssByPid.set(state.pid, rssMiB * MIB);
  };
  const setCpuMs = (pluginId: string, cpuMs: number): void => {
    const state = governor.snapshot().processes.find((p) => p.pluginId === pluginId);
    if (state) cpuByPid.set(state.pid, cpuMs);
  };
  const advance = (ms: number): void => {
    clock += ms;
  };
  const setTreeMiB = (miB: number): void => {
    treeOverride.memoryCurrentMiB = miB;
  };
  const plugin = options.plugin ?? {};
  return {
    governor,
    sampler,
    setRss,
    setCpuMs,
    setTreeMiB,
    advance,
    terminated,
    levels,
    register: (id: string) =>
      governor.registerProcess({
        pluginId: id,
        pid: id.length + 1000,
        heapMiB: plugin.heapMiB ?? 96,
        rssSoftMiB: plugin.rssSoftMiB ?? 128,
        rssHardMiB: plugin.rssHardMiB ?? 192,
        cpuSoftPercent: plugin.cpuSoftPercent ?? 63,
        cpuHardPercent: plugin.cpuHardPercent ?? 90,
      }),
  };
}

describe('ResourceGovernor ledger', () => {
  it('registers processes and reports them in the snapshot with their limits', () => {
    const h = harness();
    h.governor.registerProcess({
      pluginId: 'a.example',
      pid: 4242,
      heapMiB: 96,
      rssSoftMiB: 128,
      rssHardMiB: 192,
      cpuSoftPercent: 63,
      cpuHardPercent: 90,
    });
    const snapshot = h.governor.snapshot();
    expect(snapshot.profile).toBe('low-vps-3gb');
    const process = snapshot.processes.find((p) => p.pluginId === 'a.example');
    expect(process).toMatchObject({ pid: 4242, heapMiB: 96, rssSoftMiB: 128, rssHardMiB: 192 });
    expect(h.governor.limitsFor('a.example')).toMatchObject({ version: 1, heapMiB: 96 });
    expect(h.governor.limitsFor('unknown.id')).toBeNull();
  });

  it('unregisters processes on demand', () => {
    const h = harness();
    h.governor.registerProcess({
      pluginId: 'a.example',
      pid: 1,
      heapMiB: 96,
      rssSoftMiB: 128,
      rssHardMiB: 192,
      cpuSoftPercent: 63,
      cpuHardPercent: 90,
    });
    h.governor.unregisterProcess('a.example');
    expect(h.governor.snapshot().processes).toHaveLength(0);
  });
});

describe('ResourceGovernor pressure ladder', () => {
  const budget = () =>
    harness({
      overrides: {
        plugins: { aggregateRssSoftMiB: 100, aggregateRssHardMiB: 200 },
        server: { processTreeRssSoftMiB: 500, processTreeRssHardMiB: 600 },
      },
    });

  it('starts at ok and admits every kind of work', () => {
    const h = budget();
    expect(h.governor.snapshot().level).toBe('ok');
    for (const kind of ['plugin-start', 'maintenance', 'heavy', 'background'] as const) {
      expect(h.governor.canAdmit(kind).ok).toBe(true);
    }
  });

  it('reaches soft at 80% of the aggregate soft budget and blocks maintenance/heavy', async () => {
    const h = budget();
    h.register('a.example');
    h.register('b.example');
    h.setRss('a.example', 40);
    h.setRss('b.example', 40);
    await h.governor.sample();
    expect(h.governor.snapshot().level).toBe('soft');
    expect(h.governor.canAdmit('maintenance').ok).toBe(false);
    expect(h.governor.canAdmit('heavy').ok).toBe(false);
    expect(h.governor.canAdmit('plugin-start').ok).toBe(true);
  });

  it('reaches critical at the aggregate soft budget and blocks background work', async () => {
    const h = budget();
    h.register('a.example');
    h.setRss('a.example', 100);
    await h.governor.sample();
    expect(h.governor.snapshot().level).toBe('critical');
    expect(h.governor.canAdmit('background').ok).toBe(false);
    const denied = h.governor.canAdmit('background');
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe('RESOURCE_PRESSURE');
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('emits pressure change events with machine-readable reasons', async () => {
    const h = budget();
    h.register('a.example');
    h.setRss('a.example', 100);
    await h.governor.sample();
    expect(h.levels).toContain('critical');
    const actions = h.governor.snapshot().actions;
    expect(actions[0]).toMatchObject({
      pluginId: null,
      resource: 'tree',
      action: 'pressure:critical',
    });
    expect(actions[0].traceId).toBeTruthy();
  });
});

describe('ResourceGovernor hard limits', () => {
  it('terminates a plugin that stays over its per-plugin RSS hard limit', async () => {
    const h = harness({
      overrides: {
        plugins: { aggregateRssHardMiB: 500 },
        server: { processTreeRssHardMiB: 900 },
      },
      plugin: { rssHardMiB: 50 },
    });
    h.register('runaway.example');
    h.setRss('runaway.example', 200);
    await h.governor.sample();
    await h.governor.sample();
    expect(h.terminated).toEqual([
      { pluginId: 'runaway.example', reason: 'RESOURCE_LIMIT_EXCEEDED' },
    ]);
    expect(h.governor.isTerminated('runaway.example')).toBe(true);
  });

  it('picks the largest-overage victim on global hard pressure (not the first)', async () => {
    const h = harness({
      overrides: {
        plugins: { aggregateRssSoftMiB: 100, aggregateRssHardMiB: 150 },
      },
      plugin: { rssHardMiB: 100 },
    });
    h.register('big.example');
    h.register('small.example');
    // Both are over their own soft budget; big exceeds its per-plugin hard
    // limit but the consecutive-violation counter needs two samples, so on
    // this first tick the aggregate hard budget is hit first and the victim
    // selection (overage × priority) must pick the larger offender.
    h.setRss('big.example', 120);
    h.setRss('small.example', 40);
    await h.governor.sample();
    expect(h.governor.snapshot().level).toBe('hard');
    expect(h.terminated.map((t) => t.pluginId)).toEqual(['big.example']);
  });

  it('never kills blindly when no process RSS is attributable', async () => {
    const h = harness({
      overrides: {
        plugins: { aggregateRssSoftMiB: 100, aggregateRssHardMiB: 150 },
        server: { processTreeRssSoftMiB: 500, processTreeRssHardMiB: 600 },
      },
    });
    h.register('silent.example');
    // The cgroup measurement exceeds the whole-tree hard budget while the
    // per-process sampler reports nothing attributable to any plugin.
    h.setTreeMiB(1000);
    await h.governor.sample();
    expect(h.governor.snapshot().level).toBe('hard');
    expect(h.terminated).toHaveLength(0);
  });
});

describe('ResourceGovernor CPU watchdog', () => {
  it('terminates a busy plugin whose per-interval CPU usage stays above the hard threshold', async () => {
    const h = harness({
      overrides: { plugins: { backgroundCpuPercent: 100 } },
      plugin: { cpuHardPercent: 90, cpuSoftPercent: 63 },
    });
    h.register('burner.example');
    h.advance(1000);
    await h.governor.sample();
    // 900 ms of CPU per 1000 ms wall interval = 90% of one core.
    h.setCpuMs('burner.example', 900);
    h.advance(1000);
    await h.governor.sample();
    h.setCpuMs('burner.example', 1800);
    h.advance(1000);
    await h.governor.sample();
    expect(h.terminated).toEqual([{ pluginId: 'burner.example', reason: 'CPU_WATCHDOG' }]);
  });

  it('does not terminate a plugin with an idle CPU profile', async () => {
    const h = harness({
      overrides: { plugins: { backgroundCpuPercent: 100 } },
      plugin: { cpuHardPercent: 90, cpuSoftPercent: 63 },
    });
    h.register('idle.example');
    h.advance(1000);
    await h.governor.sample();
    h.setCpuMs('idle.example', 5);
    h.advance(1000);
    await h.governor.sample();
    h.setCpuMs('idle.example', 10);
    h.advance(1000);
    await h.governor.sample();
    expect(h.terminated).toHaveLength(0);
  });
});

describe('ResourceGovernor fallback IPC usage reports', () => {
  it('uses cooperative reports when /proc sampling yields nothing', async () => {
    const h = harness();
    h.governor.registerProcess({
      pluginId: 'remote.example',
      pid: 9999,
      heapMiB: 96,
      rssSoftMiB: 128,
      rssHardMiB: 192,
      cpuSoftPercent: 63,
      cpuHardPercent: 90,
    });
    h.governor.handleUsageReport('remote.example', {
      heapUsed: 50 * MIB,
      rss: 90 * MIB,
      cpuMs: 1200,
      uptimeMs: 10_000,
    });
    const process = h.governor.snapshot().processes.find((p) => p.pluginId === 'remote.example');
    expect(process?.rssMiB).toBe(90);
    expect(process?.source).toBe('ipc');
  });
});
