---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/adr/0039-legacy-compatibility-authority-boundary.md
---

# ADR-0039: Legacy Compatibility Authority Boundary

Date: 2026-08-13. Status: Accepted (Architecture Convergence, Milestone 1 / Wave 0).
Related documents: [Target architecture ТЗ 10/10 rev2 §14](https://github.com/Disya123/NeoTavern/blob/main/NeoTavern_architecture_10_of_10_spec_2026-08-13.md),
[ADR-0038](0038-canonical-rust-kernel-core.md), [ADR-0027](0027-plugin-node-universal-runtime.md),
[ADR-0028](0028-ses-bootstrap-tcb.md), [ADR-0037](0037-extension-hardening.md),
[Plugin SDK](../plugin-sdk/README.md), [Legacy compatibility](../plugin-sdk/README.md).

## Context

NeoTavern keeps SillyTavern-era plugin compatibility (window globals,
`eventSource`, `extension_settings`, jQuery islands, an Express compatibility
host under `/api/plugins/{id}/...`) while the canonical product core moves to
the Rust Kernel (ADR-0038). Without a hard boundary, legacy/plugin code could
be tempted to reach the canonical database, the secret store or kernel
internals directly — either "to make a plugin work" or through a convenience
bypass. Any such path would reintroduce a second writer and expand the trust
surface of untrusted extension code.

The previous approach (ADR-0007/0027/0037) already isolates plugin execution
(sandboxed iframe, Worker + SES Compartment, capability broker), but there was
no explicit authority rule for the _legacy compatibility layer itself_: the
rule that compatibility may translate or restrict but never _grant more
authority_ than the corresponding native capability, and the list of
unconditional prohibitions that user consent, debug mode or a high-risk grant
cannot lift.

## Decision

- **Authority rule.** Legacy compatibility MAY translate or restrict an
  operation, but MUST NOT grant more authority than the corresponding native
  capability:

  > Legacy compatibility MAY translate or restrict an operation, but MUST NOT
  > grant more authority than the corresponding native capability.

- **Three compatibility tiers** (ТЗ §14.2.1):

  | Tier                         | Implementation                                                                                                      | Status                     |
  | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------- |
  | Native compatible            | Legacy API translated into ordinary Product Wire/capability calls                                                   | Fully supported            |
  | Sandbox compatible           | Plugin runs isolated, sees only the broker, scoped VFS and granted capabilities                                     | Supported with limitations |
  | Architecturally incompatible | Requires raw canonical SQL, kernel internals, unrestricted secrets, a hidden superuser or a single-writer violation | Unsupported                |

  NeoTavern does not promise 100% compatibility with all SillyTavern
  extensions; it promises predictable compatibility of a documented class of
  extensions without changing NeoTavern's trust boundaries.

- **Unconditional prohibitions** (ТЗ §14.2.2) for all legacy/plugin code —
  user consent, debug mode and high-risk grants CANNOT lift them:

  - canonical `database.sqlite`, its WAL/SHM and any storage connection;
  - `SecretStore` and its backing files/vault APIs;
  - kernel internals, repositories and in-process memory;
  - another plugin's data;
  - any hidden `legacy.superuser`-style capability;
  - bypassing Product Wire to mutate product data.

  If a plugin needs characters/chats/messages, the only path is
  `Legacy API → Compatibility adapter → Native capability / Product Wire →
Application service → Canonical storage adapter`. If a legacy operation
  cannot be expressed through native capabilities, either a minimal public
  capability is added to the Plugin SDK through an ADR/security review, or the
  operation is marked unsupported. Creating an unrestricted legacy bypass is
  forbidden.

- **Scoped virtual filesystem.** `plugin.storage` gives a plugin private
  storage (`plugins/<plugin-id>/plugin.sqlite`, KV or files — a host adapter
  detail that never opens the data root). The legacy filesystem API is
  translated into a scoped VFS:

  ```text
  /data/extensions/<plugin-id>/cache.json
  → PluginFs capability
  → <data-root>/plugin-data/<plugin-id>/cache.json
  ```

  The VFS enforces path normalization, traversal/symlink protection, quota,
  atomic writes, cleanup and namespace isolation. Canonical DB paths, secret
  paths, other plugins' namespaces and arbitrary user home are absent from the
  namespace. High-risk consent is limited to: network access to arbitrary
  public hosts; picker-scoped filesystem access to a user-selected file or
  directory; process execution on Desktop behind a command allowlist/policy;
  and the legacy frontend unmanaged island. Even these grants never confer
  canonical SQL, unrestricted home access or secret reading.

- **The compatibility adapter is not a second core.** It contains no product
  repositories, no prompt pipeline, no own character/chat/message rules, no
  writer of canonical data and no transport-specific product behavior. Its
  job: parse the legacy request, validate, translate, invoke the native
  capability, translate response/error/event, apply additional restrictions.
  Monkey-patching internal React/Rust/Node objects, depending on incidental
  CSS classes and arbitrary process modification are architecturally
  incompatible unless covered by a separate stable public contract.

- **Permanent compatibility vs migration shims.** `packages/legacy-compat/`
  is the long-lived public `ST Compatibility API v1` with its own semver,
  support matrix and conformance suite (ARC-09 does not apply to it
  automatically). `packages/migration-shims/` holds temporary bridges —
  `legacyRaw`, old DTO translation, dual routes, old schema readers and
  conversion bridges — each with an owner, an issue, a removal milestone and a
  CI-enforced expiry (ARC-09). Each release publishes `fully supported`,
  `supported with limitations` and `unsupported` legacy contracts/plugins.

- **Per-legacy-API mapping.** Every legacy API entry documents: supported
  contract, exact mapping to one or more native capabilities/Product Wire
  operations, host availability, sandbox/isolation level, compatibility test,
  security/resource limits, and support/versioning policy. The mapping lives
  in `packages/legacy-compat/COMPATIBILITY.md` and is enforced by a capability
  mapping test (ARC-11): a legacy call must never reach canonical SQL, the
  SecretStore or kernel internals, even under a high-risk consent.

## Alternatives

- **No boundary, best-effort compatibility.** Rejected: it would let legacy
  code grow unchecked authority, reintroduce a second writer and invalidate
  the whole Kernel single-writer architecture (ADR-0038).
- **Full legacy removal now.** Rejected: SillyTavern plugin compatibility is a
  stated project priority (AGENTS.md §1) and the migration program removes the
  legacy core gradually (ТЗ §20 stages).
- **Superuser capability gated by consent.** Rejected explicitly: consent
  cannot override the unconditional prohibitions (ТЗ §14.2.2).

## Consequences

- Legacy/plugin code can never become a second data owner; authority grows
  only through the public Plugin SDK, which is itself reviewed.
- Some SillyTavern extensions (those requiring raw SQL, unrestricted
  processes or secret access) are unsupported by design and documented as
  architecturally incompatible, not as Kernel defects.
- Migration shims are temporary by construction and expire in CI.
- The compatibility conformance suite (ARC-11) is a release gate; it must be
  extended whenever a legacy API entry is added or changed.
