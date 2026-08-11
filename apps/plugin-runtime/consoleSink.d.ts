// Type declarations for the trusted console-sink module (worker bootstrap
// TCB, §9.1.1/§9.1.2). The implementation is plain ESM consumed by
// `worker-bootstrap.mjs` before lockdown; these types exist only so vitest
// can exercise the pure pieces directly.

export interface BoundedFormatterLimits {
  maxDepth: number;
  maxKeys: number;
  maxItems: number;
  maxStringBytes: number;
  maxRecordBytes: number;
  maxStackFrames: number;
  maxVisits: number;
}

export type ConsoleLevel = 'debug' | 'log' | 'info' | 'warn' | 'error' | 'trace';

export interface LogRecord {
  level: ConsoleLevel;
  message: string;
  at: number;
  count?: number;
}

export interface LogRing {
  push(level: ConsoleLevel, message: string, at: number): void;
  drain(maxRecords: number, maxBytes: number): Array<LogRecord>;
  countDropped(additional: number): void;
  readonly dropped: number;
  readonly size: number;
  readonly bytesUsed: number;
}

export function makeBoundedFormatter(limits: BoundedFormatterLimits): (args: unknown[]) => string;

export interface ErrorIdentity {
  name: string;
  message: string;
  stack: string | null;
}

/** Side-table-aware error identity extraction (§9.1.3). */
export function errorIdentity(value: unknown): ErrorIdentity;

export function makeLogRing(maxBytes: number, recordOverheadBytes: number): LogRing;

export interface LogCredits {
  canFlush(): boolean;
  consume(): void;
  replenish(): void;
  readonly available: number;
}

export function makeLogCredits(initial: number, max: number): LogCredits;
