/**
 * Process registry tests (ТЗ v3.2 §13/§32 Stage E): scoped spawn with
 * output capture, scope enforcement (§32.1), unrestricted gate (§32.2),
 * timeout kill, signal, revoke cleanup, bounded output rings (§32.4) and
 * the handle cap.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertUnrestrictedOrScope,
  createProcessRegistry,
  type ProcessRegistry,
  type ProcessScope,
} from './processHandles.js';

let dataDir: string;
let scope: ProcessScope;
/** Last registry created; afterAll closes every child before rm. */
let processes: ProcessRegistry | undefined;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'neotavern-process-data-'));
  scope = {
    executables: [process.execPath],
    cwdRoots: [dataDir],
    defaultCwd: dataDir,
  };
});

afterAll(async () => {
  await processes?.closeAll();
  // Windows may still hold the directory briefly after child exit; retry.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function registry(_scopeOverride: ProcessScope | undefined = scope): ProcessRegistry {
  processes = createProcessRegistry();
  return processes;
}

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('process registry (§13/§32)', () => {
  it('spawns a scoped node process and captures its output', async () => {
    const processes = registry();
    const id = await processes.spawn(
      'plugin-a',
      process.execPath,
      ['-e', 'console.log("hello from child")'],
      scope.defaultCwd,
      undefined,
      0,
      true,
      true,
    );
    const output = await processes.output('plugin-a', id, 16, 3000, abortSignal());
    expect(output.stdout.join('')).toContain('hello from child');
    const waited = await processes.wait('plugin-a', id, 3000, abortSignal());
    expect(waited.exited).toBe(true);
    expect(waited.exitCode).toBe(0);
  });

  it('rejects a spawn of a missing executable', async () => {
    const processes = registry();
    await expect(
      processes.spawn(
        'plugin-a',
        '/usr/bin/definitely-not-allowed',
        [],
        scope.defaultCwd,
        undefined,
        0,
        true,
        true,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('enforces cwd inside the scope roots (§32.1)', () => {
    expect(() =>
      assertUnrestrictedOrScope(
        'plugin-a',
        process.execPath,
        '/etc',
        () => scope,
        () => false,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PROCESS_SCOPE_DENIED' }));
    expect(
      assertUnrestrictedOrScope(
        'plugin-a',
        process.execPath,
        '',
        () => scope,
        () => false,
      ),
    ).toEqual({ cwd: dataDir });
  });

  it('requires system.unrestricted when no scope exists (§32.2)', () => {
    expect(() =>
      assertUnrestrictedOrScope(
        'plugin-a',
        process.execPath,
        '',
        () => undefined,
        () => false,
      ),
    ).toThrowError(expect.objectContaining({ code: 'SYSTEM_UNRESTRICTED_REQUIRED' }));
    expect(
      assertUnrestrictedOrScope(
        'plugin-a',
        process.execPath,
        '/anywhere',
        () => undefined,
        () => true,
      ),
    ).toEqual({ cwd: '/anywhere' });
  });

  it('kills a runaway child when the timeout fires', async () => {
    const processes = registry();
    const id = await processes.spawn(
      'plugin-a',
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      scope.defaultCwd,
      undefined,
      200,
      false,
      false,
    );
    const waited = await processes.wait('plugin-a', id, 4000, abortSignal());
    expect(waited.exited).toBe(true);
  });

  it('delivers SIGTERM and reports the signal exit', async () => {
    const processes = registry();
    const id = await processes.spawn(
      'plugin-a',
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => process.exit(42)); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
      ],
      scope.defaultCwd,
      undefined,
      0,
      true,
      false,
    );
    const ready = await processes.output('plugin-a', id, 1, 3000, abortSignal());
    expect(ready.stdout.join('')).toContain('ready');
    await processes.signal('plugin-a', id, 'SIGTERM');
    const waited = await processes.wait('plugin-a', id, 3000, abortSignal());
    expect(waited.exited).toBe(true);
    // Windows terminates on SIGTERM without running JS signal handlers.
    if (process.platform !== 'win32') {
      expect(waited.exitCode).toBe(42);
    }
  });

  it('closes plugin processes on closePlugin (revoke, §10.2)', async () => {
    const processes = registry();
    const id = await processes.spawn(
      'plugin-a',
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      scope.defaultCwd,
      undefined,
      0,
      false,
      false,
    );
    await processes.spawn(
      'plugin-b',
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      scope.defaultCwd,
      undefined,
      0,
      false,
      false,
    );
    expect(processes.size()).toBe(2);
    await processes.closePlugin('plugin-a');
    expect(processes.size()).toBe(1);
    await expect(processes.output('plugin-a', id, 1, 0, abortSignal())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await processes.closeAll();
  });

  it('bounds output rings (§32.4): a flood never grows in RAM', async () => {
    const processes = registry();
    const id = await processes.spawn(
      'plugin-a',
      process.execPath,
      ['-e', 'for (let i = 0; i < 5000; i++) console.log("xxxxxxxxxx");'],
      scope.defaultCwd,
      undefined,
      0,
      true,
      true,
    );
    const output = await processes.output('plugin-a', id, 64, 5000, abortSignal());
    expect(output.stdout.length).toBeLessThanOrEqual(64);
    // The child stays blocked on the full stdout pipe: kill it (§32.4);
    // closeHandle marks the handle exited and resolves its exit promise.
    await processes.close('plugin-a', id);
    await processes.closePlugin('plugin-a');
  });

  it('caps live processes per plugin', async () => {
    const processes = registry();
    for (let i = 0; i < 16; i += 1) {
      await processes.spawn(
        'plugin-a',
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        scope.defaultCwd,
        undefined,
        0,
        false,
        false,
      );
    }
    await expect(
      processes.spawn(
        'plugin-a',
        process.execPath,
        ['-e', '1'],
        scope.defaultCwd,
        undefined,
        0,
        false,
        false,
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(processes.size()).toBe(16);
    await processes.closeAll();
  });
});
