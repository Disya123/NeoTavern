/**
 * cgroup v2 helpers for the resource governor (ADR-0026, ТЗ RES-02).
 *
 * The server never creates cgroups (no privileges guaranteed): it reads the
 * cgroup it already lives in (systemd scope, container or systemd-run), which
 * by default contains every descendant process — including spawned plugin
 * children. `memory.current` is the process-tree RSS source when available;
 * `memory.max` is the tree's hard ceiling the operator configured.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CgroupInfo {
  available: boolean;
  /** Control-group path from `/proc/self/cgroup` (e.g. `/user.slice/…`). */
  controllerPath: string | null;
  /** cgroup v2 filesystem root (overridable via NEOTA_CGROUP_ROOT). */
  root: string;
  memoryCurrentMiB: number | null;
  /** `memory.max`; `null` when the file reports `max` (no limit). */
  memoryMaxMiB: number | null;
  memoryHighMiB: number | null;
}

export const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup';

/**
 * Parse `/proc/self/cgroup` content. Returns the v2 controller path
 * (the `0::` line) or `null` when unavailable (Windows, cgroup v1, no mount).
 */
export function parseProcSelfCgroup(content: string): string | null {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    // cgroup v2 line shape: `0::/path/to/group`; v1 uses `N:name:/path`.
    const marker = line.indexOf('::');
    if (marker === -1) continue;
    const hierarchy = line.slice(0, marker).trim();
    if (hierarchy !== '0') continue;
    const path = line.slice(marker + 2).trim();
    if (path.length === 0) return '/';
    return path.startsWith('/') ? path : `/${path}`;
  }
  return null;
}

/** Parse a `memory.current`/`memory.high` value (bytes). */
export function parseMemoryBytes(content: string): number | null {
  const value = content.trim();
  if (value.length === 0) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Parse `memory.max` — `max` means no limit and yields `null`. */
export function parseMemoryMax(content: string): number | null {
  const value = content.trim();
  if (value === 'max' || value.length === 0) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const MIB = 1024 * 1024;

/**
 * Resolve the v2 controller path for this process and read its memory
 * accounting. Returns `available: false` when the filesystem is absent or
 * unreadable — the governor then falls back to process-level sampling.
 */
export async function readCgroupInfo(
  root = process.env['NEOTA_CGROUP_ROOT'] ?? DEFAULT_CGROUP_ROOT,
): Promise<CgroupInfo> {
  let controllerPath: string | null = null;
  try {
    controllerPath = parseProcSelfCgroup(await readFile('/proc/self/cgroup', 'utf8'));
  } catch {
    return {
      available: false,
      controllerPath: null,
      root,
      memoryCurrentMiB: null,
      memoryMaxMiB: null,
      memoryHighMiB: null,
    };
  }
  if (controllerPath === null) {
    return {
      available: false,
      controllerPath: null,
      root,
      memoryCurrentMiB: null,
      memoryMaxMiB: null,
      memoryHighMiB: null,
    };
  }
  const groupDir = join(root, controllerPath);
  const read = async (name: string): Promise<string | null> => {
    try {
      return await readFile(join(groupDir, name), 'utf8');
    } catch {
      return null;
    }
  };
  const [current, max, high] = await Promise.all([
    read('memory.current'),
    read('memory.max'),
    read('memory.high'),
  ]);
  const memoryCurrentBytes = parseMemoryBytes(current ?? '');
  const memoryHighBytes = parseMemoryBytes(high ?? '');
  const memoryMaxBytes = parseMemoryMax(max ?? '');
  return {
    available: current !== null,
    controllerPath,
    root,
    memoryCurrentMiB: memoryCurrentBytes === null ? null : memoryCurrentBytes / MIB,
    memoryMaxMiB: memoryMaxBytes === null ? null : memoryMaxBytes / MIB,
    memoryHighMiB: memoryHighBytes === null ? null : memoryHighBytes / MIB,
  };
}

/** Linux `/proc` sampling helpers. */

/** `CLK_TCK` on Linux — historically always 100. */
const CLK_TCK = 100;

/**
 * Parse `/proc/<pid>/status` content for the `VmRSS` value (bytes).
 * Returns `null` when the process is gone or the file shape is unexpected.
 */
export function parseVmRss(status: string): number | null {
  for (const line of status.split(/\r?\n/u)) {
    if (line.startsWith('VmRSS:')) {
      const match = /^VmRSS:\s+(\d+)\s+kB$/u.exec(line.trim());
      const value = match?.[1];
      if (value === undefined) return null;
      return Number.parseInt(value, 10) * 1024;
    }
  }
  return null;
}

/**
 * Parse `/proc/<pid>/stat` content for total CPU time (milliseconds).
 * The `comm` field may contain spaces and parentheses, so the split starts
 * after the last `)` — fields after that are space-separated and stable.
 */
export function parseProcStat(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  // rest[0] is field 3 (state); utime is field 14, stime field 15.
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return ((utime + stime) / CLK_TCK) * 1000;
}
