/**
 * Host-side process handles (ТЗ v3.2 §13/§32 Stage E). The plugin never
 * spawns processes directly: `process.spawn` goes through the Capability
 * Broker and this module keeps the trusted children host-side.
 *
 * Security model:
 * - Always `shell: false`, `detached: false`, sanitized env (§32.1).
 * - Scoped mode (§32.1): executable and cwd must match the host policy
 *   (injected `scopeOf`); a mismatch fails with `PROCESS_SCOPE_DENIED`.
 * - Unrestricted mode (§32.2): only when the plugin holds
 *   `system.unrestricted` (checked by the executor before calling spawn);
 *   the plugin then gets the OS-user's actual authority — this is a
 *   separate high-risk grant, not a hidden upgrade path.
 * - Output is a bounded ring per stream (§32.4): a stdout flood cannot grow
 *   in RAM. `child.kill()` targets the immediate child only; descendant
 *   process-tree containment is NOT guaranteed in pure Node (§32.3) and is
 *   documented, not promised.
 * - Handles close on revoke of `process.spawn` / `system.unrestricted` and
 *   on executor shutdown.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  PROCESS_MAX_BUFFER_BYTES,
  PROCESS_MAX_HANDLES,
  PROCESS_MAX_OUTPUT_CHUNKS,
} from '@neotavern/contracts';
import { BrokerCallError } from '../broker/capabilityBroker.js';

export interface ProcessScope {
  /** Absolute executable paths allowed in scoped mode. */
  executables: string[];
  /** Allowed cwd roots (a cwd must resolve inside one of them). */
  cwdRoots: string[];
  /** Default cwd when the plugin omits it. */
  defaultCwd: string;
}

