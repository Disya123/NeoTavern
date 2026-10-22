/**
 * `PluginVisualSurface` IR schema v1 (ADR-0058; platform doc §11; pulled
 * forward from ADR-0050 Milestone D).
 *
 * A fragment is pure DATA: a versioned, bounded scene-fragment tree the
 * HOST renders with its own components. Plugins ship data and handlers —
 * never markup, pixels or engines. Styling references design tokens by
 * NAME only; raw colors, fonts, spacing numbers or sizes are schema
 * violations, not style hints (AGENTS §14 holds in plugin fragments).
 *
 * Every structural budget is enforced by {@link validateVisualSurfaceFragment}
 * fail-fast with a stable error code — the validator walks the tree with an
 * explicit node-count and depth budget, so an oversized or hostile fragment
 * is rejected in bounded time (AGENTS resource containment). The transport
 * layer additionally enforces `VISUAL_SURFACE_LIMITS.maxFragmentBytes` on the
 * RAW bytes before parsing; this module validates the parsed shape.
 *
 * Host-side guarantees that are NOT schema-level (they live in the host and
 * in docs/plugin-sdk/visual-surface-ir.md): image asset ownership
 * (plugin-staged assets only), permission gating of registered handlers,
 * and crash isolation — a crashing or stalling plugin handler degrades to
 * an honest per-fragment error, never to a host freeze (ADR-0024).
 */
import { KNOWN_PERMISSIONS } from './permissions.js';

/** Current IR version. A fragment carrying any other major version is rejected. */
export const VISUAL_SURFACE_IR_VERSION = 1;

/**
 * Normative v1 budgets. Raising any of these is a versioned IR extension
 * (ADR-0058 §2): either the IR grows through a reviewed version bump, or
 * the host answers with an honest `CAPABILITY_UNAVAILABLE` — never a
 * silent limit change.
 */
export const VISUAL_SURFACE_LIMITS = {
  /** Total nodes per fragment (containers, text, images, buttons, inputs). */
  maxNodes: 256,
  /** Container nesting depth (the root container is depth 1). */
  maxDepth: 8,
  /** Direct children of one container. */
  maxChildrenPerContainer: 32,
  /** Characters per text node. */
  maxTextLength: 2048,
  /** Characters per button label, image alt or input placeholder. */
  maxLabelLength: 256,
  /** Characters per node/action/input/surface identifier. */
  maxIdLength: 128,
  /** RPC handler bindings per fragment. */
  maxActions: 64,
  /** Image nodes per fragment (each decodes to a bounded GPU asset). */
  maxImages: 32,
  /** Input nodes per fragment (each is a FieldId-addressable editor). */
  maxInputs: 32,
  /** Transport-level cap on the serialized fragment (128 KiB). */
  maxFragmentBytes: 131072,
} as const;

/**
 * RPC handler binding: the fragment names a handler the plugin registered
 * over its backend surface; the host invokes it on activation. The
 * fragment never carries code.
 */
export interface VisualSurfaceAction {
  /** Registered handler name (the plugin's RPC surface). */
  rpc: string;
  /**
   * When set, the host renders the bound control only while the plugin
   * holds this v2 permission (e.g. `chat.read`) — the same gate the host
   * applies to registrations. Unknown permissions are rejected.
   */
  permission?: string;
}

export interface VisualSurfaceContainerNode {
  id: string;
  kind: 'container';
  /** Layout direction. Layout is structural — never pixel coordinates. */
  direction: 'row' | 'column';
  /**
   * Spacing between children as a Theme SDK spacing-token NAME
   * (e.g. `space.2`). A raw number is a schema violation (AGENTS §14).
   */
  gap?: string;
  children: VisualSurfaceNode[];
}

export interface VisualSurfaceTextNode {
  id: string;
  kind: 'text';
  text: string;
  /** Semantic text role; the theme resolves tokens per role. */
  variant: 'body' | 'label' | 'heading' | 'code';
}

export interface VisualSurfaceImageNode {
  id: string;
  kind: 'image';
  /** A plugin-staged asset id (`assets.put`); the host enforces ownership. */
  assetId: string;
  /** Accessibility name; an empty alt is an a11y violation. */
  alt: string;
}

