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
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = resolve(REPO_ROOT, 'docs');
const TARGET_ROOT = resolve(REPO_ROOT, 'apps/docs/docs/architecture');
const MANIFEST_NAME = '.sync-manifest.json';
const GITHUB_ORG_REPO = 'Disya123/NeoTavern';
const GITHUB_EDIT = `https://github.com/${GITHUB_ORG_REPO}/edit/main/`;
const GITHUB_BLOB = `https://github.com/${GITHUB_ORG_REPO}/blob/main/`;
const SIDEBAR_LABEL = 'Architecture (canonical repo docs)';

const SITE_DOCS_ROOT = resolve(REPO_ROOT, 'apps/docs/docs');
if (resolve(dirname(TARGET_ROOT)) !== SITE_DOCS_ROOT) {
  throw new Error('docs-sync: target layout assumption changed');
}

/** Walk `docs/` and return source-relative POSIX paths of every .md file. */
async function collectMarkdown() {
  const out = [];
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.build') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(relative(SOURCE_ROOT, full).split('\\').join('/'));
      }
    }
  };
  await walk(SOURCE_ROOT);
  return out;
}

const LINK_RE = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;

/** Rewrite targets that escape `docs/` (or point at non-doc files) to GitHub
 * blob URLs; keep in-tree .md links relative. Docusaurus treats every link
 * target as a doc route, so a raw file (exceptions.json, images, ...) must
 * be an absolute URL, not a relative path. */
function rewriteEscapingLinks(sourceRel, content) {
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
async function buildMirror() {
  const files = await collectMarkdown();
  const entries = [];
  for (const source of files) {
    let content = await readFile(join(SOURCE_ROOT, source), 'utf8');
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

function manifest(entries) {
  const files = entries.map(({ source, target, content }) => ({
    source,
    target,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  }));
  return `${JSON.stringify({ formatVersion: 1, source: 'docs', files }, null, 2)}\n`;
}

async function writeMirror(entries) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(TARGET_ROOT, { recursive: true });
  for (const entry of entries) {
    const targetPath = join(TARGET_ROOT, entry.target);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, entry.content, 'utf8');
  }
  await writeFile(join(TARGET_ROOT, MANIFEST_NAME), manifest(entries), 'utf8');
  console.log(
    `[docs:sync] wrote ${entries.length} page(s) + ${MANIFEST_NAME} to apps/docs/docs/architecture/`,
  );
}

async function checkMirror(entries) {
  const { mkdtemp, readFile: read, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const tmp = await mkdtemp(join(tmpdir(), 'neota-docs-sync-'));
  const diffs = [];
  try {
    const expected = new Map(entries.map((e) => [e.target, e.content]));
    const expectedManifest = manifest(entries);
    const committedManifest = await read(join(TARGET_ROOT, MANIFEST_NAME), 'utf8').catch(
      () => null,
    );
    if (committedManifest !== expectedManifest) diffs.push(MANIFEST_NAME);
    const committedTargets = new Set(
      committedManifest ? JSON.parse(committedManifest).files.map((f) => f.target) : [],
    );
    for (const target of committedTargets) {
      if (!expected.has(target)) {
        diffs.push(`${target} (stale — not produced by a fresh sync)`);
      }
    }
    for (const [target, content] of expected) {
      const committed = await read(join(TARGET_ROOT, target), 'utf8').catch(() => null);
      if (committed !== content) diffs.push(target);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  if (diffs.length > 0) {
    console.error(`[docs:sync] FAIL — mirror is out of date (${diffs.length} file(s)):`);
    for (const d of diffs.sort()) console.error(`  ${d}`);
    console.error(
      '[docs:sync] Run `node scripts/docs-sync.mjs` (pnpm docs:sync) and commit the mirror together with the docs/ change.',
    );
    process.exit(1);
  }
  console.log(
    `[docs:sync] OK — ${entries.length} page(s) match the committed mirror byte-for-byte.`,
  );
}

const check = process.argv.includes('--check');
const entries = await buildMirror();
if (check) {
  await checkMirror(entries);
} else {
  await writeMirror(entries);
}
