import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  bandHeightDiff,
  checkCatalog,
  diffSkeletons,
  loadCatalog,
  slotIdentity,
  runCli,
  strictFailures,
} from './compare.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

function skeleton(nodes, source = 'native') {
  return { source, viewport: { width: 1100, height: 760 }, nodes };
}

function node(partial) {
  return {
    tag: 'div',
    component: null,
    part: null,
    slot: null,
    role: null,
    action: null,
    identity: slotIdentity(partial),
    ...partial,
  };
}

describe('slotIdentity', () => {
  it('joins documented hooks in a stable order', () => {
    expect(
      slotIdentity({
        component: 'chat-message',
        role: 'assistant',
        part: 'message',
      }),
    ).toBe('component:chat-message+part:message+role:assistant');
    expect(slotIdentity({ slot: 'chat.composer', part: 'toolbar' })).toBe(
      'slot:chat.composer+part:toolbar',
    );
  });
});

describe('checkCatalog', () => {
  it('accepts the checked-in chat catalog against a matching tree', () => {
    const catalog = loadCatalog(join(here, 'chat-slots.json'));
    const native = skeleton([
      node({ slot: 'app.shell' }),
      node({ component: 'navigation-rail' }),
      node({ part: 'chat-wallpaper' }),
      node({ component: 'chat-view' }),
      node({ component: 'chat-panel' }),
      node({ slot: 'chat.header', part: 'header' }),
      node({ part: 'character-identity' }),
      node({ component: 'chat-viewport', part: 'canvas' }),
      node({ part: 'chat-scroll' }),
      node({ component: 'chat-message', part: 'message', role: 'assistant' }),
      node({ component: 'message-action-bar', part: 'message-actions-inline' }),
      node({ part: 'message-header' }),
      node({ part: 'message-author' }),
      node({ slot: 'chat.composer', part: 'composer' }),
      node({ part: 'toolbar' }),
      node({ part: 'field' }),
      node({ component: 'textarea' }),
      node({ action: 'send', part: 'composer-send' }),
    ]);
    const { missing } = checkCatalog(native, catalog);
    expect(missing).toEqual([]);
  });

  it('reports a missing chat-panel', () => {
    const { missing } = checkCatalog(skeleton([node({ component: 'chat-view' })]), {
      required: [{ component: 'chat-panel' }],
    });
    expect(missing).toHaveLength(1);
    expect(missing[0].label).toBe('component:chat-panel');
  });
});

describe('diffSkeletons', () => {
  it('lists identities only on one side', () => {
    const react = skeleton([node({ component: 'chat-message', role: 'user' })], 'react');
    const native = skeleton([node({ component: 'chat-message', role: 'assistant' })]);
    const diff = diffSkeletons(react, native);
    expect(diff.onlyLeft.map((row) => row.identity)).toEqual(['component:chat-message+role:user']);
    expect(diff.onlyRight.map((row) => row.identity)).toEqual([
      'component:chat-message+role:assistant',
    ]);
  });
});

