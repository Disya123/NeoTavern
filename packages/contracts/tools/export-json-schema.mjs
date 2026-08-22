#!/usr/bin/env node
/**
 * Exports the UiBlueprint TypeBox schema as a standalone JSON Schema so
 * editors resolve `$schema` hints on authored documents (`pnpm ui:schema`).
 *
 * Usage:
 *   pnpm ui:schema          # write packages/contracts/schemas/ui-blueprint.schema.json
 *   pnpm ui:schema --check  # exit 1 when the file is stale
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const contractsOutput = resolve(
  repositoryRoot,
  'packages/contracts/dist/presentation/blueprint.js',
);
const schemaOutput = resolve(repositoryRoot, 'packages/contracts/schemas/ui-blueprint.schema.json');
const check = process.argv.slice(2).includes('--check');
if (process.argv.slice(2).some((argument) => argument !== '--check')) {
  throw new Error('usage: pnpm ui:schema [--check]');
}

if (!existsSync(contractsOutput)) {
  // On Windows .cmd scripts require cmd.exe; see presentation-codegen.
  const isWin = process.platform === 'win32';
  const args = isWin
    ? ['/c', 'pnpm', '--filter', '@neotavern/contracts', 'build']
    : ['--filter', '@neotavern/contracts', 'build'];
  execFileSync(isWin ? 'cmd.exe' : 'pnpm', args, { cwd: repositoryRoot, stdio: 'inherit' });
}
if (!existsSync(contractsOutput)) {
  throw new Error(`contracts build did not emit ${contractsOutput}`);
}
const contract = await import(`${pathToFileURL(contractsOutput).href}?ui-blueprint-export=1`);

const exported = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: contract.UI_BLUEPRINT_SCHEMA_ID,
  title: 'NeoTavern UiBlueprint document v1',
  description:
    'Renderer-neutral authored UI structure plus optional presentation overrides. See docs/desktop/chat-ui-recipe.md.',
  ...contract.UiBlueprintSchema,
};

const serialized = `${JSON.stringify(exported, null, 2)}\n`;
if (check) {
  const current = existsSync(schemaOutput) ? readFileSync(schemaOutput, 'utf8') : '';
  if (current !== serialized) {
    console.error(`STALE ${schemaOutput} — run \`pnpm ui:schema\`.`);
    process.exitCode = 1;
  } else {
    console.log(`OK ${schemaOutput}`);
  }
} else {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dirname(schemaOutput), { recursive: true });
  const temporary = `${schemaOutput}.tmp-${process.pid}`;
  writeFileSync(temporary, serialized, 'utf8');
  renameSync(temporary, schemaOutput);
  console.log(`WROTE ${schemaOutput}`);
}
