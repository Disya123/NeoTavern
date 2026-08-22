#!/usr/bin/env node
/**
 * Dump the Theme SDK slot skeleton from a live React page (Playwright).
 *
 *   node scripts/dom-parity/dump-react.mjs --url http://127.0.0.1:5173/home --out build/react-dom.json
 *
 * Same JSON shape as NeoCompositor `--dom-dump`. Compares via
 * `node scripts/dom-parity/compare.mjs --react … --native …`.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { slotIdentity } from './compare.mjs';

function parseArgs(argv) {
  const out = {
    url: '',
    out: 'build/react-dom.json',
    selector: '[data-slot="app.shell"], [data-component="chat-view"], [data-component="home"]',
    viewport: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') out.url = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--selector') out.selector = argv[++i];
    else if (arg === '--viewport') {
      const match = /^(\d+)x(\d+)$/.exec(argv[++i] ?? '');
      if (!match) throw new Error(`--viewport expects WxH (e.g. 1100x760), got "${argv[i]}"`);
      out.viewport = { width: Number(match[1]), height: Number(match[2]) };
    }
  }
  return out;
}

export function nodesFromDomSnapshot(elements) {
  return elements.map((node) => ({
    ...node,
    identity: slotIdentity(node),
  }));
}

async function dumpPage(url, selector, viewport) {
  // `playwright` is not a direct workspace dependency; `@playwright/test`
  // (the project standard) re-exports the same browser fixtures.
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: viewport ?? { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: 'networkidle' });
    // The SPA resolves its auth session and data queries after first paint;
    // give the workspace shell (or an honest error/offline screen) time to
    // replace loading skeletons before dumping.
    await page
      .waitForSelector('[data-slot="app.shell"]', { state: 'attached', timeout: 20_000 })
      .catch(() => {
        console.error('app.shell never attached; dumping whatever rendered');
      });
    return await page.evaluate((rootSelector) => {
      const roots = Array.from(document.querySelectorAll(rootSelector));
      const scope = roots.length > 0 ? roots : [document.documentElement];
      const seen = new Set();
      const nodes = [];
      const visit = (el, ancestors) => {
        if (!(el instanceof Element) || seen.has(el)) return;
        seen.add(el);
        const component = el.getAttribute('data-component');
        const part = el.getAttribute('data-part');
        const slot = el.getAttribute('data-slot');
        const role = el.getAttribute('data-role');
        const action = el.getAttribute('data-action');
        let nextAncestors = ancestors;
        if (component || part || slot || role || action) {
          const bits = [];
          if (slot) bits.push(`slot:${slot}`);
          if (component) bits.push(`component:${component}`);
          if (part) bits.push(`part:${part}`);
          if (role) bits.push(`role:${role}`);
          if (action) bits.push(`action:${action}`);
          const identity = bits.join('+');
          const pathParts = [...ancestors, identity];
          const rect = el.getBoundingClientRect();
          nodes.push({
            tag: el.tagName.toLowerCase(),
            component,
            part,
            slot,
            role,
            action,
            state: el.getAttribute('data-state'),
            key: el.getAttribute('data-ui-key') || el.getAttribute('data-message-id'),
            identity,
            path: pathParts.join(' > '),
            rect: {
              x: Math.round(rect.x * 10) / 10,
              y: Math.round(rect.y * 10) / 10,
              w: Math.round(rect.width * 10) / 10,
              h: Math.round(rect.height * 10) / 10,
            },
          });
          nextAncestors = pathParts;
        }
        for (const child of el.children) visit(child, nextAncestors);
      };
      for (const root of scope) visit(root, []);
      return {
        source: 'react',
        viewport: { width: window.innerWidth, height: window.innerHeight },
        nodes,
      };
    }, selector);
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error(
      'Usage: node scripts/dom-parity/dump-react.mjs --url <http> [--out build/react-dom.json] [--viewport 1100x760]',
    );
    process.exit(2);
  }
  const dump = await dumpPage(args.url, args.selector, args.viewport);
  dump.nodes = nodesFromDomSnapshot(dump.nodes);
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(dump, null, 2)}\n`);
  console.log(`WROTE ${outPath} (${dump.nodes.length} slot nodes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