describe('strictFailures / --fail-on-diff', () => {
  it('is empty without a react comparison', () => {
    expect(strictFailures({ nativeNodes: 3 })).toEqual([]);
  });

  it('classifies only-left, only-right and count mismatches', () => {
    const report = {
      reactNodes: 4,
      vsReact: {
        onlyLeft: [{ identity: 'a', count: 2 }],
        onlyRight: [{ identity: 'b', count: 1 }],
        countMismatch: [{ identity: 'c', left: 3, right: 1 }],
      },
    };
    expect(strictFailures(report)).toEqual([
      { identity: 'a', count: 2, kind: 'only-in-react' },
      { identity: 'b', count: 1, kind: 'only-in-native' },
      { identity: 'c', left: 3, right: 1, kind: 'count-mismatch' },
    ]);
  });

  it('runCli --fail-on-diff exits 1 on any identity diff, 0 on a match; report-only stays green', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nt-dom-parity-'));
    const reactMatch = join(dir, 'react-match.json');
    const reactDiff = join(dir, 'react-diff.json');
    const nativePath = join(dir, 'native.json');
    writeFileSync(nativePath, JSON.stringify(skeleton([node({ slot: 'chat.composer' })])));
    writeFileSync(reactMatch, JSON.stringify(skeleton([node({ slot: 'chat.composer' })], 'react')));
    writeFileSync(
      reactDiff,
      JSON.stringify(
        skeleton([node({ slot: 'chat.composer' }), node({ component: 'react-only' })], 'react'),
      ),
    );
    writeFileSync(
      join(dir, 'native-diff.json'),
      JSON.stringify(
        skeleton([node({ slot: 'chat.composer' }), node({ component: 'native-only' })]),
      ),
    );
    const script = join(here, 'compare.mjs');
    const argv = (react, native) => [script, '--react', react, '--native', native, '--json'];
    // Back-compat: identical inputs pass in strict mode.
    const match = spawnSync(process.execPath, [...argv(reactMatch, nativePath), '--fail-on-diff'], {
      encoding: 'utf8',
    });
    // Strict mode fails on any diff…
    const strictReact = spawnSync(
      process.execPath,
      [...argv(reactDiff, nativePath), '--fail-on-diff'],
      { encoding: 'utf8' },
    );
    const strictNative = spawnSync(
      process.execPath,
      [...argv(reactMatch, join(dir, 'native-diff.json')), '--fail-on-diff'],
      { encoding: 'utf8' },
    );
    // …while the default report-only run of the same diff stays green.
    const lenient = spawnSync(process.execPath, argv(reactDiff, nativePath), {
      encoding: 'utf8',
    });
    rmSync(dir, { recursive: true, force: true });
    expect(match.status).toBe(0);
    expect(JSON.parse(match.stdout).strictFailures).toEqual([]);
    expect(strictReact.status).toBe(1);
    expect(JSON.parse(strictReact.stdout).strictFailures).toEqual([
      { identity: 'component:react-only', count: 1, kind: 'only-in-react' },
    ]);
    expect(strictNative.status).toBe(1);
    expect(JSON.parse(strictNative.stdout).strictFailures).toEqual([
      { identity: 'component:native-only', count: 1, kind: 'only-in-native' },
    ]);
    expect(lenient.status).toBe(0);
  });
});

describe('bandHeightDiff (chrome_metrics ↔ React rects)', () => {
  const bandNode = (slot, h) => node({ slot, rect: { x: 0, y: 0, w: 600, h } });

  it('passes when chrome band heights match within tolerance', () => {
    const react = skeleton([bandNode('chat.header', 84)], 'react');
    const native = skeleton([bandNode('chat.header', 84)]);
    const result = bandHeightDiff(react, native, 1);
    expect(result.mismatches).toEqual([]);
    expect(result.checked).toEqual([{ identity: 'slot:chat.header', reactH: 84, nativeH: 84 }]);
  });

  it('fails when a band height drifts beyond the tolerance', () => {
    const react = skeleton([bandNode('chat.composer', 174)], 'react');
    const native = skeleton([bandNode('chat.composer', 190)]);
    const result = bandHeightDiff(react, native, 1);
    expect(result.mismatches).toEqual([
      {
        identity: 'slot:chat.composer',
        reactH: 174,
        nativeH: 190,
        diff: 16,
      },
    ]);
    // A custom tolerance can absorb known rounding drift.
    expect(bandHeightDiff(react, native, 16).mismatches).toEqual([]);
  });

  it('skips bands missing from one side (structural diffs cover them)', () => {
    const result = bandHeightDiff(skeleton([], 'react'), skeleton([bandNode('chat.header', 84)]));
    expect(result.checked).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });

  it('feeds band mismatches into the strict gate', () => {
    const report = {
      reactNodes: 1,
      vsReact: { onlyLeft: [], onlyRight: [], countMismatch: [] },
      bandHeights: {
        tolerancePx: 1,
        checked: [],
        mismatches: [
          {
            identity: 'slot:chat.composer',
            reactH: 174,
            nativeH: 190,
            diff: 16,
          },
        ],
      },
    };
    expect(strictFailures(report)).toEqual([
      {
        identity: 'slot:chat.composer',
        reactH: 174,
        nativeH: 190,
        diff: 16,
        kind: 'band-height',
      },
    ]);
  });
});

describe('compare CLI', () => {
  it('exits 1 when the native dump misses a catalog slot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nt-dom-parity-'));
    const nativePath = join(dir, 'native.json');
    writeFileSync(nativePath, JSON.stringify(skeleton([node({ component: 'chat-view' })])));
    const catalogPath = join(dir, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify({ required: [{ component: 'chat-panel' }] }));
    const script = join(here, 'compare.mjs');
    const result = spawnSync(
      process.execPath,
      [script, '--native', nativePath, '--catalog', catalogPath, '--json'],
      { encoding: 'utf8' },
    );
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.catalogMissing[0].label).toBe('component:chat-panel');
  });

  it('runCli returns 2 without --native', () => {
    const lines = [];
    const code = runCli([], { log: (msg) => lines.push(String(msg)) });
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/Usage/);
  });
});
