---
title: Declarative UI Slots
description: Contribute buttons to stable semantic slots with the declarative api.ui.slots surface.
sidebar_position: 6
---

Declarative semantic UI slots (ТЗ §53) let a plugin contribute **buttons** to
stable, well-known places in the host UI without shipping any markup, styles,
or script into the main window. The host renders the buttons; the plugin only
provides semantics.

## Stable Slot IDs

The slot ids are a frozen contract. Plugins must use exactly one of these five:

| Slot id                    | Where it renders                                     |
| -------------------------- | ---------------------------------------------------- |
| `chat.header.actions`      | Conversation header (next to the character identity) |
| `chat.message.actions`     | Message actions row (next to the built-in actions)   |
| `character.editor.actions` | Character editor action bar                          |
| `settings.section`         | Settings screen, after plugin settings panels        |
| `generation.controls`      | Composer action row (send area)                      |

Unknown ids are rejected with a typed `SLOT_UNKNOWN` error. Do not invent new
slots — a new slot is a cross-agent contract change, not a plugin choice.

## Contributing

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const stop = api.ui.slots.contribute({
      slot: 'chat.header.actions',
      title: 'Export log',
      priority: 50,
      permission: 'chat.read',
      action: { type: 'command', commandId: 'export.log' },
      when: () => document.body.dataset.chatOpen === 'true',
    });
    // stop() removes the button.
  },
});
```

A contribution is pure data:

- `slot` — one of the stable ids.
- `title` — the button label: non-empty, at most 80 characters, no control
  characters. Invalid titles are rejected with a typed `SLOT_TITLE_INVALID`
  error.
- `priority` — lower renders first (default `100`). Equal priorities keep
  registration order.
- `permission` — optional v2 permission (for example `chat.read`). When set,
  the button renders only while the plugin holds that permission; denied
  contributions are hidden, never executed.
- `action` — what the button does when clicked:
  - `{ type: 'command', commandId }` — runs the plugin's command registration
    with that `id` (the same command the command palette runs). The command
    must be registered through `api.ui.commands.register`.
  - `{ type: 'event', event }` — emits an event on the shared event bus; the
    slot context is the payload.
- `when` — optional runtime gate. When it returns `false` the button is
  hidden for that render; a throwing gate is treated as hidden.

`contribute()` returns a cleanup function, like every other registration.
Disabling the plugin removes all of its slot buttons.

## Host Behavior and Fallback

The host re-validates every contribution at the untrusted boundary with the
same rules the SDK enforces, so malformed input from a compromised sandbox is
dropped, never rendered. Buttons are rendered as plain `<button>` elements —
titles are escaped by React and were pre-validated at registration, so
contributed text can never inject markup.

If a slot has no contributions, or every contribution is denied by
permission/`when()`, the host renders **nothing**: the surrounding layout is
unchanged and no error UI is shown. Slots are strictly additive.

## Validation Errors

Validation failures throw `SlotContributionError` with a stable machine-readable
code and `params`:

- `SLOT_UNKNOWN` — `{ slot }`: not one of the stable ids.
- `SLOT_TITLE_INVALID` — `{ reason: 'empty' | 'too-long' | 'control-characters', maxLength? }`.
- `SLOT_INVALID` — `{ reason }`: any other structural violation (priority,
  permission, action, `when`).

See also: [Frontend API](frontend.md) for the imperative registrars, and
[Extension Availability](availability.md) for when plugin surfaces exist at
all.
