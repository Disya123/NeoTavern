import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  type CaptureBundle,
  type CaptureMatrix,
  normalizeCharacterManagerCaptureMatrix,
  UiBlueprintSchema,
} from '../src/presentation/blueprint.js';
import blueprintDocumentFixture from '../src/presentation/fixtures/ui-blueprint-document-v1.json' with { type: 'json' };

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

  it('rejects duplicate nodeIds rather than silently overwriting', () => {
    const input = matrix();
    const firstCapture = input.captures[0];
    if (!firstCapture) throw new Error('expected compact fixture');
    // Duplicate the character-card node without a disambiguating data-ui-key.
    const card = firstCapture.nodes.find((n) => n.nodeId === 'character-card');
    if (!card) throw new Error('expected card node');
    firstCapture.nodes.push({ ...card, order: 4 });

    expect(normalizeCharacterManagerCaptureMatrix(input)).toEqual({
      ok: false,
      error: { code: 'PRESENTATION_CAPTURE_DUPLICATE_NODE', params: { nodeId: 'character-card' } },
    });
  });

  it('rejects an unknown CSS function rather than flattening it', () => {
    const input = matrix();
    const firstCapture = input.captures[0];
    if (!firstCapture) throw new Error('expected compact fixture');
    const root = firstCapture.nodes.find((candidate) => candidate.nodeId === 'character-manager');
    if (!root) throw new Error('expected root node');
    root.computedStyle['background-image'] = 'my-unsupported-fn(12px)';

    expect(normalizeCharacterManagerCaptureMatrix(input)).toEqual({
      ok: false,
      error: {
        code: 'PRESENTATION_CAPTURE_UNSUPPORTED_VALUE',
        params: {
          function: 'my-unsupported-fn',
          nodeId: 'character-manager',
          property: 'background-image',
        },
      },
    });
  });

  it('rejects an unknown authored declaration function', () => {
    const input = matrix();
    const firstCapture = input.captures[0];
    if (!firstCapture) throw new Error('expected compact fixture');
    const root = firstCapture.nodes.find((candidate) => candidate.nodeId === 'character-manager');
    if (!root) throw new Error('expected root node');
    root.authoredDeclarations.push({
      property: 'background-image',
      value: 'paint(my-worklet)',
      selector: '[data-ui-node="character-manager"]',
      conditions: [],
    });

    expect(normalizeCharacterManagerCaptureMatrix(input)).toEqual({
      ok: false,
      error: {
        code: 'PRESENTATION_CAPTURE_UNSUPPORTED_VALUE',
        params: { function: 'paint', nodeId: 'character-manager', property: 'background-image' },
      },
    });
  });

  it('rejects an unsupported condition prefix rather than flattening it', () => {
    const input = matrix();
    const firstCapture = input.captures[0];
    if (!firstCapture) throw new Error('expected compact fixture');
    const root = firstCapture.nodes.find((candidate) => candidate.nodeId === 'character-manager');
    if (!root) throw new Error('expected root node');
    root.authoredDeclarations.push({
      property: 'display',
      value: 'flex',
      selector: '[data-ui-node="character-manager"]',
      conditions: ['@layer foo'],
    });

    expect(normalizeCharacterManagerCaptureMatrix(input)).toEqual({
      ok: false,
      error: {
        code: 'PRESENTATION_CAPTURE_UNSUPPORTED_CONDITION',
        params: { condition: '@layer foo', nodeId: 'character-manager' },
      },
    });
  });

  it('requires compact viewport class', () => {
    const input = matrix();
    input.captures = input.captures.filter((c) => c.viewportClass !== 'compact');

    expect(normalizeCharacterManagerCaptureMatrix(input)).toEqual({
      ok: false,
      error: {
        code: 'PRESENTATION_CAPTURE_MATRIX_INCOMPLETE',
        params: { viewportClass: 'compact' },
      },
    });
  });

  it('rejects shape mismatch when viewports diverge', () => {
    const input = matrix();
    const medium = input.captures.find((c) => c.viewportClass === 'medium');
    if (!medium) throw new Error('expected medium');
    medium.nodes.push(
      node('character-extra', 'CharacterCard', 'character-cards', 4, ['characters.select']),
    );

    expect(normalizeCharacterManagerCaptureMatrix(input)).toEqual({
      ok: false,
      error: {
        code: 'PRESENTATION_CAPTURE_SHAPE_MISMATCH',
        params: { fixtureId: 'character-manager.populated.medium' },
      },
    });
  });

  it('maps typed actions to reducer parameters', () => {
    const result = normalizeCharacterManagerCaptureMatrix(matrix());
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    const card = result.value.root.children
      .find((child) => child.nodeId === 'character-cards')
      ?.children.find((child) => child.nodeId === 'character-card');
    expect(card?.actions).toEqual([{ id: 'characters.select', parameter: 'characterId' }]);
    const tabs = result.value.root.children.find((child) => child.nodeId === 'character-tabs');
    expect(tabs?.actions).toEqual([{ id: 'tabs.select', parameter: 'tab' }]);
  });

  it('preserves the same action trace for React and Rust fixtures', () => {
    const input = matrix();
    const result = normalizeCharacterManagerCaptureMatrix(input);
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    // The fixture's actionTrace uses the stable card nodeId; the importer does
    // not alter it, so the Rust side can compare the same trace.
    expect(input.captures[0]?.actionTrace[0]?.nodeId).toBe('character-card');
    expect(input.captures[0]?.actionTrace[0]?.actionId).toBe('characters.select');
  });

  it('parses the same canonical UiBlueprint fixture in TypeScript', () => {
    expect(Value.Check(UiBlueprintSchema, blueprintDocumentFixture)).toBe(true);
    const blueprint = blueprintDocumentFixture as unknown as ReturnType<
      typeof normalizeCharacterManagerCaptureMatrix
    > extends { ok: true; value: infer V }
      ? V
      : never;
    // Spot-check that the canonical fixture matches the importer contract.
    expect(blueprint.format).toBe('neotavern.ui-blueprint.v1');
    expect(blueprint.id).toBe('character-manager');
    expect(blueprint.responsive).toHaveLength(3);
  });

  describe('node presentation overrides (M4 wave 1)', () => {
    const chatFixture = {
      format: 'neotavern.ui-blueprint.v1',
      id: 'chat',
      root: {
        nodeId: 'chat',
        component: 'Chat',
        recipe: 'chat',
        stateSlots: [],
        actions: [],
        children: [],
      },
      responsive: [
        { viewportClass: 'compact', layout: 'chat-compact-overlay' },
        { viewportClass: 'medium', layout: 'chat-split-panel' },
        { viewportClass: 'expanded', layout: 'chat-split-panel' },
      ],
      bindings: [],
      sourceFixtureIds: ['test'],
    };

    function withSendNode(presentation: Record<string, unknown>) {
      return {
        ...chatFixture,
        $schema: 'https://neotavern.dev/schemas/ui-blueprint.v1.json',
        root: {
          ...chatFixture.root,
          children: [
            {
              nodeId: 'composer-send',
              component: 'ComposerSendButton',
              recipe: 'primary-button',
              stateSlots: [],
              actions: [{ id: 'chat.send' }],
              ...presentation,
              children: [],
            },
          ],
        },
      };
    }

    it('accepts label, registry icon, token style refs and an editor $schema', () => {
      expect(
        Value.Check(
          UiBlueprintSchema,
          withSendNode({
            label: { text: 'Отправить', i18nKey: 'chat.send' },
            icon: 'PaperPlaneRight',
            styleRefs: [{ property: 'background-color', token: 'var(--nt-accent-strong)' }],
          }),
        ),
      ).toBe(true);
    });

    it('accepts presentation-free nodes (overrides stay optional)', () => {
      expect(Value.Check(UiBlueprintSchema, withSendNode({}))).toBe(true);
    });

    it('rejects raw CSS values — only design-token references are expressible', () => {
      expect(
        Value.Check(
          UiBlueprintSchema,
          withSendNode({
            styleRefs: [{ property: 'background-color', token: '#ff0000' }],
          }),
        ),
      ).toBe(false);
      expect(
        Value.Check(
          UiBlueprintSchema,
          withSendNode({
            styleRefs: [{ property: 'background-color', token: 'var(--x); position:fixed' }],
          }),
        ),
      ).toBe(false);
    });

    it('rejects icons outside the closed registry', () => {
      expect(Value.Check(UiBlueprintSchema, withSendNode({ icon: 'RocketLaunch' }))).toBe(false);
    });

    it('rejects i18n keys outside the chat namespace', () => {
      expect(
        Value.Check(
          UiBlueprintSchema,
          withSendNode({ label: { text: 'Hi', i18nKey: 'settings.title' } }),
        ),
      ).toBe(false);
    });

    it('accepts declarative custom intents with bounded params (M4 wave 3)', () => {
      const withActions = (actions: unknown) => ({
        ...chatFixture,
        root: {
          ...chatFixture.root,
          children: [
            {
              nodeId: 'composer-send',
              component: 'ComposerSendButton',
              recipe: 'primary-button',
              stateSlots: [],
              actions,
              children: [],
            },
          ],
        },
      });
      expect(
        Value.Check(
          UiBlueprintSchema,
          withActions([
            {
              id: 'custom.acme.pin-chat',
              params: [
                { key: 'target', value: 'sidebar' },
                { key: 'priority', value: 'low' },
              ],
            },
          ]),
        ),
      ).toBe(true);
      // Malformed owner/name segments are rejected by the pattern member.
      expect(Value.Check(UiBlueprintSchema, withActions([{ id: 'custom.acme' }]))).toBe(false);
      expect(Value.Check(UiBlueprintSchema, withActions([{ id: 'custom.Acme.pin' }]))).toBe(false);
      // Params are bounded: at most 8 entries, keys lowercase-ish, values short.
      expect(
        Value.Check(
          UiBlueprintSchema,
          withActions([
            {
              id: 'custom.acme.pin',
              params: Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, value: 'v' })),
            },
          ]),
        ),
      ).toBe(false);
      expect(
        Value.Check(
          UiBlueprintSchema,
          withActions([{ id: 'custom.acme.pin', params: [{ key: 'Bad Key', value: 'v' }] }]),
        ),
      ).toBe(false);
      // Builtin ids keep working alongside the pattern member.
      expect(Value.Check(UiBlueprintSchema, withActions([{ id: 'chat.send' }]))).toBe(true);
    });
  });
});
