/**
 * `PluginVisualSurface` IR schema v1 tests (ADR-0058; platform doc §11).
 * Every normative budget in `VISUAL_SURFACE_LIMITS` must be enforced
 * fail-fast with a stable error code — the host re-validates at the
 * untrusted boundary with these exact rules.
 */
import { describe, expect, it } from 'vitest';
import {
  VISUAL_SURFACE_IR_VERSION,
  VISUAL_SURFACE_LIMITS,
  VisualSurfaceError,
  validateVisualSurfaceFragment,
  visualSurfaceStats,
  type VisualSurfaceErrorCode,
  type VisualSurfaceFragment,
} from '../src/index.js';

const ASSET_A = '0f0e1d2c-3b4a-4998-8776-655443332211';

/** A minimal valid fragment: one container, one bound button. */
function validFragment(): unknown {
  return {
    irVersion: VISUAL_SURFACE_IR_VERSION,
    surfaceId: 'author.plugin-name.viewer',
    placement: 'sidebar',
    title: 'Weather viewer',
    root: {
      id: 'root',
      kind: 'container',
      direction: 'column',
      gap: 'space.2',
      children: [
        { id: 'city', kind: 'text', text: 'Moscow', variant: 'heading' },
        {
          id: 'icon',
          kind: 'image',
          assetId: ASSET_A,
          alt: 'Current conditions',
        },
        {
          id: 'refresh',
          kind: 'button',
          label: 'Refresh',
          actionId: 'refresh',
          variant: 'primary',
        },
      ],
    },
    actions: {
      refresh: { rpc: 'weather.refresh', permission: 'chat.read' },
    },
  };
}

/** Assert `validateVisualSurfaceFragment(fragment)` fails with the given code. */
function expectCode(fragment: unknown, code: VisualSurfaceErrorCode): VisualSurfaceError {
  try {
    validateVisualSurfaceFragment(fragment);
  } catch (error) {
    expect(error).toBeInstanceOf(VisualSurfaceError);
    const typed = error as VisualSurfaceError;
    expect(typed.code).toBe(code);
    expect(typed.message).toContain(code);
    return typed;
  }
  throw new Error(`expected validation failure ${code}, but the fragment was accepted`);
}

function containerWithChildren(count: number): unknown {
  return {
    irVersion: VISUAL_SURFACE_IR_VERSION,
    surfaceId: 'author.plugin-name.viewer',
    placement: 'panel',
    title: 'Bulk',
    root: {
      id: 'root',
      kind: 'container',
      direction: 'column',
      children: Array.from({ length: count }, (_, index) => ({
        id: `leaf-${index}`,
        kind: 'text',
        text: 'x',
        variant: 'body',
      })),
    },
    actions: {},
  };
}

describe('valid fragments', () => {
  it('accepts a minimal fragment and normalizes the tree', () => {
    const fragment: VisualSurfaceFragment = validateVisualSurfaceFragment(validFragment());
    expect(fragment.irVersion).toBe(1);
    expect(fragment.surfaceId).toBe('author.plugin-name.viewer');
    expect(fragment.placement).toBe('sidebar');
    expect(fragment.title).toBe('Weather viewer');
    expect(fragment.root.children).toHaveLength(3);
    expect(fragment.actions['refresh']).toEqual({
      rpc: 'weather.refresh',
      permission: 'chat.read',
    });
    expect(visualSurfaceStats(fragment)).toEqual({
      nodes: 4,
      depth: 2,
      images: 1,
      inputs: 0,
      actions: 1,
    });
  });

  it('accepts an input node with a bound commit action', () => {
    const fragment = validateVisualSurfaceFragment({
      ...validFragment(),
      placement: 'panel',
      root: {
        id: 'root',
        kind: 'container',
        direction: 'row',
        children: [
          {
            id: 'query',
            kind: 'input',
            inputId: 'query',
            inputType: 'text',
            placeholder: 'City…',
            initial: 'Moscow',
            maxLength: 64,
            actionId: 'search',
          },
        ],
      },
      actions: { search: { rpc: 'weather.search' } },
    });
    expect(visualSurfaceStats(fragment)).toMatchObject({ nodes: 2, inputs: 1 });
  });
});