export interface VisualSurfaceButtonNode {
  id: string;
  kind: 'button';
  label: string;
  /** The action binding this button activates. */
  actionId: string;
  variant: 'primary' | 'secondary' | 'ghost';
}

export interface VisualSurfaceInputNode {
  id: string;
  kind: 'input';
  /** Host-side FieldId for the single input model (INV-4). */
  inputId: string;
  /** Field type; the host maps it to the platform editor (INV-4). */
  inputType: 'text' | 'password' | 'number';
  placeholder?: string;
  /** Initial value (≤2048 characters). */
  initial?: string;
  /** Host-enforced character cap (1..=4096). */
  maxLength?: number;
  /** Optional action fired on the commit gesture (Enter / blur commit). */
  actionId?: string;
}

export type VisualSurfaceNode =
  | VisualSurfaceContainerNode
  | VisualSurfaceTextNode
  | VisualSurfaceImageNode
  | VisualSurfaceButtonNode
  | VisualSurfaceInputNode;

/**
 * One renderable fragment: a single-rooted, bounded tree plus the RPC
 * bindings its controls activate. The host re-validates everything at the
 * untrusted boundary before a single node is built.
 */
export interface VisualSurfaceFragment {
  irVersion: number;
  /**
   * Reverse-DNS surface id namespaced under the manifest id
   * (e.g. `author.plugin-name.viewer`). Stable across plugin updates.
   */
  surfaceId: string;
  /** Where the host may render the fragment (closed v1 set, ADR-0022). */
  placement: VisualSurfacePlacement;
  /** Host-rendered header title, ≤256 characters. */
  title: string;
  /** Exactly one root container (bounds/z-order stay host-owned). */
  root: VisualSurfaceContainerNode;
  /** RPC bindings referenced by buttons/inputs. */
  actions: Record<string, VisualSurfaceAction>;
}

export type VisualSurfacePlacement = 'sidebar' | 'panel';

/** Stable machine-readable codes for fragment validation failures. */
export type VisualSurfaceErrorCode =
  | 'IR_VERSION_UNSUPPORTED'
  | 'SURFACE_ID_INVALID'
  | 'PLACEMENT_UNKNOWN'
  | 'TITLE_INVALID'
  | 'FRAGMENT_INVALID'
  | 'NODE_KIND_UNKNOWN'
  | 'NODE_ID_INVALID'
  | 'NODE_ID_DUPLICATE'
  | 'TREE_TOO_DEEP'
  | 'TOO_MANY_NODES'
  | 'TOO_MANY_CHILDREN'
  | 'TEXT_TOO_LONG'
  | 'LABEL_TOO_LONG'
  | 'ACTION_UNKNOWN'
  | 'TOO_MANY_ACTIONS'
  | 'RPC_NAME_INVALID'
  | 'PERMISSION_UNKNOWN'
  | 'ASSET_ID_INVALID'
  | 'INPUT_TOO_LONG'
  | 'GAP_TOKEN_INVALID';

/**
 * Typed validation error (AGENTS §5): stable `code` plus structured
 * `params`, never a ready-made human string.
 */
export class VisualSurfaceError extends Error {
  readonly code: VisualSurfaceErrorCode;
  readonly params: Record<string, unknown>;

  constructor(code: VisualSurfaceErrorCode, params: Record<string, unknown> = {}) {
    super(`visual surface fragment rejected: ${code}`);
    this.name = 'VisualSurfaceError';
    this.code = code;
    this.params = params;
  }
}

const SURFACE_ID_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?){1,7}$/u;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u;
/** Theme SDK token NAME: dotted lowercase namespace, e.g. `space.2`. */
const TOKEN_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9]*){1,4}$/u;
const RPC_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
// C0/C1 control characters never render honestly — the constructor form
// avoids the literal-regex lint (same pattern as frontend.ts).
// eslint-disable-next-line no-control-regex -- string validation needs the C0/C1 range; the constructor form avoids the literal-regex lint
const CONTROL_CHARACTER_RE = new RegExp('[\u0000-\u001f\u007f]', 'u');

