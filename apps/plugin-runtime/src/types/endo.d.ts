/**
 * Ambient type for `@endo/module-source` (v1.4.1 ships no .d.ts).
 *
 * The package exports a single `ModuleSource` class: it parses/transforms an
 * ES module into a SES-compilable program (via Babel), validating syntax and
 * exposing the static import/export lists. The second argument is the stable
 * virtual location used for stack traces (§8.8, §40.1.2).
 */
declare module '@endo/module-source' {
  export interface ModuleSourceRecord {
    readonly imports: string[];
    readonly exports: string[];
    readonly reexports: string[];
    readonly needsImport: boolean;
    readonly needsImportMeta: boolean;
  }

  export class ModuleSource {
    constructor(source: string, location?: string, options?: { format?: 'json' });
    readonly imports: string[];
    readonly exports: string[];
    readonly reexports: string[];
  }
}
