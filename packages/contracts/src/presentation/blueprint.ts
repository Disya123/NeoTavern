/**
 * Versioned migration contract for a renderer-neutral first-party UI.
 *
 * `CaptureBundle` is deliberately a tooling-only Chromium observation.  It
 * never reaches a production renderer.  The strict importer below accepts a
 * finite, explicitly supported subset and produces `UiBlueprint`, which is
 * the portable input to the Rust presentation SDK.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const CAPTURE_BUNDLE_FORMAT_V1 = 'neotavern.capture.v1';
export const UI_BLUEPRINT_FORMAT_V1 = 'neotavern.ui-blueprint.v1';

const UiNodeIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-z][a-z0-9.-]*$',
});

const UiActionIdSchema = Type.Union([
  Type.Literal('characters.select'),
  Type.Literal('characters.create'),
  Type.Literal('characters.import'),
  Type.Literal('characters.search'),
  Type.Literal('characters.sort'),
  Type.Literal('characters.view.set'),
  Type.Literal('characters.load-more'),
  Type.Literal('tabs.select'),
  Type.Literal('panel.close'),
]);
export type UiActionId = Static<typeof UiActionIdSchema>;

const UiViewportClassSchema = Type.Union([
  Type.Literal('compact'),
  Type.Literal('medium'),
  Type.Literal('expanded'),
]);
export type UiViewportClass = Static<typeof UiViewportClassSchema>;

const UiFixtureStateSchema = Type.Union([
  Type.Literal('empty'),
  Type.Literal('loading'),
  Type.Literal('populated'),
  Type.Literal('selected'),
  Type.Literal('error'),
]);
export type UiFixtureState = Static<typeof UiFixtureStateSchema>;

const UiViewportSchema = Type.Object(
  {
    width: Type.Integer({ minimum: 1, maximum: 16_384 }),
    height: Type.Integer({ minimum: 1, maximum: 16_384 }),
    deviceScaleFactor: Type.Number({ minimum: 0.5, maximum: 8 }),
    orientation: Type.Union([Type.Literal('portrait'), Type.Literal('landscape')]),
    ime: Type.Union([Type.Literal('closed'), Type.Literal('open')]),
  },
  { additionalProperties: false },
);
export type UiViewport = Static<typeof UiViewportSchema>;

const UiBoundsSchema = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number({ minimum: 0 }),
    height: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type UiBounds = Static<typeof UiBoundsSchema>;

const UiSemanticSchema = Type.Object(
  {
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    name: Type.Optional(Type.String({ maxLength: 2_048 })),
    value: Type.Optional(Type.String({ maxLength: 8_192 })),
    disabled: Type.Optional(Type.Boolean()),
    selected: Type.Optional(Type.Boolean()),
    expanded: Type.Optional(Type.Boolean()),
    checked: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type UiSemantic = Static<typeof UiSemanticSchema>;

const UiAuthoredDeclarationSchema = Type.Object(
  {
    property: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z-]+$' }),
    value: Type.String({ maxLength: 2_048 }),
    selector: Type.String({ minLength: 1, maxLength: 2_048 }),
    conditions: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
      maxItems: 16,
    }),
    pseudo: Type.Optional(Type.Union([Type.Literal('before'), Type.Literal('after')])),
  },
  { additionalProperties: false },
);
export type UiAuthoredDeclaration = Static<typeof UiAuthoredDeclarationSchema>;

const UiCaptureNodeSchema = Type.Object(
  {
    nodeId: UiNodeIdSchema,
    parentNodeId: Type.Optional(UiNodeIdSchema),
    order: Type.Integer({ minimum: 0, maximum: 4_096 }),
    component: Type.String({ minLength: 1, maxLength: 128 }),
    binding: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    states: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
    actions: Type.Array(UiActionIdSchema, { maxItems: 16 }),
    semantic: UiSemanticSchema,
    bounds: UiBoundsSchema,
    computedStyle: Type.Record(
      Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z-]+$' }),
      Type.String({ maxLength: 2_048 }),
      { maxProperties: 96 },
    ),
    authoredDeclarations: Type.Array(UiAuthoredDeclarationSchema, { maxItems: 512 }),
  },
  { additionalProperties: false },
);
export type UiCaptureNode = Static<typeof UiCaptureNodeSchema>;

const UiActionTraceStepSchema = Type.Object(
  {
    gesture: Type.Union([
      Type.Literal('tap'),
      Type.Literal('keyboard'),
      Type.Literal('input'),
      Type.Literal('scroll'),
    ]),
    nodeId: UiNodeIdSchema,
    actionId: UiActionIdSchema,
    beforeState: Type.String({ minLength: 1, maxLength: 128 }),
    afterState: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type UiActionTraceStep = Static<typeof UiActionTraceStepSchema>;

const UiRasterRefSchema = Type.Object(
  {
    width: Type.Integer({ minimum: 1, maximum: 16_384 }),
    height: Type.Integer({ minimum: 1, maximum: 16_384 }),
    sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
);
export type UiRasterRef = Static<typeof UiRasterRefSchema>;

/** Chromium-only observation. Do not pass this object to a production renderer. */
export const CaptureBundleSchema = Type.Object(
  {
    format: Type.Literal(CAPTURE_BUNDLE_FORMAT_V1),
    fixtureId: Type.String({ minLength: 1, maxLength: 160 }),
    surfaceId: Type.Literal('character-manager'),
    state: UiFixtureStateSchema,
    viewportClass: UiViewportClassSchema,
    viewport: UiViewportSchema,
    rootNodeId: UiNodeIdSchema,
    nodes: Type.Array(UiCaptureNodeSchema, { minItems: 1, maxItems: 1_024 }),
    actionTrace: Type.Array(UiActionTraceStepSchema, { maxItems: 256 }),
    raster: Type.Optional(UiRasterRefSchema),
  },
  { additionalProperties: false },
);
export type CaptureBundle = Static<typeof CaptureBundleSchema>;

