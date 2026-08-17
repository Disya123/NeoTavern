#!/usr/bin/env node
/**
 * Completeness check for an AGI `gapit commands` dump. Not D1a PASS. Not D1b.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyCaptureDump } from './m0-d1a-capture-host.mjs';

function main() {
  const idx = process.argv.indexOf('--commands');
  const path = idx >= 0 ? process.argv[idx + 1] : process.argv[2];
  if (!path) {
    console.error('usage: node scripts/m0-d1a-capture-check.mjs --commands TRACE-commands.txt');
    process.exit(2);
  }
  const dump = readFileSync(path, 'utf8');
  const result = classifyCaptureDump(dump);
  process.stdout.write(
    `${JSON.stringify({ ...result, path: resolve(path), note: 'not a D1a PASS' }, null, 2)}\n`,
  );
  process.exit(result.ok ? 0 : 4);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