const TEXT_VARIANTS: ReadonlySet<string> = new Set(['body', 'label', 'heading', 'code']);
const BUTTON_VARIANTS: ReadonlySet<string> = new Set(['primary', 'secondary', 'ghost']);
const INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'password', 'number']);
const PLACEMENTS: ReadonlySet<string> = new Set(['sidebar', 'panel']);
const NODE_KINDS: ReadonlySet<string> = new Set(['container', 'text', 'image', 'button', 'input']);

interface Budget {
  nodes: number;
  images: number;
  inputs: number;
  ids: Set<string>;
}

function fail(code: VisualSurfaceErrorCode, params: Record<string, unknown> = {}): never {
  throw new VisualSurfaceError(code, params);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  max: number,
  code: VisualSurfaceErrorCode,
  params: Record<string, unknown> = {},
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(code, { ...params, length: typeof value === 'string' ? value.length : null, max });
  }
  if (CONTROL_CHARACTER_RE.test(value)) {
    fail(code, { ...params, reason: 'control-character' });
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  max: number,
  code: VisualSurfaceErrorCode,
  params: Record<string, unknown> = {},
): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, max, code, params);
}

/** Validates one node against the budget; recurses only while depth allows. */
function validateNode(value: unknown, depth: number, budget: Budget): VisualSurfaceNode {
  if (!isRecord(value)) fail('FRAGMENT_INVALID', { reason: 'node-not-object' });
  const kind = value['kind'];
  if (typeof kind !== 'string' || !NODE_KINDS.has(kind)) {
    fail('NODE_KIND_UNKNOWN', { kind: typeof kind === 'string' ? kind : null });
  }
  budget.nodes += 1;
  if (budget.nodes > VISUAL_SURFACE_LIMITS.maxNodes) {
    fail('TOO_MANY_NODES', { max: VISUAL_SURFACE_LIMITS.maxNodes });
  }
  if (depth > VISUAL_SURFACE_LIMITS.maxDepth) {
    fail('TREE_TOO_DEEP', { depth, max: VISUAL_SURFACE_LIMITS.maxDepth });
  }
  const id = boundedString(value['id'], VISUAL_SURFACE_LIMITS.maxIdLength, 'NODE_ID_INVALID', {
    field: 'id',
  });
  if (!NODE_ID_PATTERN.test(id)) fail('NODE_ID_INVALID', { id });
  if (budget.ids.has(id)) fail('NODE_ID_DUPLICATE', { id });
  budget.ids.add(id);

  switch (kind) {
    case 'container': {
      const direction = value['direction'];
      if (direction !== 'row' && direction !== 'column') {
        fail('FRAGMENT_INVALID', { reason: 'direction', direction: direction ?? null });
      }
      let gap: string | undefined;
      if (value['gap'] !== undefined) {
        if (typeof value['gap'] !== 'string' || !TOKEN_NAME_PATTERN.test(value['gap'])) {
          fail('GAP_TOKEN_INVALID', { gap: value['gap'] ?? null });
        }
        gap = value['gap'];
      }
      const rawChildren = value['children'];
      if (!Array.isArray(rawChildren)) fail('FRAGMENT_INVALID', { reason: 'children-not-array' });
      if (rawChildren.length > VISUAL_SURFACE_LIMITS.maxChildrenPerContainer) {
        fail('TOO_MANY_CHILDREN', {
          count: rawChildren.length,
          max: VISUAL_SURFACE_LIMITS.maxChildrenPerContainer,
        });
      }
      const children = rawChildren.map((child) => validateNode(child, depth + 1, budget));
      return { id, kind: 'container', direction, gap, children };
    }
    case 'text': {
      const text = boundedString(
        value['text'],
        VISUAL_SURFACE_LIMITS.maxTextLength,
        'TEXT_TOO_LONG',
        { field: 'text' },
      );
      const variant = value['variant'];
      if (typeof variant !== 'string' || !TEXT_VARIANTS.has(variant)) {
        fail('FRAGMENT_INVALID', { reason: 'variant', variant: variant ?? null });
      }
      return {
        id,
        kind: 'text',
        text,
        variant: variant as VisualSurfaceTextNode['variant'],
      };
    }
    case 'image': {
      budget.images += 1;
      if (budget.images > VISUAL_SURFACE_LIMITS.maxImages) {
        fail('TOO_MANY_NODES', { field: 'images', max: VISUAL_SURFACE_LIMITS.maxImages });
      }
      const assetId = value['assetId'];
      if (typeof assetId !== 'string' || !UUID_PATTERN.test(assetId)) {
        fail('ASSET_ID_INVALID', { assetId: typeof assetId === 'string' ? assetId : null });
      }
      const alt = boundedString(
        value['alt'],
        VISUAL_SURFACE_LIMITS.maxLabelLength,
        'LABEL_TOO_LONG',
        { field: 'alt' },
      );
      return { id, kind: 'image', assetId, alt };
    }
    case 'button': {
      const label = boundedString(
        value['label'],
        VISUAL_SURFACE_LIMITS.maxLabelLength,
        'LABEL_TOO_LONG',
        { field: 'label' },
      );
      const actionId = value['actionId'];
      if (typeof actionId !== 'string' || !NODE_ID_PATTERN.test(actionId)) {
        fail('ACTION_UNKNOWN', { actionId: typeof actionId === 'string' ? actionId : null });
      }
      const variant = value['variant'];
      if (typeof variant !== 'string' || !BUTTON_VARIANTS.has(variant)) {
        fail('FRAGMENT_INVALID', { reason: 'variant', variant: variant ?? null });
      }
      return {
        id,
        kind: 'button',
        label,
        actionId,
        variant: variant as VisualSurfaceButtonNode['variant'],
      };
    }
    default: {
      budget.inputs += 1;
      if (budget.inputs > VISUAL_SURFACE_LIMITS.maxInputs) {
        fail('TOO_MANY_NODES', { field: 'inputs', max: VISUAL_SURFACE_LIMITS.maxInputs });
      }
      const inputId = boundedString(
        value['inputId'],
        VISUAL_SURFACE_LIMITS.maxIdLength,
        'NODE_ID_INVALID',
        { field: 'inputId' },
      );
      const inputType = value['inputType'];
      if (typeof inputType !== 'string' || !INPUT_TYPES.has(inputType)) {
        fail('FRAGMENT_INVALID', { reason: 'inputType', inputType: inputType ?? null });
      }
      const placeholder = optionalBoundedString(
        value['placeholder'],
        VISUAL_SURFACE_LIMITS.maxLabelLength,
        'LABEL_TOO_LONG',
        { field: 'placeholder' },
      );
      const initial = optionalBoundedString(
        value['initial'],
        VISUAL_SURFACE_LIMITS.maxTextLength,
        'INPUT_TOO_LONG',
        { field: 'initial' },
      );
      let maxLength: number | undefined;
      if (value['maxLength'] !== undefined) {
        if (
          typeof value['maxLength'] !== 'number' ||
          !Number.isInteger(value['maxLength']) ||
          value['maxLength'] < 1 ||
          value['maxLength'] > 4096
        ) {
          fail('INPUT_TOO_LONG', { maxLength: value['maxLength'] ?? null, max: 4096 });
        }
        maxLength = value['maxLength'];
      }
      let actionId: string | undefined;
      if (value['actionId'] !== undefined) {
        if (typeof value['actionId'] !== 'string' || !NODE_ID_PATTERN.test(value['actionId'])) {
          fail('ACTION_UNKNOWN', { actionId: value['actionId'] ?? null });
        }
        actionId = value['actionId'];
      }
      return {
        id,
        kind: 'input',
        inputId,
        inputType: inputType as VisualSurfaceInputNode['inputType'],
        placeholder,
        initial,
        maxLength,
        actionId,
      };
    }
  }
}

