#!/usr/bin/env node
/**
 * Deterministic docs sync — the single-source-tree mechanism for the docs
 * site (ТЗ 10/10 rev2 §19.1 "CI-DOCS"; AGENTS.md §27 "Do not copy one
 * contract into several places").
 *
 * The repository's canonical documentation tree is `docs/`. The Docusaurus
 * site must not be edited as a second copy of it: `docs/` is mirrored into
 * `apps/docs/docs/architecture/` by this script only.
 *
 * - `node scripts/docs-sync.mjs`        — write the mirror.
 * - `node scripts/docs-sync.mjs --check`— verify the committed mirror matches
 *   a fresh sync byte-for-byte; exit 1 on any divergence (CI gate).
 *
 * The mirror is a CLOSED tree: `--check` enumerates the actual files of the
 * target directory (not just the committed manifest) and fails on any file a
 * fresh sync would not produce, and a plain sync deletes stale generated
 * files. A page smuggled into `apps/docs/docs/architecture/` cannot survive
 * either mode.
 *
 * Transformations applied to every mirrored page:
 * 1. Relative links that ESCAPE the `docs/` tree (e.g. `../CHANGELOG.md`,
 *    `../../NeoTavern_architecture_10_of_10_spec_2026-08-13.md`) are
 *    rewritten to stable GitHub `blob/main/...` URLs — inside the mirror
 *    those targets would not resolve.
 * 2. An `editUrl` front-matter line is injected so "Edit this page" on the
 *    site points at the CANONICAL `docs/` file, never at the mirror.
 * 3. The mirror index page carries a `sidebar_label` matching the section.
 *
 * The output is fully deterministic (no timestamps in the manifest), so
 * `--check` never fails on regeneration noise.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = resolve(REPO_ROOT, 'docs');
const TARGET_ROOT = resolve(REPO_ROOT, 'apps/docs/docs/architecture');
const MANIFEST_NAME = '.sync-manifest.json';
const GITHUB_ORG_REPO = 'Disya123/NeoTavern';
const GITHUB_EDIT = `https://github.com/${GITHUB_ORG_REPO}/edit/main/`;
const GITHUB_BLOB = `https://github.com/${GITHUB_ORG_REPO}/blob/main/`;
const SIDEBAR_LABEL = 'Architecture (canonical repo docs)';

/** Walk `dir` and return dir-relative POSIX paths of every file (recursive). */
async function walkFiles(dir) {
  const out = [];
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.build') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(relative(dir, full).split('\\').join('/'));
      }
    }
  };
  await walk(dir);
  return out;
}

/** Walk `docs/` and return source-relative POSIX paths of every .md file. */
export async function collectMarkdown(sourceRoot = SOURCE_ROOT) {
  const files = await walkFiles(sourceRoot);
  return files.filter((f) => f.endsWith('.md'));
}

const LINK_RE = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;

/** Rewrite targets that escape `docs/` (or point at non-doc files) to GitHub
 * blob URLs; keep in-tree .md links relative. Docusaurus treats every link
 * target as a doc route, so a raw file (exceptions.json, images, ...) must
 * be an absolute URL, not a relative path. */
export function rewriteEscapingLinks(sourceRel, content) {
  const baseDir = posix.dirname(sourceRel);
  return content.replace(LINK_RE, (_all, prefix, target, suffix) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) {
      return `${prefix}${target}${suffix}`;
    }
    const resolved = posix.normalize(posix.join(baseDir, target));
    const isMarkdown = target.split(/[?#]/, 1)[0].endsWith('.md');
    if (resolved.startsWith('../') || !isMarkdown) {
      // Escaping link: `../CHANGELOG.md` → repo-root-relative. In-tree
      // non-doc link: `architecture/exceptions.json` is docs-root-relative.
      const fromRoot = resolved.startsWith('../') ? resolved.slice(3) : `docs/${resolved}`;
      return `${prefix}${GITHUB_BLOB}${fromRoot}${suffix}`;
    }
    return `${prefix}${target}${suffix}`;
  });
}

/** Build the full mirrored file set: [{ source, target, content }]. */
export async function buildMirror(sourceRoot = SOURCE_ROOT) {
  const files = await collectMarkdown(sourceRoot);
  const entries = [];
  for (const source of files) {
    let content = await readFile(join(sourceRoot, source), 'utf8');
    content = rewriteEscapingLinks(source, content);
    const frontMatter = ['---', `editUrl: ${GITHUB_EDIT}docs/${source}`, '---', '', ''].join('\n');
    entries.push({
      source,
      target: source,
      content: `${frontMatter}${content}`,
    });
  }
  // Docusaurus category metadata for the mirror root: the sidebar section
  // label (docs/README.md is the folder index, not the category label).
  entries.push({
    source: '_category_.json',
    target: '_category_.json',
    content: `${JSON.stringify({ label: SIDEBAR_LABEL }, null, 2)}\n`,
  });
  return entries;
}

