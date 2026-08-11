/** Migration descriptor. `up` is raw SQL executed inside a transaction. */
export interface Migration {
  /** Monotonically increasing version. Applied in ascending order, once each. */
  version: number;
  /** Human-readable name (e.g. "0000_init"). */
  name: string;
  /** SQL to apply. May contain multiple statements (including triggers). */
  up: string;
}
