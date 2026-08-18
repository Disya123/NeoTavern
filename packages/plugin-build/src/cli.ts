/**
 * `neotavern-plugin` CLI (ТЗ Plugin SDK vNext v3.2 §51/§52/§36, Stage H).
 *
 * Subcommands:
 *   analyze <dir> [--json]      vNext-readiness report (§51/§52)
 *   build <dir> [--key <pem>]   zero-build package + optional signing (§8, §36)
 *   sign <manifest.json> <pem>  sign a manifest (Ed25519, §36)
 *   verify <manifest.json> [--key <pem>]   verify a manifest signature
 *   genkey [--out <pem>]        generate an Ed25519 key pair (§36)
 *
 * Exit codes: 0 ok, 1 analysis/build/verify failure, 2 usage error.
 * Errors are printed to stderr; `--json` prints only the machine-readable
 * payload to stdout.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzePackage } from './analyze.js';
import { buildPackage } from './build.js';
import { runBuildGate } from './sesGate.js';
import { generateKeyPair, signManifest, verifyManifestSignature } from './signing.js';
import type { PluginManifest } from '@neotavern/plugin-sdk';

function usage(): string {
  return [
    'usage: neotavern-plugin <analyze|build|sign|verify|genkey> [args]',
    '',
    '  analyze <dir> [--json]',
    '    Static vNext-readiness report (Node builtins, platform payloads,',
    '    install scripts, dynamic imports, WASM, suggested capabilities).',
    '  build <dir> [--key <private.pem>] [--out <dir>] [--force] [--ses-gate]',
    '    Zero-build packaging: plain JS copied, TS transpiled, hard gates',
    '    enforced; writes dist/backend/artifact.json (signed when --key).',
    '    --ses-gate imports the graph in a real Worker + lockdown +',
    '    Compartment (§6.5/§8.10) and fails the build on incompatibility.',
    '  sign <manifest.json> <private.pem>',
    '    Sign a manifest; prints the signed JSON to stdout.',
    '  verify <manifest.json> [--key <public.pem>]',
    '    Verify the manifest signature; exit 1 on failure.',
    '  genkey [--out <base>]',
    '    Generate an Ed25519 pair (base.pub.pem / base.priv.pem).',
  ].join('\n');
}

async function loadManifest(path: string): Promise<PluginManifest> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('manifest must be a JSON object');
  }
  // `dist/backend/artifact.json` wraps the manifest; unwrap transparently so
  // sign/verify work on both the bare manifest and the built artifact.
  const record = raw as Record<string, unknown>;
  if (typeof record['manifest'] === 'object' && record['manifest'] !== null) {
    return record['manifest'] as PluginManifest;
  }
  return raw as PluginManifest;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'analyze': {
      const dir = rest[0];
      const json = rest.includes('--json');
      if (dir === undefined) throw usageError('analyze requires a directory');
      const report = await analyzePackage(dir);
      if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`analysis of ${dir}\n`);
        process.stdout.write(
          `  files: ${report.stats.files} (${report.stats.jsFiles} js, ${report.stats.wasmFiles} wasm, ${report.stats.bytes} bytes)\n`,
        );
        process.stdout.write(
          `  compatible: ${report.compatible ? 'yes' : 'NO — hard gate violations'}\n`,
        );
        for (const issue of report.issues) {
          process.stdout.write(
            `  [${issue.level}] ${issue.code} ${issue.file}: ${issue.message}\n`,
          );
          if (issue.suggestion !== undefined) {
            process.stdout.write(`      → ${issue.suggestion}\n`);
          }
        }
        if (report.capabilities.length > 0) {
          process.stdout.write('  suggested capabilities:\n');
          for (const suggestion of report.capabilities) {
            process.stdout.write(`    - ${suggestion.capability}: ${suggestion.reason}\n`);
          }
        }
      }
      return report.compatible ? 0 : 1;
    }
    case 'build': {
      const dir = rest[0];
      if (dir === undefined) throw usageError('build requires a directory');
      const keyIdx = rest.indexOf('--key');
      const outIdx = rest.indexOf('--out');
      const privateKeyPem =
        keyIdx >= 0 ? await readFile(rest[keyIdx + 1] ?? '', 'utf8') : undefined;
      const outDir = outIdx >= 0 ? rest[outIdx + 1] : undefined;
      const artifact = await buildPackage(dir, {
        privateKeyPem,
        outDir,
        force: rest.includes('--force'),
      });
      process.stdout.write(
        `built ${dir}: ${Object.keys(artifact.fileDigests).length} files, ` +
          `sourceDigest ${artifact.sourceDigest.slice(0, 16)}…, ` +
          `${'signature' in artifact.manifest ? 'signed' : 'unsigned'}\n`,
      );
      if (artifact.warnings.length > 0) {
        process.stdout.write(`  ${artifact.warnings.length} warning(s), e.g.:\n`);
        for (const warning of artifact.warnings.slice(0, 5)) {
          process.stdout.write(`    - ${warning}\n`);
        }
      }
      if (rest.includes('--ses-gate')) {
        // §6.5/§8.10: import the graph under the production boundary.
        const { outcome } = await runBuildGate(dir);
        if (!outcome.ok) {
          process.stderr.write(
            `ses-gate FAILED: ${outcome.code ?? 'MODULE_EVALUATION_FAILED'}: ${outcome.message ?? ''}\n`,
          );
          return 1;
        }
        process.stdout.write(
          `ses-gate ok: ${outcome.exportNames.length} export(s) imported under Worker + lockdown + Compartment\n`,
        );
      }
      return 0;
    }
    case 'sign': {
      const manifestPath = rest[0];
      const keyPath = rest[1];
      if (manifestPath === undefined || keyPath === undefined) {
        throw usageError('sign requires <manifest.json> <private.pem>');
      }
      const manifest = await loadManifest(manifestPath);
      const privateKeyPem = await readFile(keyPath, 'utf8');
      const signed = signManifest(manifest, privateKeyPem);
      process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
      return 0;
    }
    case 'verify': {
      const manifestPath = rest[0];
      if (manifestPath === undefined) throw usageError('verify requires <manifest.json>');
      const keyIdx = rest.indexOf('--key');
      const publicKeyPem = keyIdx >= 0 ? await readFile(rest[keyIdx + 1] ?? '', 'utf8') : undefined;
      const manifest = await loadManifest(manifestPath);
      const result = verifyManifestSignature(manifest, publicKeyPem);
      if (!result.ok) {
        process.stderr.write(`${result.reason}\n`);
        return 1;
      }
      process.stdout.write('signature ok\n');
      return 0;
    }
    case 'genkey': {
      const outIdx = rest.indexOf('--out');
      const base =
        outIdx >= 0 ? (rest[outIdx + 1] ?? 'neotavern-plugin-key') : 'neotavern-plugin-key';
      const pair = generateKeyPair();
      await writeFile(join(process.cwd(), `${base}.priv.pem`), `${pair.privateKeyPem}\n`, 'utf8');
      await writeFile(join(process.cwd(), `${base}.pub.pem`), `${pair.publicKeyPem}\n`, 'utf8');
      process.stdout.write(`wrote ${base}.priv.pem / ${base}.pub.pem (keyId ${pair.keyId})\n`);
      return 0;
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${usage()}\n`);
      return 0;
    default:
      process.stdout.write(`${usage()}\n`);
      return 2;
  }
}

function usageError(message: string): Error {
  const error = new Error(message);
  error.name = 'UsageError';
  return error;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('cli.js')) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `neotavern-plugin: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = error instanceof Error && error.name === 'UsageError' ? 2 : 1;
    });
}

export { main };