describe('envelope validation', () => {
  it('rejects non-objects and unsupported IR versions', () => {
    expectCode('fragment', 'FRAGMENT_INVALID');
    expectCode(null, 'FRAGMENT_INVALID');
    expectCode({ ...validFragment(), irVersion: 2 }, 'IR_VERSION_UNSUPPORTED');
    expectCode({ ...validFragment(), irVersion: '1' }, 'IR_VERSION_UNSUPPORTED');
  });

  it('rejects invalid surface ids, placements and titles', () => {
    expectCode({ ...validFragment(), surfaceId: 'Viewer' }, 'SURFACE_ID_INVALID');
    expectCode({ ...validFragment(), surfaceId: 'single' }, 'SURFACE_ID_INVALID');
    expectCode({ ...validFragment(), surfaceId: 'a.b..c' }, 'SURFACE_ID_INVALID');
    expectCode({ ...validFragment(), surfaceId: `${'x'.repeat(129)}.sub` }, 'SURFACE_ID_INVALID');
    expectCode({ ...validFragment(), placement: 'fullscreen' }, 'PLACEMENT_UNKNOWN');
    expectCode({ ...validFragment(), title: '' }, 'TITLE_INVALID');
    expectCode({ ...validFragment(), title: 'a\tb' }, 'TITLE_INVALID');
    expectCode({ ...validFragment(), title: 'x'.repeat(257) }, 'TITLE_INVALID');
  });

  it('rejects unbound or malformed action bindings', () => {
    expectCode({ ...validFragment(), actions: {} }, 'ACTION_UNKNOWN');
    expectCode({ ...validFragment(), actions: { refresh: { rpc: '' } } }, 'RPC_NAME_INVALID');
    expectCode(
      {
        ...validFragment(),
        actions: { refresh: { rpc: 'x', permission: 'network:evil.example' } },
      },
      'PERMISSION_UNKNOWN',
    );
    expectCode(
      {
        ...validFragment(),
        actions: Object.fromEntries(
          Array.from({ length: VISUAL_SURFACE_LIMITS.maxActions + 1 }, (_, i) => [
            `a${i}`,
            { rpc: 'x' },
          ]),
        ),
      },
      'TOO_MANY_ACTIONS',
    );
  });
});

describe('node validation', () => {
  it('rejects unknown node kinds and structural garbage', () => {
    const fragment = validFragment() as Record<string, unknown>;
    const root = fragment['root'] as Record<string, unknown>;
    expectCode(
      {
        ...fragment,
        root: {
          ...root,
          children: [{ id: 'x', kind: 'iframe', src: 'https://evil.example' }],
        },
      },
      'NODE_KIND_UNKNOWN',
    );
    expectCode(
      {
        ...fragment,
        root: { ...root, children: [{ id: 'x', kind: 'text', text: 'x', variant: 'neon' }] },
      },
      'FRAGMENT_INVALID',
    );
    expectCode({ ...fragment, root: { ...root, direction: 'diagonal' } }, 'FRAGMENT_INVALID');
  });

  it('rejects duplicate node ids and malformed ids', () => {
    const fragment = validFragment() as Record<string, unknown>;
    const root = fragment['root'] as Record<string, unknown>;
    expectCode(
      {
        ...fragment,
        root: {
          ...root,
          children: [
            { id: 'dup', kind: 'text', text: 'a', variant: 'body' },
            { id: 'dup', kind: 'text', text: 'b', variant: 'body' },
          ],
        },
      },
      'NODE_ID_DUPLICATE',
    );
    expectCode(
      {
        ...fragment,
        root: { ...root, children: [{ id: '9bad', kind: 'text', text: 'x', variant: 'body' }] },
      },
      'NODE_ID_INVALID',
    );
  });

  it('enforces the text, label and gap budgets', () => {
    const fragment = validFragment() as Record<string, unknown>;
    const root = fragment['root'] as Record<string, unknown>;
    expectCode(
      {
        ...fragment,
        root: {
          ...root,
          children: [
            {
              id: 't',
              kind: 'text',
              text: 'x'.repeat(VISUAL_SURFACE_LIMITS.maxTextLength + 1),
              variant: 'body',
            },
          ],
        },
      },
      'TEXT_TOO_LONG',
    );
    expectCode(
      {
        ...fragment,
        root: {
          ...root,
          children: [
            {
              id: 'b',
              kind: 'button',
              label: 'x'.repeat(257),
              actionId: 'refresh',
              variant: 'ghost',
            },
          ],
        },
      },
      'LABEL_TOO_LONG',
    );
    expectCode({ ...fragment, root: { ...root, gap: '16' } }, 'GAP_TOKEN_INVALID');
    expectCode({ ...fragment, root: { ...root, gap: '#ff0000' } }, 'GAP_TOKEN_INVALID');
  });

  it('rejects image nodes without a valid plugin asset ref or alt', () => {
    const fragment = validFragment() as Record<string, unknown>;
    const root = fragment['root'] as Record<string, unknown>;
    expectCode(
      {
        ...fragment,
        root: {
          ...root,
          children: [
            { id: 'i', kind: 'image', assetId: 'https://evil.example/pixel.gif', alt: 'x' },
          ],
        },
      },
      'ASSET_ID_INVALID',
    );
    expectCode(
      {
        ...fragment,
        root: { ...root, children: [{ id: 'i', kind: 'image', assetId: ASSET_A, alt: '' }] },
      },
      'LABEL_TOO_LONG',
    );
  });

  it('rejects input nodes with malformed types, budgets or bindings', () => {
    const fragment = validFragment() as Record<string, unknown>;
    const root = fragment['root'] as Record<string, unknown>;
    expectCode(
      {
        ...fragment,
        root: { ...root, children: [{ id: 'q', kind: 'input', inputId: 'q', inputType: 'rich' }] },
      },
      'FRAGMENT_INVALID',
    );
    expectCode(
      {
        ...fragment,
        root: {
          ...root,
          children: [{ id: 'q', kind: 'input', inputId: 'q', inputType: 'text', maxLength: 0 }],
        },
      },
      'INPUT_TOO_LONG',
    );
    expectCode(
      {
        ...fragment,
        root: {
          ...root,
          children: [
            { id: 'q', kind: 'input', inputId: 'q', inputType: 'text', actionId: 'missing' },
          ],
        },
      },
      'ACTION_UNKNOWN',
    );
  });
});