function checkActionRefs(
  node: VisualSurfaceNode,
  actions: Record<string, VisualSurfaceAction>,
): void {
  switch (node.kind) {
    case 'container': {
      for (const child of node.children) checkActionRefs(child, actions);
      return;
    }
    case 'button': {
      if (!(node.actionId in actions)) fail('ACTION_UNKNOWN', { actionId: node.actionId });
      return;
    }
    case 'input': {
      if (node.actionId !== undefined && !(node.actionId in actions)) {
        fail('ACTION_UNKNOWN', { actionId: node.actionId });
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Validate one fragment at the untrusted boundary. Fail-fast: the first
 * violation throws a {@link VisualSurfaceError} with a stable code; no
 * host structure is built from an invalid fragment. Returns a normalized
 * copy.
 */
export function validateVisualSurfaceFragment(def: unknown): VisualSurfaceFragment {
  if (!isRecord(def)) fail('FRAGMENT_INVALID', { reason: 'fragment-not-object' });

  const version = def['irVersion'];
  if (version !== VISUAL_SURFACE_IR_VERSION) {
    fail('IR_VERSION_UNSUPPORTED', {
      irVersion: typeof version === 'number' ? version : null,
      supported: VISUAL_SURFACE_IR_VERSION,
    });
  }

  const surfaceId = def['surfaceId'];
  if (
    typeof surfaceId !== 'string' ||
    surfaceId.length > VISUAL_SURFACE_LIMITS.maxIdLength ||
    !SURFACE_ID_PATTERN.test(surfaceId)
  ) {
    fail('SURFACE_ID_INVALID', { surfaceId: typeof surfaceId === 'string' ? surfaceId : null });
  }

  const placement = def['placement'];
  if (typeof placement !== 'string' || !PLACEMENTS.has(placement)) {
    fail('PLACEMENT_UNKNOWN', { placement: placement ?? null });
  }

  const title = boundedString(def['title'], VISUAL_SURFACE_LIMITS.maxLabelLength, 'TITLE_INVALID');

  const rawActions = def['actions'];
  if (!isRecord(rawActions)) fail('FRAGMENT_INVALID', { reason: 'actions-not-object' });
  const actionIds = Object.keys(rawActions);
  if (actionIds.length > VISUAL_SURFACE_LIMITS.maxActions) {
    fail('TOO_MANY_ACTIONS', { count: actionIds.length, max: VISUAL_SURFACE_LIMITS.maxActions });
  }
  const actions: Record<string, VisualSurfaceAction> = {};
  for (const actionId of actionIds) {
    if (!NODE_ID_PATTERN.test(actionId)) fail('ACTION_UNKNOWN', { actionId });
    const binding = rawActions[actionId];
    if (!isRecord(binding)) fail('FRAGMENT_INVALID', { reason: 'action-not-object', actionId });
    const rpc = binding['rpc'];
    if (typeof rpc !== 'string' || !RPC_NAME_PATTERN.test(rpc)) {
      fail('RPC_NAME_INVALID', { actionId, rpc: typeof rpc === 'string' ? rpc : null });
    }
    let permission: string | undefined;
    if (binding['permission'] !== undefined) {
      if (
        typeof binding['permission'] !== 'string' ||
        !KNOWN_PERMISSIONS.has(binding['permission'])
      ) {
        fail('PERMISSION_UNKNOWN', {
          actionId,
          permission: typeof binding['permission'] === 'string' ? binding['permission'] : null,
        });
      }
      permission = binding['permission'];
    }
    actions[actionId] = permission === undefined ? { rpc } : { rpc, permission };
  }

  const budget: Budget = { nodes: 0, images: 0, inputs: 0, ids: new Set() };
  const root = validateNode(def['root'], 1, budget);
  if (root.kind !== 'container') fail('FRAGMENT_INVALID', { reason: 'root-not-container' });

  // Every referenced action must be bound: a dangling button would fake
  // interactivity the host cannot deliver.
  checkActionRefs(root, actions);

  return {
    irVersion: VISUAL_SURFACE_IR_VERSION,
    surfaceId,
    placement: placement as VisualSurfacePlacement,
    title,
    root,
    actions,
  };
}

/**
 * Structural census of a validated fragment — the numbers the host quota
 * review (docs/plugin-sdk/visual-surface-ir.md) reports per fragment.
 */
export function visualSurfaceStats(fragment: VisualSurfaceFragment): {
  nodes: number;
  depth: number;
  images: number;
  inputs: number;
  actions: number;
} {
  let nodes = 0;
  let depth = 0;
  let images = 0;
  let inputs = 0;
  const walk = (node: VisualSurfaceNode, level: number): void => {
    nodes += 1;
    if (level > depth) depth = level;
    if (node.kind === 'image') images += 1;
    if (node.kind === 'input') inputs += 1;
    if (node.kind === 'container') {
      for (const child of node.children) walk(child, level + 1);
    }
  };
  walk(fragment.root, 1);
  return { nodes, depth, images, inputs, actions: Object.keys(fragment.actions).length };
}
