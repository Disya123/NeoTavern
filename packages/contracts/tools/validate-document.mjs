#!/usr/bin/env node
/**
 * Validate authored UiBlueprint document JSON files against the TypeBox
 * schema (`packages/contracts/src/presentation/blueprint.ts`).
 *
 * Lives inside `packages/contracts` on purpose: `@sinclair/typebox` resolves
 * from this package's own node_modules, and the compiled schema is imported
 * from the package dist.
 *
 * Usage:
 *   pnpm blueprint:validate <document.json> [more.json ...]
 *
 * Exit codes: 0 — every file valid; 1 — at least one invalid/unreadable.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Value } from '@sinclair/typebox/value';
import {
  SUPPORTED_CAPTURE_STYLE_PROPERTIES,
  UI_BLUEPRINT_FORMAT_V1,
  UI_ICON_IDS,
  UiBlueprintSchema,
} from '../dist/presentation/blueprint.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--help' && arg !== '-h');
if (args.length === 0 || args.some((arg) => arg.startsWith('-'))) {
  console.error('usage: pnpm blueprint:validate <document.json> [more.json ...]');
  process.exit(2);
}

/**
 * Flattens the first-party i18n resources (en) into a `chat.send`-style key
 * set so documents referencing missing keys are flagged before a host runs.
 */
function knownI18nKeys() {
  const keys = new Set();
  const resourcesDir = resolve(import.meta.dirname, '..', '..', 'i18n', 'src', 'resources');
  let source;
  try {
    source = readdirSync(resourcesDir).includes('en.ts')
      ? readFileSync(resolve(resourcesDir, 'en.ts'), 'utf8')
      : '';
  } catch {
    return keys;
  }
  // Namespace blocks look like `  chat: {` and close at the next `  },`.
  const keyPattern = /^ {4}([A-Za-z0-9_]+):/gm;
  const namespaces = [...source.matchAll(/^ {2}([A-Za-z0-9_]+): \{$/gm)].map((match) => match[1]);
  for (const namespace of namespaces) {
    const block = source.slice(source.indexOf(`${namespace}: {`));
    const rest = block.slice(block.indexOf('\n') + 1);
    const end = rest.search(/^ {2}\},?$/m);
    const body = end === -1 ? rest : rest.slice(0, end);
    for (const match of body.matchAll(keyPattern)) {
      keys.add(`${namespace}.${match[1]}`);
    }
  }
  return keys;
}

/** Collects presentation overrides from the document tree. */
function collectOverrides(node, found) {
  if (node.label?.i18nKey) found.i18nKeys.add(node.label.i18nKey);
  if (node.icon) found.icons.add(node.icon);
  for (const reference of node.styleRefs ?? []) found.properties.push(reference.property);
  for (const child of node.children ?? []) collectOverrides(child, found);
}

function warn(message) {
  console.error(`  warn: ${message}`);
}

let failures = 0;
const i18nKeys = knownI18nKeys();
const iconIds = new Set(UI_ICON_IDS);
const styleProperties = new Set(SUPPORTED_CAPTURE_STYLE_PROPERTIES);
for (const path of args.map((arg) => resolve(arg))) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`[blueprint-validate] ${path}: unreadable (${error.message})`);
    failures += 1;
    continue;
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    console.error(`[blueprint-validate] ${path}: invalid JSON (${error.message})`);
    failures += 1;
    continue;
  }
  if (Value.Check(UiBlueprintSchema, document)) {
    const id = typeof document.id === 'string' ? document.id : '?';
    console.log(`[blueprint-validate] ${path}: OK (id=${id})`);
    if (document.format !== UI_BLUEPRINT_FORMAT_V1) {
      warn(`unknown format ${document.format}`);
    }
    const found = { i18nKeys: new Set(), icons: new Set(), properties: [] };
    collectOverrides(document.root ?? {}, found);
    for (const key of found.i18nKeys) {
      if (i18nKeys.size > 0 && !i18nKeys.has(key)) {
        warn(`i18n key "${key}" is not in packages/i18n resources (en)`);
      }
    }
    for (const icon of found.icons) {
      if (!iconIds.has(icon)) warn(`icon "${icon}" is not in the closed UI_ICON_IDS registry`);
    }
    for (const property of found.properties) {
      if (!styleProperties.has(property)) {
        warn(`style property "${property}" is outside SUPPORTED_CAPTURE_STYLE_PROPERTIES`);
      }
    }
    continue;
  }
  failures += 1;
  console.error(`[blueprint-validate] ${path}: INVALID`);
  for (const error of Value.Errors(UiBlueprintSchema, document)) {
    console.error(`  ${error.path || '/'}: ${error.message}`);
  }
}

if (failures > 0) {
  console.error(`[blueprint-validate] ${failures} file(s) failed.`);
  process.exit(1);
}