describe('structural budgets', () => {
  /** A depth-`levels` chain: each level one container with the tail inside. */
  function nestedChain(levels: number): unknown {
    let node: Record<string, unknown> = {
      id: 'leaf',
      kind: 'text',
      text: 'x',
      variant: 'body',
    };
    for (let level = levels; level >= 2; level -= 1) {
      node = { id: `c${level}`, kind: 'container', direction: 'row', children: [node] };
    }
    return node;
  }

  /** A complete branching tree: `levels` deep, 32 containers per level. */
  function wideBranching(levels: number): Record<string, unknown> {
    const build = (depth: number, prefix: string): Record<string, unknown> => {
      if (depth === levels) {
        return { id: `leaf${prefix}`, kind: 'text', text: 'x', variant: 'body' };
      }
      return {
        id: `c${depth}${prefix}`,
        kind: 'container',
        direction: 'row',
        children: Array.from({ length: VISUAL_SURFACE_LIMITS.maxChildrenPerContainer }, (_, i) =>
          build(depth + 1, `${prefix}.${i}`),
        ),
      };
    };
    return build(1, '');
  }

  it('enforces maxChildrenPerContainer, maxNodes, maxDepth and the image/input caps', () => {
    expectCode(
      containerWithChildren(VISUAL_SURFACE_LIMITS.maxChildrenPerContainer + 1),
      'TOO_MANY_CHILDREN',
    );
    expectCode(containerWithChildren(1_000_000), 'TOO_MANY_CHILDREN');

    const fragment = validFragment() as Record<string, unknown>;
    // Depth maxDepth passes; one deeper container fails.
    expect(() =>
      validateVisualSurfaceFragment({
        ...fragment,
        root: nestedChain(VISUAL_SURFACE_LIMITS.maxDepth),
      }),
    ).not.toThrow();
    const tooDeep: Record<string, unknown> = {
      id: 'c0',
      kind: 'container',
      direction: 'row',
      children: [nestedChain(VISUAL_SURFACE_LIMITS.maxDepth)],
    };
    expectCode({ ...fragment, root: tooDeep }, 'TREE_TOO_DEEP');

    // Node budget: a branching tree with >maxNodes nodes trips TOO_MANY_NODES
    // mid-walk (each container stays within maxChildrenPerContainer).
    expectCode({ ...fragment, root: wideBranching(3) }, 'TOO_MANY_NODES');

    // maxImages + 1 image nodes, spread over two containers so the
    // per-container child cap is not what trips (the IMAGE budget is).
    const imageNode = (i: number): Record<string, unknown> => ({
      id: `i${i}`,
      kind: 'image',
      assetId: ASSET_A,
      alt: 'x',
    });
    const images = Array.from({ length: VISUAL_SURFACE_LIMITS.maxImages + 1 }, (_, i) =>
      imageNode(i),
    );
    const half = Math.ceil(images.length / 2);
    expectCode(
      {
        ...fragment,
        root: {
          id: 'imgroot',
          kind: 'container',
          direction: 'column',
          children: [
            { id: 'row-a', kind: 'container', direction: 'row', children: images.slice(0, half) },
            { id: 'row-b', kind: 'container', direction: 'row', children: images.slice(half) },
          ],
        },
      },
      'TOO_MANY_NODES',
    );
  });

  it('fails fast on a hostile wide tree instead of walking it whole', () => {
    // A 1_000_000-child array must trip the container cap immediately —
    // the validator reads the length before recursing (resource containment).
    const started = performance.now();
    expectCode(containerWithChildren(1_000_000), 'TOO_MANY_CHILDREN');
    expect(performance.now() - started).toBeLessThan(250);
  });
});