export const CaptureMatrixSchema = Type.Object(
  {
    captures: Type.Array(CaptureBundleSchema, { minItems: 1, maxItems: 32 }),
  },
  { additionalProperties: false },
);
export type CaptureMatrix = Static<typeof CaptureMatrixSchema>;

const UiBlueprintActionSchema = Type.Object(
  {
    id: UiActionIdSchema,
    parameter: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type UiBlueprintAction = Static<typeof UiBlueprintActionSchema>;

const UiBlueprintBindingSchema = Type.Object(
  {
    nodeId: UiNodeIdSchema,
    expression: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);
export type UiBlueprintBinding = Static<typeof UiBlueprintBindingSchema>;

const UiBlueprintNodeSchema = Type.Recursive(
  (This) =>
    Type.Object(
      {
        nodeId: UiNodeIdSchema,
        component: Type.String({ minLength: 1, maxLength: 128 }),
        recipe: Type.String({ minLength: 1, maxLength: 128 }),
        role: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        stateSlots: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
        actions: Type.Array(UiBlueprintActionSchema, { maxItems: 16 }),
        children: Type.Array(This, { maxItems: 256 }),
      },
      { additionalProperties: false },
    ),
  { $id: 'presentation.ui.blueprint.node.v1' },
);
export type UiBlueprintNode = Static<typeof UiBlueprintNodeSchema>;

const UiResponsiveRuleSchema = Type.Object(
  {
    viewportClass: UiViewportClassSchema,
    layout: Type.Union([
      Type.Literal('compact-panel'),
      Type.Literal('rail-overlay-panel'),
      Type.Literal('rail-resizable-panel'),
    ]),
  },
  { additionalProperties: false },
);
export type UiResponsiveRule = Static<typeof UiResponsiveRuleSchema>;

/**
 * Stable, renderer-neutral description consumed by the Rust presentation
 * SDK. It contains recipes and constraints, never browser bounds or computed
 * CSS pixels.
 */
export const UiBlueprintSchema = Type.Object(
  {
    format: Type.Literal(UI_BLUEPRINT_FORMAT_V1),
    id: Type.Literal('character-manager'),
    root: UiBlueprintNodeSchema,
    responsive: Type.Array(UiResponsiveRuleSchema, { minItems: 3, maxItems: 3 }),
    bindings: Type.Array(UiBlueprintBindingSchema, { maxItems: 256 }),
    sourceFixtureIds: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
      minItems: 1,
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
);
export type UiBlueprint = Static<typeof UiBlueprintSchema>;

export const SUPPORTED_CAPTURE_STYLE_PROPERTIES = [
  'align-content',
  'align-items',
  'align-self',
  'background',
  'background-color',
  'background-image',
  'background-position',
  'background-size',
  'border',
  'border-color',
  'border-radius',
  'border-style',
  'border-width',
  'bottom',
  'box-shadow',
  'box-sizing',
  'color',
  'column-gap',
  'contain',
  'cursor',
  'display',
  'filter',
  'flex',
  'flex-basis',
  'flex-direction',
  'flex-grow',
  'flex-shrink',
  'flex-wrap',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'gap',
  'grid-auto-columns',
  'grid-auto-rows',
  'grid-column',
  'grid-row',
  'grid-template-columns',
  'grid-template-rows',
  'height',
  'inset',
  'justify-content',
  'justify-items',
  'justify-self',
  'left',
  'letter-spacing',
  'line-height',
  'margin',
  'margin-block',
  'margin-inline',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'object-fit',
  'opacity',
  'order',
  'outline',
  'overflow',
  'overflow-x',
  'overflow-y',
  'padding',
  'padding-block',
  'padding-inline',
  'place-content',
  'place-items',
  'position',
  'right',
  'row-gap',
  'text-align',
  'text-decoration',
  'text-overflow',
  'text-transform',
  'top',
  'transform',
  'transform-origin',
  'transition',
  'visibility',
  'white-space',
  'width',
  'z-index',
] as const;

const SUPPORTED_CAPTURE_STYLE_PROPERTY_SET = new Set<string>(SUPPORTED_CAPTURE_STYLE_PROPERTIES);
const SUPPORTED_CSS_FUNCTIONS = new Set([
  'blur',
  'calc',
  'clamp',
  'color-mix',
  'conic-gradient',
  'cubic-bezier',
  'drop-shadow',
  'env',
  'hsl',
  'hsla',
  'inset',
  'linear-gradient',
  'matrix',
  'max',
  'min',
  'radial-gradient',
  'rgba',
  'rgb',
  'rotate',
  'scale',
  'steps',
  'translate',
  'translate3d',
  'translatex',
  'translatey',
  'url',
  'var',
]);
const SUPPORTED_CONDITION_PREFIXES = ['@container ', '@media ', '@supports '] as const;

const CHARACTER_MANAGER_RECIPES: Readonly<Record<string, string>> = {
  CharacterManager: 'character-manager',
  CharacterCards: 'character-collection',
  CharacterToolbar: 'character-toolbar',
  CharacterSearch: 'search-field',
  CharacterViewToggle: 'view-toggle',
  CharacterCard: 'character-card',
  CharacterTabs: 'tabs',
};
const REQUIRED_COMPONENTS = ['CharacterManager', 'CharacterCards', 'CharacterCard'] as const;

export type PresentationImportErrorCode =
  | 'PRESENTATION_CAPTURE_INVALID'
  | 'PRESENTATION_CAPTURE_DUPLICATE_NODE'
  | 'PRESENTATION_CAPTURE_TREE'
  | 'PRESENTATION_CAPTURE_UNSUPPORTED_COMPONENT'
  | 'PRESENTATION_CAPTURE_UNSUPPORTED_STYLE'
  | 'PRESENTATION_CAPTURE_UNSUPPORTED_VALUE'
  | 'PRESENTATION_CAPTURE_UNSUPPORTED_CONDITION'
  | 'PRESENTATION_CAPTURE_MATRIX_INCOMPLETE'
  | 'PRESENTATION_CAPTURE_SHAPE_MISMATCH'
  | 'PRESENTATION_BLUEPRINT_INVALID';

export interface PresentationImportError {
  code: PresentationImportErrorCode;
  params: Readonly<Record<string, string | number>>;
}

export type PresentationImportResult<T> =
  { ok: true; value: T } | { ok: false; error: PresentationImportError };

function failure<T>(
  code: PresentationImportErrorCode,
  params: Readonly<Record<string, string | number>>,
): PresentationImportResult<T> {
  return { ok: false, error: { code, params } };
}

function supportedFunctions(value: string): string | null {
  const functions = value.matchAll(/([a-z-]+)\(/gi);
  for (const match of functions) {
    const name = match[1]?.toLowerCase();
    if (name && !SUPPORTED_CSS_FUNCTIONS.has(name)) return name;
  }
  return null;
}

function validateCapture(capture: CaptureBundle): PresentationImportResult<CaptureBundle> {
  const nodeIds = new Set<string>();
  const nodesById = new Map<string, UiCaptureNode>();
  for (const node of capture.nodes) {
    if (nodeIds.has(node.nodeId)) {
      return failure('PRESENTATION_CAPTURE_DUPLICATE_NODE', { nodeId: node.nodeId });
    }
    nodeIds.add(node.nodeId);
    nodesById.set(node.nodeId, node);

    if (!(node.component in CHARACTER_MANAGER_RECIPES)) {
      return failure('PRESENTATION_CAPTURE_UNSUPPORTED_COMPONENT', {
        component: node.component,
        nodeId: node.nodeId,
      });
    }
    for (const property of Object.keys(node.computedStyle)) {
      if (!SUPPORTED_CAPTURE_STYLE_PROPERTY_SET.has(property)) {
        return failure('PRESENTATION_CAPTURE_UNSUPPORTED_STYLE', {
          property,
          nodeId: node.nodeId,
        });
      }
      const unsupportedFunction = supportedFunctions(node.computedStyle[property] ?? '');
      if (unsupportedFunction) {
        return failure('PRESENTATION_CAPTURE_UNSUPPORTED_VALUE', {
          function: unsupportedFunction,
          nodeId: node.nodeId,
          property,
        });
      }
    }
    for (const declaration of node.authoredDeclarations) {
      if (!SUPPORTED_CAPTURE_STYLE_PROPERTY_SET.has(declaration.property)) {
        return failure('PRESENTATION_CAPTURE_UNSUPPORTED_STYLE', {
          property: declaration.property,
          nodeId: node.nodeId,
        });
      }
      const unsupportedFunction = supportedFunctions(declaration.value);
      if (unsupportedFunction) {
        return failure('PRESENTATION_CAPTURE_UNSUPPORTED_VALUE', {
          function: unsupportedFunction,
          nodeId: node.nodeId,
          property: declaration.property,
        });
      }
      for (const condition of declaration.conditions) {
        if (!SUPPORTED_CONDITION_PREFIXES.some((prefix) => condition.startsWith(prefix))) {
          return failure('PRESENTATION_CAPTURE_UNSUPPORTED_CONDITION', {
            condition,
            nodeId: node.nodeId,
          });
        }
      }
    }
  }

  const root = nodesById.get(capture.rootNodeId);
  if (!root || root.component !== 'CharacterManager' || root.parentNodeId !== undefined) {
    return failure('PRESENTATION_CAPTURE_TREE', { rootNodeId: capture.rootNodeId });
  }
  for (const node of capture.nodes) {
    if (node.nodeId === capture.rootNodeId) continue;
    if (!node.parentNodeId || !nodesById.has(node.parentNodeId)) {
      return failure('PRESENTATION_CAPTURE_TREE', { nodeId: node.nodeId });
    }
  }
  for (const component of REQUIRED_COMPONENTS) {
    if (!capture.nodes.some((node) => node.component === component)) {
      return failure('PRESENTATION_CAPTURE_TREE', { missingComponent: component });
    }
  }
  for (const step of capture.actionTrace) {
    if (!nodesById.has(step.nodeId)) {
      return failure('PRESENTATION_CAPTURE_TREE', { actionNodeId: step.nodeId });
    }
  }
  return { ok: true, value: capture };
}

function captureShape(capture: CaptureBundle): string {
  const shape = capture.nodes
    .map((node) => ({
      nodeId: node.nodeId,
      parentNodeId: node.parentNodeId ?? null,
      order: node.order,
      component: node.component,
      binding: node.binding ?? null,
      actions: [...node.actions].sort(),
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  return JSON.stringify(shape);
}

function actionParameter(action: UiActionId): string | undefined {
  switch (action) {
    case 'characters.select':
      return 'characterId';
    case 'characters.search':
      return 'query';
    case 'characters.sort':
      return 'sort';
    case 'characters.view.set':
      return 'view';
    case 'tabs.select':
      return 'tab';
    default:
      return undefined;
  }
}

function buildBlueprintNode(node: UiCaptureNode, nodes: readonly UiCaptureNode[]): UiBlueprintNode {
  const recipe = CHARACTER_MANAGER_RECIPES[node.component];
  if (!recipe) {
    throw new Error(`unsupported component reached blueprint builder: ${node.component}`);
  }
  const children = nodes
    .filter((candidate) => candidate.parentNodeId === node.nodeId)
    .sort((left, right) => left.order - right.order || left.nodeId.localeCompare(right.nodeId))
    .map((child) => buildBlueprintNode(child, nodes));
  return {
    nodeId: node.nodeId,
    component: node.component,
    recipe,
    ...(node.semantic.role ? { role: node.semantic.role } : {}),
    stateSlots: [...new Set(node.states)].sort(),
    actions: node.actions.map((id) => ({
      id,
      ...(actionParameter(id) ? { parameter: actionParameter(id) } : {}),
    })),
    children,
  };
}

/**
 * Strictly imports a compact/medium/expanded Character Manager capture
 * matrix. The output contains no Chromium geometry or CSS values.
 */
export function normalizeCharacterManagerCaptureMatrix(
  input: unknown,
): PresentationImportResult<UiBlueprint> {
  if (!Value.Check(CaptureMatrixSchema, input)) {
    return failure('PRESENTATION_CAPTURE_INVALID', {});
  }
  const matrix = input as CaptureMatrix;
  const classes = new Set<UiViewportClass>();
  let expectedShape: string | null = null;
  let canonical: CaptureBundle | null = null;

  for (const capture of matrix.captures) {
    const checked = validateCapture(capture);
    if (!checked.ok) return checked;
    if (capture.state !== 'populated' && capture.state !== 'selected') {
      return failure('PRESENTATION_CAPTURE_MATRIX_INCOMPLETE', {
        fixtureId: capture.fixtureId,
        state: capture.state,
      });
    }
    classes.add(capture.viewportClass);
    const shape = captureShape(capture);
    if (expectedShape !== null && expectedShape !== shape) {
      return failure('PRESENTATION_CAPTURE_SHAPE_MISMATCH', { fixtureId: capture.fixtureId });
    }
    expectedShape = shape;
    if (capture.viewportClass === 'expanded') canonical = capture;
  }

  for (const viewportClass of ['compact', 'medium', 'expanded'] as const) {
    if (!classes.has(viewportClass)) {
      return failure('PRESENTATION_CAPTURE_MATRIX_INCOMPLETE', { viewportClass });
    }
  }
  if (!canonical)
    return failure('PRESENTATION_CAPTURE_MATRIX_INCOMPLETE', { viewportClass: 'expanded' });

  const bindings = canonical.nodes
    .flatMap((node) => (node.binding ? [{ nodeId: node.nodeId, expression: node.binding }] : []))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const canonicalRoot = canonical.nodes.find((node) => node.nodeId === canonical.rootNodeId);
  if (!canonicalRoot) {
    return failure('PRESENTATION_CAPTURE_TREE', { rootNodeId: canonical.rootNodeId });
  }
  const blueprint: UiBlueprint = {
    format: UI_BLUEPRINT_FORMAT_V1,
    id: 'character-manager',
    root: buildBlueprintNode(canonicalRoot, canonical.nodes),
    responsive: [
      { viewportClass: 'compact', layout: 'compact-panel' },
      { viewportClass: 'medium', layout: 'rail-overlay-panel' },
      { viewportClass: 'expanded', layout: 'rail-resizable-panel' },
    ],
    bindings,
    sourceFixtureIds: matrix.captures.map((capture) => capture.fixtureId).sort(),
  };
  if (!Value.Check(UiBlueprintSchema, blueprint)) {
    return failure('PRESENTATION_BLUEPRINT_INVALID', {});
  }
  return { ok: true, value: blueprint };
}