export interface ProcessRegistry {
  spawn(
    pluginId: string,
    executable: string,
    args: string[],
    cwd: string,
    env: Record<string, string> | undefined,
    timeoutMs: number,
    stdout: boolean,
    stderr: boolean,
  ): Promise<string>;
  output(
    pluginId: string,
    id: string,
    limit: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<{ stdout: string[]; stderr: string[]; exited: boolean; exitCode: number | null }>;
  signal(pluginId: string, id: string, signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): Promise<void>;
  wait(
    pluginId: string,
    id: string,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<{ exited: boolean; exitCode: number | null }>;
  close(pluginId: string, id: string): Promise<void>;
  closePlugin(pluginId: string): Promise<void>;
  closeAll(): Promise<void>;
  size(): number;
}

interface ProcessHandle {
  id: string;
  pluginId: string;
  child: ChildProcess;
  stdoutChunks: string[];
  stderrChunks: string[];
  bufferedBytes: number;
  exited: boolean;
  exitCode: number | null;
  waiters: Array<() => void>;
  timer: NodeJS.Timeout | null;
  /** Settles when the child exits (or is killed by closeHandle). */
  exitedPromise: Promise<void>;
  resolveExited: () => void;
}

function pushChunks(handle: ProcessHandle, chunks: string[], data: string): void {
  const bytes = Buffer.byteLength(data, 'utf8');
  chunks.push(data);
  handle.bufferedBytes += bytes;
  while (
    chunks.length > PROCESS_MAX_OUTPUT_CHUNKS ||
    handle.bufferedBytes > PROCESS_MAX_BUFFER_BYTES
  ) {
    const dropped = chunks.shift();
    if (dropped !== undefined) handle.bufferedBytes -= Buffer.byteLength(dropped, 'utf8');
  }
}

function drainChunks(chunks: string[], limit: number): string[] {
  const take = Math.min(limit, chunks.length);
  return chunks.splice(0, take);
}

export function createProcessRegistry(): ProcessRegistry {
  const handles = new Map<string, ProcessHandle>();
  let nextId = 0;

  function allocate(pluginId: string): ProcessHandle {
    const owned = [...handles.values()].filter((handle) => handle.pluginId === pluginId).length;
    if (owned >= PROCESS_MAX_HANDLES) {
      throw new BrokerCallError('SERVICE_UNAVAILABLE', {
        message: 'too many live processes',
        details: { pluginId, limit: PROCESS_MAX_HANDLES },
      });
    }
    const id = `proc-${pluginId.slice(0, 24)}-${++nextId}-${randomBytes(3).toString('hex')}`;
    let resolveExited: () => void = () => undefined;
    const exitedPromise = new Promise<void>((resolveExit) => {
      resolveExited = resolveExit;
    });
    const handle: ProcessHandle = {
      id,
      pluginId,
      child: undefined as unknown as ChildProcess,
      stdoutChunks: [],
      stderrChunks: [],
      bufferedBytes: 0,
      exited: false,
      exitCode: null,
      waiters: [],
      timer: null,
      exitedPromise,
      resolveExited,
    };
    handles.set(id, handle);
    return handle;
  }

  function requireHandle(pluginId: string, id: string): ProcessHandle {
    const handle = handles.get(id);
    if (handle === undefined || handle.pluginId !== pluginId) {
      throw new BrokerCallError('NOT_FOUND', {
        message: 'unknown process handle',
        details: { id },
      });
    }
    return handle;
  }

  function wake(handle: ProcessHandle): void {
    const waiter = handle.waiters.shift();
    waiter?.();
  }

  function waitFor(handle: ProcessHandle, waitMs: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (handle.exited) {
        resolve(true);
        return;
      }
      const wakeNow = (): void => {
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(wakeNow, Math.max(0, waitMs));
      const onAbort = (): void => {
        cleanup();
        resolve(false);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const index = handle.waiters.indexOf(wakeNow);
        if (index >= 0) handle.waiters.splice(index, 1);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      handle.waiters.push(wakeNow);
    });
  }

  function closeHandle(id: string): void {
    const handle = handles.get(id);
    if (handle === undefined) return;
    handles.delete(id);
    handle.exited = true;
    if (handle.timer !== null) clearTimeout(handle.timer);
    // §32.3: kill() is the immediate child only; descendant containment is
    // best-effort in pure Node and never promised.
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill('SIGKILL');
    }
    handle.resolveExited();
    wake(handle);
  }

  return {
    async spawn(pluginId, executable, args, cwd, env, timeoutMs, stdout, stderr) {
      const handle = allocate(pluginId);
      const child = spawn(executable, args, {
        cwd,
        env:
          env === undefined
            ? { PATH: process.env['PATH'] ?? '' }
            : { ...env, PATH: process.env['PATH'] ?? '' },
        shell: false, // §32.1: never a shell
        detached: false, // §32.3: never detached
        windowsHide: true,
        stdio: ['ignore', stdout ? 'pipe' : 'ignore', stderr ? 'pipe' : 'ignore'],
      });
      handle.child = child;
      if (stdout) {
        child.stdout?.on('data', (chunk) => {
          pushChunks(handle, handle.stdoutChunks, chunk.toString('utf8'));
          wake(handle);
        });
      }
      if (stderr) {
        child.stderr?.on('data', (chunk) => {
          pushChunks(handle, handle.stderrChunks, chunk.toString('utf8'));
          wake(handle);
        });
      }
      // Registered before the spawn gate so a fast exit can never be missed.
      child.on('exit', (code) => {
        handle.exited = true;
        handle.exitCode = code;
        handle.resolveExited();
        wake(handle);
      });
      // A spawn failure (ENOENT, permission) rejects the call instead of
      // leaking an unhandled 'error' event; errors after a successful spawn
      // surface through the bounded stderr ring (§32.4).
      await new Promise<void>((resolve, reject) => {
        child.once('error', (error) => {
          closeHandle(handle.id);
          reject(
            new BrokerCallError('NOT_FOUND', {
              message: 'process spawn failed',
              details: { executable, cause: error.message },
            }),
          );
        });
        child.once('spawn', () => {
          child.removeAllListeners('error');
          child.on('error', (error) => {
            pushChunks(handle, handle.stderrChunks, `process error: ${error.message}`);
            handle.exited = true;
            handle.resolveExited();
            wake(handle);
          });
          resolve();
        });
      });
      if (timeoutMs > 0) {
        handle.timer = setTimeout(() => {
          if (!handle.exited && handle.child.exitCode === null) {
            handle.child.kill('SIGKILL');
          }
        }, timeoutMs);
      }
      return handle.id;
    },
    async output(pluginId, id, limit, waitMs, signal) {
      const handle = requireHandle(pluginId, id);
      await waitFor(handle, waitMs, signal);
      return {
        stdout: drainChunks(handle.stdoutChunks, limit),
        stderr: drainChunks(handle.stderrChunks, limit),
        exited: handle.exited,
        exitCode: handle.exitCode,
      };
    },
    async signal(pluginId, id, signal) {
      const handle = requireHandle(pluginId, id);
      if (!handle.exited) {
        handle.child.kill(signal);
      }
    },
    async wait(pluginId, id, waitMs, signal) {
      const handle = requireHandle(pluginId, id);
      await waitFor(handle, waitMs, signal);
      return { exited: handle.exited, exitCode: handle.exitCode };
    },
    async close(pluginId, id) {
      requireHandle(pluginId, id);
      closeHandle(id);
    },
    async closePlugin(pluginId) {
      const closing: Promise<void>[] = [];
      for (const id of [...handles.keys()]) {
        const handle = handles.get(id);
        if (handle !== undefined && handle.pluginId === pluginId) {
          closeHandle(id);
          closing.push(handle.exitedPromise);
        }
      }
      await Promise.all(closing);
    },
    async closeAll() {
      const closing: Promise<void>[] = [];
      for (const id of [...handles.keys()]) {
        const handle = handles.get(id);
        if (handle !== undefined) {
          closeHandle(id);
          closing.push(handle.exitedPromise);
        }
      }
      await Promise.all(closing);
    },
    size() {
      return handles.size;
    },
  };
}

/** §32.2 capability gate: unrestricted spawn requires system.unrestricted. */
export function assertUnrestrictedOrScope(
  pluginId: string,
  executable: string,
  cwd: string,
  scopeOf: (pluginId: string) => ProcessScope | undefined,
  hasUnrestricted: (pluginId: string) => boolean,
): { cwd: string } {
  if (hasUnrestricted(pluginId)) return { cwd };
  const scope = scopeOf(pluginId);
  if (scope === undefined) {
    throw new BrokerCallError('SYSTEM_UNRESTRICTED_REQUIRED', {
      message: 'unrestricted process execution requires system.unrestricted',
      details: { executable },
    });
  }
  if (
    !scope.executables.some(
      (allowed) => allowed.replace(/\\/g, '/') === executable.replace(/\\/g, '/'),
    )
  ) {
    throw new BrokerCallError('PROCESS_SCOPE_DENIED', {
      message: 'executable is not in the plugin scope',
      details: { executable, allowed: scope.executables },
    });
  }
  const effectiveCwd = cwd.length === 0 ? scope.defaultCwd : cwd;
  const insideRoot = scope.cwdRoots.some(
    (root) =>
      effectiveCwd === root ||
      effectiveCwd.startsWith(`${root.replace(/[\\/]+$/, '')}/`) ||
      effectiveCwd.startsWith(`${root.replace(/[\\/]+$/, '')}\\`),
  );
  if (!insideRoot) {
    throw new BrokerCallError('PROCESS_SCOPE_DENIED', {
      message: 'cwd is outside the plugin scope',
      details: { cwd: effectiveCwd },
    });
  }
  return { cwd: effectiveCwd };
}