export function manifest(entries) {
  const files = entries.map(({ source, target, content }) => ({
    source,
    target,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  }));
  return `${JSON.stringify({ formatVersion: 1, source: 'docs', files }, null, 2)}\n`;
}

/** The set of files a fresh sync is allowed to own in the target tree:
 * every produced entry plus the manifest itself. */
export function expectedTargetSet(entries) {
  return new Set([...entries.map((e) => e.target), MANIFEST_NAME]);
}

/**
 * Write the mirror into `targetRoot` and DELETE stale files: anything
 * currently in the target tree that a fresh sync does not produce (a
 * smuggled page, an orphaned old mirror file) is removed, so `docs/` is the
 * single source of truth in both directions.
 */
export async function writeMirror(entries, targetRoot = TARGET_ROOT) {
  await mkdir(targetRoot, { recursive: true });
  for (const entry of entries) {
    const targetPath = join(targetRoot, entry.target);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, entry.content, 'utf8');
  }
  await writeFile(join(targetRoot, MANIFEST_NAME), manifest(entries), 'utf8');

  const expected = expectedTargetSet(entries);
  const actual = await walkFiles(targetRoot);
  const stale = actual.filter((f) => !expected.has(f));
  for (const f of stale) {
    await rm(join(targetRoot, f), { force: true });
    console.log(`[docs:sync] removed stale ${f}`);
  }
  // Prune directories the stale removal emptied (deepest first, never the
  // target root itself).
  const dirs = stale
    .map((f) => posix.dirname(f))
    .filter((d) => d !== '.')
    .sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    await rm(join(targetRoot, d), { recursive: true, force: true }).catch(() => {});
  }
  console.log(
    `[docs:sync] wrote ${entries.length} file(s) + ${MANIFEST_NAME} to apps/docs/docs/architecture/`,
  );
}

/**
 * Verify the committed mirror byte-for-byte against a fresh sync. Returns a
 * list of divergence descriptions (empty = up to date). Failures include:
 *  - the manifest differs or is missing;
 *  - a committed file differs from the fresh content (or is missing);
 *  - the committed manifest lists a stale target a fresh sync would not produce;
 *  - ANY file physically present in the target tree is outside the expected
 *    set (a rogue page can reach Docusaurus even though it is not in the
 *    manifest — the target directory is enumerated, not just the manifest).
 */
export async function checkMirror(entries, targetRoot = TARGET_ROOT) {
  const diffs = [];
  const expected = new Map(entries.map((e) => [e.target, e.content]));
  const expectedManifest = manifest(entries);
  const committedManifest = await readFile(join(targetRoot, MANIFEST_NAME), 'utf8').catch(
    () => null,
  );
  if (committedManifest !== expectedManifest) diffs.push(`${MANIFEST_NAME} (manifest differs)`);

  // Enumerate the ACTUAL target tree: a rogue file that is not in the
  // committed manifest still ships to the site, so it must fail the gate.
  let actual = [];
  try {
    actual = await walkFiles(targetRoot);
  } catch {
    actual = [];
  }
  const allowed = expectedTargetSet(entries);
  const rogue = actual.filter((f) => !allowed.has(f));
  for (const f of rogue.sort()) {
    diffs.push(`${f} (not produced by a fresh sync — delete it or move it to docs/)`);
  }

  const committedTargets = new Set(
    committedManifest ? JSON.parse(committedManifest).files.map((f) => f.target) : [],
  );
  for (const target of committedTargets) {
    if (!expected.has(target)) {
      diffs.push(`${target} (stale — listed in the manifest but not produced by a fresh sync)`);
    }
  }
  for (const [target, content] of expected) {
    const committed = await readFile(join(targetRoot, target), 'utf8').catch(() => null);
    if (committed !== content) diffs.push(target);
  }
  return diffs;
}

async function main() {
  const check = process.argv.includes('--check');
  // The layout guard: the mirror must live directly under the Docusaurus
  // content root; the script refuses to run if the repo layout moved.
  const siteDocsRoot = resolve(REPO_ROOT, 'apps/docs/docs');
  if (resolve(dirname(TARGET_ROOT)) !== siteDocsRoot) {
    throw new Error('docs-sync: target layout assumption changed');
  }
  const entries = await buildMirror();
  if (check) {
    const diffs = await checkMirror(entries);
    if (diffs.length > 0) {
      console.error(`[docs:sync] FAIL — mirror is out of date (${diffs.length} file(s)):`);
      for (const d of diffs.sort()) console.error(`  ${d}`);
      console.error(
        '[docs:sync] Run `node scripts/docs-sync.mjs` (pnpm docs:sync) and commit the mirror together with the docs/ change.',
      );
      process.exit(1);
    }
    console.log(
      `[docs:sync] OK — ${entries.length} file(s) match the committed mirror byte-for-byte; target tree contains no unexpected files.`,
    );
  } else {
    await writeMirror(entries);
  }
}

// CLI entry: run only when executed directly, so the functions above stay
// importable by tests (scripts/docs-sync.test.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[docs:sync] ${err.message}`);
    process.exit(1);
  });
}
