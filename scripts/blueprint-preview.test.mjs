import { describe, expect, it } from 'vitest';

import { buildPreviewHtml } from './blueprint-preview.mjs';

const nodes = [
  {
    tag: 'div',
    component: 'app-shell',
    part: null,
    slot: 'app.shell',
    role: null,
    action: null,
    state: null,
    key: null,
    identity: 'slot:app.shell+component:app-shell',
    path: 'slot:app.shell+component:app-shell',
    rect: { x: 0, y: 0, w: 1100, h: 760 },
  },
  {
    tag: 'button',
    component: 'button',
    part: null,
    slot: null,
    role: 'button',
    action: 'send',
    state: null,
    key: null,
    identity: 'component:button+action:send',
    path: 'slot:app.shell > component:button+action:send',
    rect: { x: 900, y: 700, w: 96, h: 36 },
  },
];

describe('blueprint preview report (M4 wave 2)', () => {
  const html = buildPreviewHtml({
    documentPath: 'doc.json',
    width: 1100,
    height: 760,
    pngBase64: 'QUJD',
    nodes,
  });

  it('embeds the screenshot and draws one overlay rect per node', () => {
    expect(html).toContain('data:image/png;base64,QUJD');
    expect(html.match(/<rect data-idx=/g)).toHaveLength(nodes.length);
    expect(html).toContain('viewBox="0 0 1100 760"');
    expect(html).toContain('1100×760');
  });

  it('lists hook identities, actions and paths', () => {
    expect(html).toContain('action:send');
    expect(html).toContain('slot:app.shell &gt; component:button+action:send');
    expect(html).toContain('role:button');
  });

  it('escapes markup-looking values', () => {
    const hostile = buildPreviewHtml({
      documentPath: '<img src=x onerror=1>',
      width: 10,
      height: 10,
      pngBase64: '',
      nodes: [
        {
          tag: 'div',
          component: '<script>',
          part: null,
          slot: null,
          role: null,
          action: null,
          state: null,
          key: null,
          identity: 'x',
          path: '<b>',
          rect: { x: 0, y: 0, w: 1, h: 1 },
        },
      ],
    });
    expect(hostile).not.toContain('component:<script>');
    expect(hostile).toContain('component:&lt;script&gt;');
    expect(hostile).toContain('&lt;img src=x onerror=1&gt;');
  });

  it('keeps the node payload structured via JSON.stringify only', () => {
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    // The inline payload is a JSON array of {label, details} strings.
    expect(script).toContain('"label"');
    expect(script).toContain('"details"');
  });
});
