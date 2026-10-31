# PluginVisualSurface IR v1 — schema and security review

Status: **Accepted; amended by ADR-0059** (originally the ADR-0057 Phase 2
gate item). The schema survives the pivot as the versioned plugin-UI data
contract; **host rendering of IR fragments is not shipped** — it binds to
whatever native surface is actually built (none today:
`crates/neocompositor` is experimental). The schema of record is
[`packages/plugin-sdk/src/visual-surface.ts`](../../packages/plugin-sdk/src/visual-surface.ts);
this document is the security review the platform gate requires
([ADR-0058](../adr/0058-no-web-plugin-ir-platform.md) as amended by ADR-0059;
historical gate context:
[native-presentation-platform.md §11](../architecture/native-presentation-platform.md)).
Normative vocabulary: the fragment is data, the host renders. Plugins ship
data and handlers — never markup, pixels or engines.

## What ships in v1

- One versioned fragment envelope: `irVersion`, reverse-DNS `surfaceId`
  namespaced under the manifest id, `placement` (`sidebar` | `panel`), a
  bounded `title`, exactly one root `container`, and an `actions` map
  binding control ids to the plugin's registered RPC handler names.
- Five node kinds: `container` (row/column, gap = Theme SDK token name),
  `text` (semantic variant), `image` (plugin-staged asset id + alt),
  `button` (label + action binding + variant), `input` (FieldId-addressable,
  typed, with an optional commit action).
- `validateVisualSurfaceFragment()` — fail-fast validation with stable
  error codes, applied by the plugin before submission and re-applied by
  the host at the untrusted boundary. `visualSurfaceStats()` reports the
  census the host quota accounting uses.
- What v1 deliberately does NOT have: no free-form layout (no coordinates,
  sizes, colors, fonts, z-order), no script/code nodes, no links/navigation,
  no nesting host views, no plugin-initiated modals. Extending the IR is a
  reviewed version bump (ADR-0058 §2); a plugin needing more than v1 gets
  an honest `CAPABILITY_UNAVAILABLE`, never a hidden engine.

## Security review

### 1. Bounds (size limits)

| Bound                                         | Value                       | Enforcement                                                                                   |
| --------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| Serialized fragment bytes                     | 128 KiB                     | Transport layer, on the RAW bytes before parsing; schema constant `maxFragmentBytes` names it |
| Text node content                             | 2048 chars                  | Schema (`TEXT_TOO_LONG`)                                                                      |
| Label/alt/placeholder/title                   | 256 chars                   | Schema (`LABEL_TOO_LONG`/`TITLE_INVALID`)                                                     |
| Identifiers (node/action/input/surface)       | 128 chars + charset pattern | Schema (`NODE_ID_INVALID`/`SURFACE_ID_INVALID`)                                               |
| Input initial value / host-enforced maxLength | 2048 chars / 1..4096        | Schema (`INPUT_TOO_LONG`)                                                                     |
| Control characters in any string              | rejected                    | Schema (`*_INVALID` with `reason: control-character`)                                         |

Charset patterns close the injection surface that free-form strings have in
HTML contours: a fragment has no markup channel, so the residual risk is
rendering hostile text, which the host text pipeline already treats as data
(bidi isolation, no HTML interpretation, token-only styling).

### 2. Counts (structural budgets)

| Budget                 | Value                             | Failure code                       |
| ---------------------- | --------------------------------- | ---------------------------------- |
| Nodes per fragment     | 256                               | `TOO_MANY_NODES`                   |
| Nesting depth          | 8                                 | `TREE_TOO_DEEP`                    |
| Children per container | 32                                | `TOO_MANY_CHILDREN`                |
| Image nodes            | 32 (each is a bounded GPU decode) | `TOO_MANY_NODES` (`field: images`) |
| Input nodes            | 32 (each is a FieldId editor)     | `TOO_MANY_NODES` (`field: inputs`) |
| Action bindings        | 64                                | `TOO_MANY_ACTIONS`                 |

The validator reads a container's child count BEFORE recursing, so a
million-child array is rejected without walking it (behaviorally tested);
depth-capped recursion bounds the stack. The node budget counts DURING the
walk, so any tree whose census exceeds 256 fails mid-traversal. Dangling
action references fail (`ACTION_UNKNOWN`): a fragment may never fake
interactivity the host cannot deliver. Unknown IR versions fail closed
(`IR_VERSION_UNSUPPORTED`) — the host never best-effort renders a fragment
it does not fully understand.

### 3. Permissions

- The fragment carries NO data access. Everything a control does goes
  through a named RPC binding, and the host applies the plugin's granted
  permissions when invoking that handler — exactly the gate that applies
  to every other registration (install/update consent, re-consent on new
  permissions, ТЗ §7.4).
- A binding may declare a `permission` from the stable permission list
  (`KNOWN_PERMISSIONS` only; scoped strings like `network:*` are rejected
  on nodes). The host renders such controls only while the grant holds,
  so a plugin cannot advertise a control it is not allowed to act through.
- Image nodes reference plugin-staged assets (`assets.put`) by UUID. The
  schema validates the format; the HOST validates OWNERSHIP at render —
  a fragment cannot address another plugin's assets or user files.
- No fragment node reads chat content, secrets, the filesystem or the
  network directly; the two-step "fragment shows a control, handler does
  the work" keeps every data path inside the audited backend surface.

### 4. Crash isolation

- The host builds host-owned render structures only from a fragment that
  passed validation, and one fragment's failure is an honest per-fragment
  error (the surface shows the stable error code), never a host freeze —
  ADR-0024 isolation semantics, platform doc §11.
- An RPC handler that crashes, stalls or returns garbage degrades the same
  way: the control's activation reports the stable error; the fragment,
  the slot and the rest of the host keep working. Timeouts apply to every
  handler invocation (no unbounded awaits in the render path).
- Plugin disable/uninstall unregisters the fragment's surface id and its
  handlers; nothing remains rendered (AGENTS §17 cleanup rules apply to
  IR surfaces like every registration).
- The renderer consumes only the validated, normalized copy — the host
  never re-reads plugin-mutable state mid-render (no TOCTOU between
  validation and rendering of the same object).

### 5. Cross-cutting platform rules (normative, platform doc §11)

Styling references tokens by name only (a raw color/spacing number is a
schema violation — `GAP_TOKEN_INVALID` is the v1 instance of that rule);
input flows through the single input model (INV-4) with FieldId-addressable
fields; accessibility exports through the same semantic tree as product
nodes; z-order stays under host chrome (ADR-0022 — hence the closed
`placement` set and the single-root rule, no overlaying fragments).

## Status honesty

This slice ships the **schema and its validation** (ADR-0057 Phase 2 gate:
"IR schema v1 + security review"). Host rendering of IR fragments, the RPC
invocation plumbing and the conformance scenarios are the Phase 3 deliver
("plugin-slot scenarios in the conformance corpus"); until they land, no
document or code may claim IR-based plugin surfaces as shipped (ADR-0058 §6
transitional-truth rule).
