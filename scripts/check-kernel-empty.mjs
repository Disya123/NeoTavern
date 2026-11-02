/**
 * Kernel-plane "no silent fallbacks" gate (release-gate item 4, ARC-02).
 *
 * Rule: an `if (isKernelMode()) { … }` branch either DOES something (it calls
 * the wire/facade, or throws a typed `UnsupportedError`), or it fabricates an
 * empty/neutral value. The second kind is allowed only when it is (a) honest
 * about the missing capability and (b) registered in the source with a
 * colocated marker:
 *
 *     if (isKernelMode()) {
 *       // kernel-empty: <why this empty value is the truth, not a hiding place>
 *       return null;
 *     }
 *
 * The marker is the registration: it cannot drift into another file, and a new
 * empty branch has to state its reason at the place a reviewer reads. Call-free
 * branches without the marker fail `--check`.
 *
 * Classification is AST-based (TypeScript compiler API), because a text
 * lookahead cannot tell a branch that calls `backend.x()` from one that returns
 * a fabricated object, and it misreads `!isKernelMode()` and ternaries.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB_SRC = join(ROOT, 'apps', 'web', 'src');
const MARKER = /kernel-empty:\s*\S+/u;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', 'generated']);
const TEST_FILE = /\.(test|spec)\.tsx?$/u;

/** A kernel-mode branch that produces a value without touching the backend. */
export function findKernelEmptyBranches(sourceText, fileName = 'fixture.ts') {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const lines = sourceText.split(/\r?\n/u);
  const found = [];

  const isKernelCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'isKernelMode';

  const isNegated = (condition) => {
    if (
      ts.isPrefixUnaryExpression(condition) &&
      condition.operator === ts.SyntaxKind.ExclamationToken
    ) {
      return isKernelCall(condition.operand);
    }
    return (
      ts.isBinaryExpression(condition) &&
      condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      isNegated(condition.left)
    );
  };

  const walk = (node) => {
    if (ts.isIfStatement(node) && isKernelCall(node.expression) && !isNegated(node.expression)) {
      const block = node.thenStatement;
      const blockStart = block.getStart(source);
      const blockEnd = block.getEnd();
      const body = sourceText.slice(blockStart, blockEnd);

      let hasCall = false;
      const scan = (child) => {
        // A throw is a fail-closed outcome, not a fabricated value: `new
        // UnsupportedError(…)` must count as work, and so must the throw itself
        // (a branch that only returns closures which throw is still honest).
        if (ts.isCallExpression(child) || ts.isNewExpression(child) || ts.isThrowStatement(child)) {
          hasCall = true;
        }
        ts.forEachChild(child, scan);
      };
      scan(block);

      // A marker may sit inside the branch or on the lines immediately above it
      // (single-line guards have nowhere else to put a comment).
      const statementLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      const preceding = lines.slice(Math.max(0, statementLine - 4), statementLine).join('\n');

      if (!hasCall && !MARKER.test(body) && !MARKER.test(preceding)) {
        // Point at the guard itself: that is the line a reviewer edits.
        const guardLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        found.push({
          file: fileName,
          line: guardLine + 1,
          snippet: lines[guardLine].trim(),
        });
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(source);
  return found;
}

function collectFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collectFiles(path, out);
      continue;
    }
    if (/\.tsx?$/u.test(name) && !TEST_FILE.test(name)) out.push(path);
  }
  return out;
}

function scanRepo() {
  const hits = [];
  for (const file of collectFiles(WEB_SRC)) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    hits.push(...findKernelEmptyBranches(readFileSync(file, 'utf8'), rel));
  }
  return hits;
}

const arg = process.argv[2] ?? '--check';
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const hits = scanRepo();

  if (arg === '--list') {
    for (const hit of hits) console.log(`${hit.file}:${hit.line}  ${hit.snippet}`);
    console.log(`[check-kernel-empty] ${hits.length} unmarked empty branch(es)`);
    process.exit(0);
  }

  if (arg === '--check') {
    if (hits.length === 0) {
      console.log(
        '[check-kernel-empty] OK — every kernel-mode branch either calls the backend or carries a `kernel-empty:` marker',
      );
      process.exit(0);
    }
    console.error(
      `[check-kernel-empty] FAIL — ${hits.length} kernel-mode branch(es) fabricate a value without a call and without a marker:`,
    );
    for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  ${hit.snippet}`);
    console.error(
      'Either implement the wire path / throw UnsupportedError, or add `// kernel-empty: <reason>` inside the branch (docs/architecture/kernel-empty-branches.md).',
    );
    process.exit(1);
  }

  console.error(`[check-kernel-empty] unknown argument: ${arg}`);
  process.exit(2);
}
