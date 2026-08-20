import { describe, expect, it } from 'vitest';
import {
  type CaptureBundle,
  type CaptureMatrix,
  normalizeCharacterManagerCaptureMatrix,
} from '../src/presentation/blueprint.js';

function node(
  nodeId: string,
  component: string,
  parentNodeId: string | undefined,
  order: number,
  actions: CaptureBundle['nodes'][number]['actions'] = [],
  binding?: string,
): CaptureBundle['nodes'][number] {
  return {
    nodeId,
    ...(parentNodeId ? { parentNodeId } : {}),
    order,
    component,
    ...(binding ? { binding } : {}),
    states: [],
    actions,
    semantic: { role: component === 'CharacterManager' ? 'region' : 'group' },
    bounds: { x: 0, y: 0, width: 320, height: 48 },
    computedStyle: { display: 'flex', gap: 'var(--st-space-2)' },
    authoredDeclarations: [
      {
        property: 'display',
        value: 'flex',
        selector: `[data-ui-node="${nodeId}"]`,
        conditions: [],
      },
    ],
  };
}

function capture(viewportClass: CaptureBundle['viewportClass']): CaptureBundle {
  const dimensions =
    viewportClass === 'compact'
      ? { width: 360, height: 800, orientation: 'portrait' as const }
      : viewportClass === 'medium'
        ? { width: 720, height: 800, orientation: 'portrait' as const }
        : { width: 1_280, height: 800, orientation: 'landscape' as const };
  return {
    format: 'neotavern.capture.v1',
    fixtureId: `character-manager.populated.${viewportClass}`,
    surfaceId: 'character-manager',
    state: 'populated',
    viewportClass,
    viewport: { ...dimensions, deviceScaleFactor: 1, ime: 'closed' },
    rootNodeId: 'character-manager',
    nodes: [
      node('character-manager', 'CharacterManager', undefined, 0),
      node('character-tabs', 'CharacterTabs', 'character-manager', 0, ['tabs.select']),
      node('character-cards', 'CharacterCards', 'character-manager', 1, [], 'characters.items'),
      node('character-toolbar', 'CharacterToolbar', 'character-cards', 0, [
        'characters.create',
        'characters.import',
      ]),
      node(
        'character-search',
        'CharacterSearch',
        'character-cards',
        1,
        ['characters.search'],
        'characters.query',
      ),
      node(
        'character-view-toggle',
        'CharacterViewToggle',
        'character-cards',
        2,
        ['characters.view.set'],
        'characters.view',
      ),
      node(
        'character-card',
        'CharacterCard',
        'character-cards',
        3,
        ['characters.select'],
        'characters.items[*]',
      ),
    ],
    actionTrace: [
      {
        gesture: 'tap',
        nodeId: 'character-card',
        actionId: 'characters.select',
        beforeState: 'character-manager.cards',
        afterState: 'chat.open',
      },
    ],
  };
}

function matrix(): CaptureMatrix {
  return {
    captures: [capture('compact'), capture('medium'), capture('expanded')],
  };
}

describe('Character Manager UiBlueprint importer', () => {
  it('keeps responsive recipes and behavior but drops Chromium bounds and CSS pixels', () => {
    const result = normalizeCharacterManagerCaptureMatrix(matrix());
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);

    expect(result.value.format).toBe('neotavern.ui-blueprint.v1');
    expect(result.value.responsive).toEqual([
      { viewportClass: 'compact', layout: 'compact-panel' },
      { viewportClass: 'medium', layout: 'rail-overlay-panel' },
      { viewportClass: 'expanded', layout: 'rail-resizable-panel' },
    ]);
    expect(result.value.root.children.map((child) => child.nodeId)).toEqual([
      'character-tabs',
      'character-cards',
    ]);
    expect(JSON.stringify(result.value)).not.toContain('width');
    expect(JSON.stringify(result.value)).not.toContain('--st-space-2');
    expect(result.value.sourceFixtureIds).toEqual([
      'character-manager.populated.compact',
      'character-manager.populated.expanded',
      'character-manager.populated.medium',
    ]);
  });

  it('rejects a CSS property rather than flattening it', () => {
    const input = matrix();
    const firstCapture = input.captures[0];
    if (!firstCapture) throw new Error('expected compact fixture');
    const root = firstCapture.nodes.find((candidate) => candidate.nodeId === 'character-manager');
    if (!root) throw new Error('expected root node');
    root.computedStyle['backdrop-filter'] = 'blur(12px)';

    expect(normalizeCharacterManagerCaptureMatrix(input)).toEqual({
      ok: false,
      error: {
        code: 'PRESENTATION_CAPTURE_UNSUPPORTED_STYLE',
        params: { property: 'backdrop-filter', nodeId: 'character-manager' },
      },
    });
  });

  it('requires the complete compact/medium/expanded matrix', () => {
    const input = matrix();
    input.captures.pop();

    expect(normalizeCharacterManagerCaptureMatrix(input)).toEqual({
      ok: false,
      error: {
        code: 'PRESENTATION_CAPTURE_MATRIX_INCOMPLETE',
        params: { viewportClass: 'expanded' },
      },
    });
  });
});
