#!/usr/bin/env node
/**
 * Generates the Rust decoder for the portable UiBlueprint document from the
 * TypeBox schema in @neotavern/contracts. The TypeBox schema is the only
 * authored definition of this cross-language document; this tool never
 * accepts hand-maintained Rust field lists.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const contractsOutput = resolve(
  repositoryRoot,
  'packages/contracts/dist/presentation/blueprint.js',
);
const rustOutput = resolve(
  repositoryRoot,
  'crates/presentation-blueprint/src/generated/ui_blueprint_v1.rs',
);
const check = process.argv.slice(2).includes('--check');
if (process.argv.slice(2).some((argument) => argument !== '--check')) {
  throw new Error('usage: node tools/presentation-codegen/codegen.mjs [--check]');
}

// On Windows .cmd scripts require cmd.exe; using `cmd.exe /c` avoids the
// DEP0190 shell-args warning that `shell: true` triggers.
const isWin = process.platform === 'win32';
const pnpmArgs = ['--filter', '@neotavern/contracts', 'build'];
execFileSync(isWin ? 'cmd.exe' : 'pnpm', isWin ? ['/c', 'pnpm', ...pnpmArgs] : pnpmArgs, {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
if (!existsSync(contractsOutput)) {
  throw new Error(`contracts build did not emit ${contractsOutput}`);
}

const contract = await import(`${pathToFileURL(contractsOutput).href}?ui-blueprint-codegen=1`);
const generated = emitModule(contract.UiBlueprintSchema);

if (check) {
  const current = existsSync(rustOutput) ? readFileSync(rustOutput, 'utf8') : '';
  if (current !== generated) {
    process.stderr.write(`DIFF ${rustOutput}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`OK ${rustOutput}\n`);
  }
} else {
  mkdirSync(dirname(rustOutput), { recursive: true });
  const temporary = `${rustOutput}.tmp-${process.pid}`;
  writeFileSync(temporary, generated, 'utf8');
  renameSync(temporary, rustOutput);
  process.stdout.write(`WROTE ${rustOutput}\n`);
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} value */
function pascal(value) {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

/** @param {string} value */
function snake(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** @param {string} value */
function singular(value) {
  return value.endsWith('ies')
    ? `${value.slice(0, -3)}y`
    : value.endsWith('s')
      ? value.slice(0, -1)
      : value;
}

/** @param {string} value */
function rustString(value) {
  return JSON.stringify(value);
}

/** @param {string} typeName */
function childTypeName(typeName, property, item = false) {
  const base = typeName.endsWith('V1') ? typeName.slice(0, -2) : typeName;
  return `${base}${pascal(item ? singular(property) : property)}V1`;
}

/** @param {string} value */
function typeNameForId(value) {
  return `${pascal(value)}Document`;
}

/** @param {unknown} root */
function emitModule(root) {
  if (!isRecord(root)) throw new Error('UiBlueprintSchema must be a JSON-schema object');

  /** @type {Map<string, Record<string, unknown>>} */
  const definitions = new Map();
  /** @param {unknown} schema */
  const collectDefinitions = (schema) => {
    if (!isRecord(schema)) return;
    if (typeof schema.$id === 'string') definitions.set(schema.$id, schema);
    if (isRecord(schema.properties)) {
      for (const property of Object.values(schema.properties)) collectDefinitions(property);
    }
    if (isRecord(schema.items)) collectDefinitions(schema.items);
    if (Array.isArray(schema.anyOf)) {
      for (const member of schema.anyOf) collectDefinitions(member);
    }
  };
  collectDefinitions(root);

  /** @type {string[]} */
  const declarations = [];
  /** @type {Map<string, string>} */
  const emittedNames = new Map();
  /** @type {Set<string>} */
  const inProgress = new Set();

  /** @param {Record<string, unknown>} schema @param {string} suggestedName */
  const emitType = (schema, suggestedName) => {
    if (typeof schema.$ref === 'string') {
      const definition = definitions.get(schema.$ref);
      if (!definition) throw new Error(`unknown UiBlueprint $ref: ${schema.$ref}`);
      return emitType(definition, typeNameForId(schema.$ref));
    }
    const typeName = typeof schema.$id === 'string' ? typeNameForId(schema.$id) : suggestedName;
    const type = typeof schema.type === 'string' ? schema.type : undefined;
    if (typeof schema.const === 'string') {
      emitStringConstant(typeName, schema.const);
      return typeName;
    }
    if (Array.isArray(schema.anyOf)) {
      const allConst = schema.anyOf.every(
        (member) => isRecord(member) && typeof member.const === 'string',
      );
      if (allConst) {
        emitStringEnum(typeName, schema.anyOf);
        return typeName;
      }
      // Mixed union (closed builtin ids + the `custom.*` pattern member):
      // decodes as a plain string; membership is re-checked by the
      // materializer against the builtin table, so authoring mistakes stay
      // loud at scene level instead of at parse time.
      return 'String';
    }
    switch (type) {
      case 'string':
        return 'String';
      case 'integer':
        return 'i64';
      case 'number':
        return 'f64';
      case 'boolean':
        return 'bool';
      case 'array': {
        if (!isRecord(schema.items)) throw new Error(`array ${typeName} has no schema items`);
        return `Vec<${emitType(schema.items, childTypeName(typeName, 'item', true))}>`;
      }
      case 'object':
        emitObject(typeName, schema);
        return typeName;
      default:
        throw new Error(`unsupported UiBlueprint schema at ${typeName}`);
    }
  };

  /** @param {string} typeName @param {string} value */
  const emitStringConstant = (typeName, value) => {
    if (emittedNames.has(typeName)) return;
    emittedNames.set(typeName, 'enum');
    const variant = pascal(value) || 'Value';
    declarations.push(
      '#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]',
      `pub enum ${typeName} {`,
      `    #[serde(rename = ${rustString(value)})]`,
      `    ${variant},`,
      '}',
      '',
    );
  };

  /** @param {string} typeName @param {unknown[]} members */
  const emitStringEnum = (typeName, members) => {
    if (emittedNames.has(typeName)) return;
    const values = members.map((member) => {
      if (!isRecord(member) || typeof member.const !== 'string' || member.type !== 'string') {
        throw new Error(`unsupported UiBlueprint union at ${typeName}`);
      }
      return member.const;
    });
    emittedNames.set(typeName, 'enum');
    declarations.push('#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]');
    declarations.push(`pub enum ${typeName} {`);
    for (const value of values) {
      declarations.push(`    #[serde(rename = ${rustString(value)})]`);
      declarations.push(`    ${pascal(value) || 'Value'},`);
    }
    declarations.push('}', '');
  };

  /** @param {string} typeName @param {Record<string, unknown>} schema */
  const emitObject = (typeName, schema) => {
    if (emittedNames.has(typeName) || inProgress.has(typeName)) return;
    inProgress.add(typeName);
    emittedNames.set(typeName, 'struct');
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    /** @type {{name:string, schema:Record<string, unknown>, required:boolean}[]} */
    const fields = [];
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (!isRecord(propertySchema)) throw new Error(`invalid property ${property} on ${typeName}`);
      fields.push({ name: property, schema: propertySchema, required: required.has(property) });
    }
    for (const field of fields) {
      emitType(field.schema, childTypeName(typeName, field.name));
    }
    declarations.push('#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]');
    if (schema.additionalProperties === false) declarations.push('#[serde(deny_unknown_fields)]');
    declarations.push(`pub struct ${typeName} {`);
    for (const field of fields) {
      const fieldType = emitType(field.schema, childTypeName(typeName, field.name));
      const rustField = snake(field.name);
      if (rustField !== field.name)
        declarations.push(`    #[serde(rename = ${rustString(field.name)})]`);
      if (!field.required) {
        declarations.push('    #[serde(default, skip_serializing_if = "Option::is_none")]');
      }
      declarations.push(
        `    pub ${rustField}: ${field.required ? fieldType : `Option<${fieldType}>`},`,
      );
    }
    declarations.push('}', '');
    inProgress.delete(typeName);
  };

  emitObject('UiBlueprintDocumentV1', root);
  return [
    '// @generated by tools/presentation-codegen/codegen.mjs — DO NOT EDIT.',
    'use serde::{Deserialize, Serialize};',
    '',
    ...declarations,
  ].join('\n');
}
