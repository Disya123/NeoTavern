When editing, the textarea automatically expands to the full height of the message text, as in ST1; there is no internal scrolling.

NeoTavern UX specification

## Connection profiles

Provider connection profiles are managed on the **API** tab in AI Settings:
select or create a profile, configure the source, model, and keys, then use
**Connect** to persist and activate it. The legacy ST1-style Connection
Profiles manager remains available through the API for compatibility, but it is
not exposed as a separate UI tab.

Status: **normative target document** for the first stable version.

This document describes the NeoTavern user experience: interface structure,
key scenarios, states, accessibility requirements, and acceptance criteria. It
does not claim that all the listed features are already implemented. Technical
contracts remain primarily in the technical specification, while visual theme
contracts are in the [Theme SDK](../theme-sdk/README.md).

## 1. Product goal

NeoTavern must let a person install the app without a terminal, connect a local
or remote AI provider, import existing data, and start chatting without needing
to understand the application architecture.

Core UX principle: complexity is available on demand, but it does not get in
the way of the basic scenario "choose a character → write a message → get a
reply".

## 2. UX goals

1. The first local chat starts within 5 minutes of installation, provided the
   provider is already available.
2. Going to the most recent chat in daily use takes at most two actions after
   opening the app.
3. The user always understands:
   - where their data is stored;
   - which provider and model are active;
   - whether generation is in progress;
   - whether the message was saved;
   - what will be deleted, replaced, or sent to an external system.
4. A provider, plugin, theme, or import error must not render the interface
   unusable.
5. Core scenarios are fully accessible via keyboard, screen reader, and touch
   screen.
6. The interface stays responsive on large local libraries and long chats.

## 3. Non-goals

The first stable version is not required to:

- automatically translate user content;
- hide technical capabilities from experienced users;
- reproduce the current SillyTavern interface pixel-for-pixel;
- guarantee that extensions depending on private DOM or CSS details keep
  working;
- provide a fully standalone mobile build with local Node.js;
- sync user data through a mandatory cloud.

## 4. User groups

### 4.1. New user

Wants to start chatting quickly; is unfamiliar with the terms prompt pipeline,
tokenizer, instruct format, and context shifting. Needs safe defaults,
step-by-step provider setup, and understandable errors.

### 4.2. Current SillyTavern user

Migrates a large library of characters, chats, presets, lorebooks, plugins, and
themes. Needs a pre-import check, a compatibility report, preservation of
unknown metadata, and the ability to repeat the import without duplicates.

### 4.3. Experienced local user

Works with local models, multiple providers, instruct formats, and large
contexts. Needs quick switches, prompt diagnostics, and control over the token
budget.

### 4.4. Plugin or theme author

Tests extensions, permissions, lifecycle, cleanup, localization, and different
shells. Needs stable slots, predictable states, and safe mode.

### 4.5. Mobile interface user

Connects to the backend on a computer or home server. Needs comfortable
one-handed operation, resilience to the on-screen keyboard, and connection
recovery.

## 5. Interaction principles

### 5.1. Local-first must be visible

- Local data is available without a cloud account.
- Before data is first sent to a new external provider, a clear explanation is
  shown.
- API keys are never displayed in full after being saved.
- Export, backup, and diagnostics explicitly describe the contents of the file
  being created.

### 5.2. Progressive disclosure of complexity

- Primary actions live on the first level of the interface.
- Advanced options are grouped and collapsed by default.
- Terms come with a brief explanation or a link to help.
- Dangerous settings are not mixed with everyday ones.

### 5.3. Context matters more than the number of elements

- Only actions applicable to the selected object are shown on screen.
- Secondary operations live in the context menu or the command palette.
- A card or panel is used only when it explains a grouping or a distinct
  surface level.

### 5.4. Predictable saving

- Autosave is accompanied by "saving", "saved", and "failed to save" states.
- Closing a screen must not silently lose entered text.
- Unsaved editorial content uses an exit confirmation or a local draft.

### 5.5. Reversibility

- Deletion of user data goes through the trash bin where possible, or provides
  an undo.
- An irreversible action requires confirmation with the exact object name and a
  description of the consequences.
- Cancelling generation, import, export, and other long-running operations is
  available while they run.

## 6. Information architecture

The base shell provides the following top-level sections:

```text
Home / continue
├── Characters
├── Chats
├── Search
├── Create
├── Providers
├── Plugins and themes
└── Settings
    ├── Profile and personas
    ├── Generation
    ├── Interface
    ├── Data and backup
    ├── Connection and privacy
    ├── Accessibility
    └── Diagnostics
```

A shell theme may change the arrangement of areas but must not:

- hide the path to settings, safe mode, and the active provider;
- change the meaning of system actions;
- break the focus order;
- remove access to the main sections;
- use color as the only carrier of state.

### 6.1. Chat-first start screen

Current Home behavior adds a cross-character recent-chat block above the chat
canvas. It requests eight chats with `sort=recent`, renders an ST1-style
vertical list (three rows initially, expandable to eight), and opens the exact
`/chats/:chatId` route. Rows expose stable `data-component`/`data-part` hooks
and use theme tokens only. Settings -> General includes the local
`openHomeOnLoad` preference, enabled by default; it redirects only a bare-root
initial load to `/home`, preserves boot/safe-mode parameters, and does not
intercept OAuth callbacks, deep links (e.g. `/chats/:chatId`), system surfaces
or later SPA navigation.
The Home chrome keeps a `NeoTavern <version>` product row above this block and
exposes Docs, GitHub, and Discord as safe external links. The recent-chat
heading uses an X control instead of an All chats link; after dismissal, a
compact disclosure control restores the block without reloading the route.

After launch, `Home` opens instead of the catalog. The screen shows the pinned
character and its authored greeting as the first assistant message in the
regular feed with a name and avatar, rather than as empty-state text. If the
card has multiple greetings (`firstMessage` + `alternateGreetings`), a pager
`‹ N/M ›` and horizontal swipe are available below the message; the selected
index is passed to `POST /chats` as `greetingIndex` and stored in the first
message's meta. The message viewport keeps horizontal padding on phone and
desktop. If no greeting exists, an empty conversation thread with an available
composer is shown. If no character is pinned yet, the most recently modified
character is used; the choice can be replaced from the catalog. Pinning is a
local UI preference and does not change the character card.

The delayed-create rule below applies to the direct Home composer. Selecting a
character in the sidebar or route-aware catalog instead continues that
character's most recently updated chat; when none exists, exactly one chat is
created while the character preview remains open.

A chat is created on the backend only after the first non-empty message is
sent. Thus, browsing Home and switching the pinned character do not create
empty chats. The first message is carried over into the created chat and sent
without re-entering.

The start screen's visual shell is chat-first:

- the character and the conversation context are visible before the composer;
- the greeting uses the same message component as a saved chat; in the Home
  empty-chat it fills the viewport without an outer row margin;
- the compact header shows only the avatar, name, and search button; search
  expands within the header, searches the current conversation, and highlights
  matches directly in the messages;
- the composer stays accessible while scrolling and when the on-screen keyboard
  appears;
- phone and desktop keep a compact navigation rail with icons and accessible
  text labels;
- the rail's context panel occupies a separate column on desktop and becomes a
  drawer over the chat on phone; it closes on Escape;
- the background image is not part of a React component and is provided by the
  theme.

### 6.2. Single primary screen

The chat workspace is the app's only primary screen. The URLs `/home` and
`/chats/:chatId` mount the chat canvas; catalogs and system tools do not
replace it.

`/characters`, `/chats`, `/providers`, `/themes`, `/plugins`, and
`/plugins/:pluginId/*` are route-aware modal surfaces. When they open, the
current chat, scroll position, and session-only draft stay mounted beneath the
modal layer. Closing, Escape, and Back restore the previous focus and the same
chat. A direct deep link opens the requested surface over `/home`.

The navigation rail and the Plugin SDK may open only a context panel, a dialog,
or a system modal surface. A separate management page in the main outlet
violates the shell contract.

## 7. Global navigation

### 7.1. Desktop

- Persistent or collapsible primary navigation.
- The main area fills the available space and is managed with container
  queries.
- Additional panels open without losing chat context.
- The area header shows its name, the current context, and primary actions.

### 7.2. Tablet

- Navigation may be compact or slide-out.
- The main area and one auxiliary panel are allowed at the same time.
- Changing orientation does not reset the selected chat or the entered draft.

### 7.3. Phone

- The interface reflows into a single column.
- Panels become full-screen modal surfaces or bottom sheets over the chat, but
  not standalone pages.
- Primary navigation is reachable with the thumb and does not cover the
  composer.
- Horizontal scrolling of the main document is not allowed.
- Height is calculated via the dynamic viewport; the keyboard appearing does
  not hide the input field or the send button.
- Safe-area insets are respected.
- On Home and in chat, the composer sits at the bottom edge of the chat canvas
  and is not covered by the drawer, safe area, or on-screen keyboard.

### 7.4. History and deep links

- Back returns to the previous app state instead of unexpectedly closing it.
- The URL keeps the identifier of the current section and object when it is
  safe to do so.
- Reloading the page restores the route and the selected object.
- Modals for which navigation matters integrate with history.

## 8. First launch

### 8.1. Scenario

A clean install shows a non-blocking checklist in the chat canvas:

1. The user picks the language and text scale right in the checklist.
2. The interface explains local storage and offers an optional import of the
   current SillyTavern or a backup restore in the Settings → Data menu.
3. The user connects a local/remote provider or Echo for an offline check.
   While no provider is active, sending messages is unavailable and a link to
   settings is shown nearby.
4. The user creates a character or imports a card.
5. After the character is pinned, a ready chat canvas opens; a chat is created
   only when the first non-empty message is sent.

### 8.2. Requirements

- The checklist does not block catalogs, import, or local settings.
- The chosen language, scale, and entered forms are preserved when moving
  between system surfaces.
- A connection error does not block import or browsing the local library.
- A secret is validated before saving; showing it again is not required.
- Once a character appears, the checklist gives way to the working chat canvas.
- Returning to unfinished setup remains available through the navigation rail.

## 9. Character catalog

### 9.1. Core tasks

- find a character;
- open a card;
- start or continue a chat;
- import, create, duplicate, edit, export, and delete;
- apply tags and bulk actions.

### 9.2. Presentation

The primary character action uses the shared continue flow. Explicitly
creating an additional conversation remains a separate `New chat` action.

- Grid and compact list are supported; the choice is remembered locally.
- The list is virtualized and loads via cursors.
- Thumbnails are used for previews rather than originals.
- A card shows the name, image, key tags, and last use.
- Selecting an item does not depend on its position in the array.
- The sidebar replicates the Character Management workflow from SillyTavern:
  `Cards → Edit → Advanced → Gallery`. Selecting a card simultaneously pins the
  character on Home and opens its editor.
- The `Edit` tab offers replacing the avatar from a file, favorite, separate
  PNG/JSON export, duplication, creator notes, the first and alternate
  greetings, and tags. Alternate greetings are stored as a compact collapsed
  list, and tags are added one at a time and shown as removable chips.
- Selecting a character, import, creation, and duplication immediately open
  "View"; switching to editing remains an explicit action.
- "View" inside the `Edit` tab replaces the entire editor with a read-only
  showcase of the card: at the top, the original avatar spans the full panel
  width, followed by the name and tags; below, Description and all greetings
  stay collapsed until explicitly expanded and render as Markdown. After
  expanding Greetings, each first and alternate greeting remains a separate
  collapsed item. The authored document stretches to its content, so the panel
  itself scrolls rather than a nested iframe.
  Creator's notes render between them as the card's main document inside a
  sandboxed iframe: Markdown and safely sanitized HTML/CSS are supported at the
  same time and cannot alter the app interface.
- The `Advanced` tab offers prompt overrides, creator metadata, personality,
  scenario, Character's Note with depth/role, talkativeness, and dialogue
  examples. Fields absent from the base schema are preserved in `ext` without
  losing unknown metadata.
- The `Advanced` tab also offers binding lorebooks to a character: a list of
  bound books, creating a new book directly for the character, and unbinding
  (see §10.7).
- The `Gallery` shows enlarged WebP previews for fast scrolling, but a click
  always opens the local original at full resolution. The user chooses 1–4
  columns themselves, so the layout does not change automatically with the
  number of images. The gallery sorts images by time, assigns the primary
  avatar, and after confirmation only removes the link to the character.
- Edit and Advanced share a single save button in the panel header; there is no
  duplicate bottom Delete/Save bar.
- The composer does not give up space to persistent helper hints about the
  provider or keyboard shortcuts: an unready provider state is still expressed
  through a disabled send button.

### 9.3. Search and filters

- Search starts showing results within 300 ms on the target set.
- The query can be cleared with one action.
- Search supports the syntax `tag:NSFW author:Name "exact phrase" -tag:beta`
  (details in `docs/api/README.md`). A query with search terms is always ranked
  by relevance; tag/author filters are applied at the same time.
- Filters show their active state and have a "Reset all" action.
- Catalog sort options: A–Z, Z–A, Newest first, Oldest first, Favorites,
  Recently used, More chats, Fewer chats, More content, Less content, Random
  order. "Favorites" shows favorite characters first (then A–Z);
  "More/Fewer chats" and "More/Less content" count only non-deleted chats and
  their messages (the content metric is characters, not real tokens). "Random
  order" returns one random page without loading more: each load is a fresh
  set, with no cursor pagination. A query with search terms is always ranked by
  relevance regardless of the chosen sort.
- Sort and filters are preserved when returning from a card.
- When there are no results, the query, active filters, and corrective actions
  are shown.

### 9.4. States

- Loading: a skeleton matching the chosen view.
- Empty library: an explanation and "Import" and "Create" actions.
- No results: filter reset and suggestions for changing the query.
- Error: a localized description, a retry, and a trace ID in expandable
  details.
- Corrupted card: a safe preview, the reason, and the ability to export the
  original for recovery.

## 10. Chats and messages

### 10.1. Opening a chat

- The most recent messages are shown first.
- Older messages load upward in batches.
- Loading more must not visually shift the current reading position.
- Returning to a chat restores the position or jumps to the unread point.
- A long history is not rendered in full in the DOM.

### 10.2. Message

Each message provides:

- the author, time, and available role name;
- generation or saving state;
- safely rendered Markdown with ST1-compatible roleplay formatting:
  `"..."` (dialogue / quote), `*...*` (italics), `**...**` (bold), `` `...` `` (highlighting),
  plus headings, lists, blockquotes, links, and images;
  quote / emphasis / code colors come from `--st-color-message-*` tokens, not hardcode;
- an action bar with copy, edit, regenerate, variants (swipes), checkpoint,
  branch, and delete;
- access to the raw text and diagnostics without changing the displayed
  content.

The action bar sits on the edge of the message header opposite the author's
name.

The action bar (`data-component="message-action-bar"`) is **always visible**,
not only on hover, and is keyboard accessible.

**Desktop (>600px)** — all available actions render in a single inline row
(`data-part="message-actions-inline"`) on the edge of the message header
opposite the author's name: built-in buttons (context, edit, copy, regenerate
last reply, checkpoint flag, branch, delete) + plugin actions
(`placement="all"` — primary, overflow, and legacy context-menu actions merge
into one row). There is no "More" menu.

**Mobile (≤600px)** — the header keeps a compact block
(`data-part="message-actions-compact"`) with just two buttons: the pencil
(`data-action="edit"`, opens the message card in edit mode) and the ellipsis
(`data-action="details"`, opens the card in details mode). The remaining
actions are available inside the card (§10.2.1).

During generation/saving the actions are locked (`data-state="busy"`); while
streaming, the bar is hidden.

### 10.2.1. Message card (mobile)

The pencil and ellipsis in the message header on mobile (≤600px) open the
**message card** (`data-component="message-details-card"`,
`data-state="details" | "edit"`) — a Radix bottom sheet with safe-area
handling, a focus trap, and Escape/backdrop closing. Part hooks:

- `data-part="drag-handle"` — visual gripper (aria-hidden);
- `data-part="details-header"` — avatar + author name
  (`data-part="details-avatar"`, `data-part="details-author"`);
- `data-part="details-meta"` — metadata rows, one
  `data-part="details-meta-row"` per row: sent, model, generation time. Only
  real values render — missing rows are omitted;
- `data-part="details-actions"` — a horizontally scrollable action bar:
  built-in buttons (the same `data-action={id}` as on desktop)
  - plugin actions;
- `data-part="details-content"` — rendered message content;
- `data-part="details-footer"` — pinned footer: Copy / Exclude-Include /
  Edit, each button is a `data-part="details-footer-action"`;
- `data-part="details-editor"` — edit mode (textarea with auto-grow); a save
  error is `data-part="details-editor-error"` (`role="alert"`); Cancel /
  Confirm edit buttons.

The pencil opens the card directly in edit mode, the ellipsis in details mode;
in edit mode Cancel closes the card, in details mode it returns to details. The
card does NOT have: variants, a variant counter, history, or a central "+"
button.

Built-in editor: `Ctrl/⌘+Enter` saves, `Escape` cancels. On a CAS conflict
(`MESSAGE_CONFLICT`), the draft is **not lost** — the editor stays open with
the saved text and an inline "message changed elsewhere" error for re-saving.

A message with variants shows a swipe pager
(`data-component="message-swipe-pager"`) below the content, with an `N/M`
counter and ‹ › buttons. There is no separate button to open the variant list:
switching is done with the arrows, and the variant history is preserved.

A message's checkpoint flag (`data-action="checkpoint"`): a normal click opens
the chat snapshot, `Shift+click` creates a fresh snapshot and opens it, and
removing the link is done with the `data-action="delete-checkpoint"` button
after confirmation (the chat snapshot itself stays in the chat list).

### 10.3. Composer

- The multiline input grows up to a set maximum.
- `Enter` and `Shift+Enter` are configurable; the current mode is shown in a
  hint.
- The draft is stored separately per chat.
- Sending is blocked only for an objective reason, which is explained next to
  the control.
- During generation the primary action becomes "Stop".
- Attachments show name, type, size, processing status, and removal before
  sending.
- Slash commands and macros have autocomplete with descriptions.
- The screen reader gets announcements for generation start, end, stop, and
  error without reading out every token.

### 10.4. Streaming generation

- The first visual response appears as soon as the request is accepted.
- The UI updates in batches at most 30 times per second.
- The user can scroll the history without being forced back to the bottom.
- Autoscroll applies only while the user is at the bottom edge.
- After manual scrolling, a "Go to new message" action is shown.
- Stopping saves the received text as an explicitly marked incomplete reply.
- A connection drop offers reconnection and does not create a duplicate
  message.
- Regeneration rewrites the target message **in place**: the new text streams
  inside the existing bubble (`data-state="streaming"`), no second bubble is
  created; once finished, the old text atomically becomes a variant (pager
  `N/M`), while on error or stop the previous text stays on disk.

### 10.5. Context and token budget

- A strategy is chosen in settings: `truncate`, `summarize`, `vector-recall`,
  or `manual`; in manual mode a message action excludes it from the prompt
  without removing it from history and allows bringing it back.
- A context fill indicator is available before sending.
- Home and the open chat share a single live preview of the current prompt:
  changing context size, draft, or history recomputes the same token budget on
  both surfaces.
- The last generation's audit remains a diagnostic snapshot and does not
  replace the next request's counter.
- A warning appears before the critical limit is reached.
- The user can see:
  - which tokenizer is selected;
  - the limit and the response reserve;
  - excluded blocks;
  - summarized blocks;
  - the applied context shifting strategy.
- With an approximate tokenizer, an explicit warning is shown.
- A tool call and its tool result are visually grouped and cannot be deleted
  separately.

### 10.6. Chat management panel

`New chat` opens the existing unstarted chat for the same character/persona
when it contains no user messages; otherwise it creates an additional
conversation. In both cases it opens the exact `/chats/:id` route instead of
returning to `/home`.

The **Chats** section in the navigation rail opens the chat management panel
(a context panel over the chat, not a separate page):

- The chat list loads via cursors, shows the title, message count, and
  last-updated date, and is automatically scoped to the current conversation's
  character or the one pinned on Home. There is no separate character picker in
  the panel.
- Snapshot chats (checkpoint/branch) are marked with an origin badge
  (`data-part="chat-origin-badge"` with `data-origin="checkpoint|branch"`).
- Search matches chat titles/summaries and message content via
  `chats_fts`/`messages_fts` and runs with debounce.
- "New chat" sits above the list, creates a chat for the current conversation's
  character (or the pinned one), closes the panel, and returns to `/home` with
  that character.
- Row context menu: open, rename, export, move up/down, delete. On touch
  devices the menu opens with a stationary long press. The menu portal uses a
  dropdown layer above the full-screen modal panel, so it stays visible in the
  phone layout too. Reordering and drag-and-drop are available only in a list
  filtered to a single character without search — there order makes sense; in
  "All chats" and search results rows cannot be moved.
- Reordering by dragging across the whole row with mouse or finger, and menu
  commands, optimistically update the order and persist it via
  `PUT /chats/order`; there is no separate drag handle, and on error the order
  is reloaded.
- Deletion requires confirmation in a dialog naming the chat; it goes to the
  trash (`chats.trash`), not for good.
- Export downloads the chat archive with its messages as a separate download.

### 10.7. Lorebook panel

The **Lorebooks** section in the navigation rail opens the world info
management panel (a context panel over the chat, not a separate page):

- The panel has three tabs: the book list, the book editor, and the entry
  list. The book and entry tabs are available only when a book is selected.
- The book list loads via cursors and shows the name, description, a
  loaded-books counter, and scope badges ("Global" / "Character"). A filter
  scopes the list to global books, a specific character's books, or all; with
  a character filter, selection uses a search picker.
- Book search runs with debounce.
- "New book" creates a global book with a default name; from Character
  Management a book is created already bound to the character.
- Book editor: rename on blur, description with debounced saving,
  binding/unbinding a character via a picker, and delete with confirmation (to
  the trash; restoration in the `chats.trash`-equivalent log).
- Entries: add, edit, enable/disable via a toggle without opening a dialog,
  and delete with confirmation. The entry dialog contains primary and
  secondary keys (one per line), content, position, `constant` / `selective` /
  `enabled` toggles, and an estimated size in tokens. At least one primary key
  is required; a field with an error is highlighted next to an explanation.
- Binding books to a character is available in the Character Management
  `Advanced` tab: a list of already bound books, a "New book for <name>" action
  (creates a book and opens the lorebook panel), and "Unbind".

### 10.8. Checkpoints and branches (message snapshots)

Using the direct buttons in any message's action bar, you can create a
**checkpoint** or a **branch** — a snapshot of the chat history frozen at that
message. The snapshot copies the active branch's prefix up to the selected
message (including variants and plugin blocks) into a new child chat, which
inherits the parent's character, persona, background, and summary.

- Creation is confirmed by a "Checkpoint/Branch created" toast with an
  **Open** action — the button immediately navigates to the new snapshot chat.
- A checkpoint flags the original message
  (`data-action="checkpoint"`): a click opens the chat snapshot, `Shift+click`
  creates a fresh snapshot and opens it, and "Remove link"
  (`data-action="delete-checkpoint"`, with confirmation) only clears the flag —
  the chat snapshot itself stays in the chat list.
- The child chat header has a "Back to parent chat" button
  (`data-component="back-to-parent"`) — instant return to the original chat.
- Child chats are marked with an origin badge in the chat management panel
  (see §10.6). Data is copied as of the snapshot moment: parent changes after
  the snapshot do not reach it, and vice versa.

## 11. Character creation and editing

- The editor is divided into clear groups: identity, description, first
  message, scenario, examples, lore, images, and extended metadata.
- Required fields are indicated by text, not only by a symbol or color.
- Validation runs next to the field and in the final error list.
- A preview of the card and the starting message is available.
- Unknown fields of an imported card are preserved and visible in the
  compatibility section.
- Replacing an image does not delete the original until the save succeeds.
- The gallery stores multiple images separately from the primary avatar; an
  uploaded file becomes available immediately, and assigning it as the primary
  avatar updates the card with a version snapshot.
- On a version conflict, both versions and resolution options are shown.

## 12. Providers and models

### 12.1. Connection

- First a top-level **API** is chosen (Chat Completions or Text Completions),
  then the **Source** list ("API type") is filtered to the sources of the
  selected API; changing the API resets the source to the first available one —
  the behavior of `main_api` in classic SillyTavern.
- No connection name needs to be entered: the selected source itself becomes
  the profile name, so the key is saved right after selecting the source and
  pasting the value. In the panel, the name field is hidden when a source is
  selected; in the full profile editor, the name remains an optional override
  with autocomplete suggestions from the source (needed, for example, to
  distinguish two accounts of the same provider).
- The label sits above the field; the helper and the error sit below it.
- Secret fields have show/hide and replace actions. The key manager stores
  several named keys with one active; the manager header offers a quick picker
  for the active key without scrolling the list.
- "Test connection" is separate from "Save".
- The test result shows availability, latency, and a safe description of the
  error.

### 12.2. Model selection

- Models load with cancellation and a timeout.
- Search and list refresh are available.
- Known capabilities and the context limit are shown for each model.
- A stale model list cache is explicitly marked.
- Deleting an active configuration requires choosing a replacement or
  confirming that no active provider remains.

### 12.3. Errors

- An authentication error is not masked as a generic network error.
- A rate limit reports whether and when a retry is possible, when known.
- A timeout offers retry and limit changes only in advanced settings.
- Technical details and the trace ID live in a collapsible block and are copied
  separately.

## 13. Import and migration

### 13.1. Stages

```text
Choose source
→ local scan
→ preliminary report
→ choose categories and conflicts
→ backup
→ import with progress
→ verification
→ final report
```

### 13.2. Requirements

- Before writing, the number of objects, estimated size, errors, and
  incompatible items are shown.
- The user chooses the data categories.
- For conflicts, skip, merge, create a new copy, and replace are available,
  provided replacement is safe.
- Re-importing does not create duplicates.
- Progress includes the current stage, the processed count, and the ability to
  cancel.
- Cancellation leaves either the original state or an explicitly described,
  consistent partial result.
- The final report lists imported, skipped, and corrupted items.
- The report can be saved locally without secrets.

### 13.3. Implemented scenario

Under "Settings → Data and backups", a full SillyTavern ZIP backup can be
imported without a terminal. A read-only analysis runs first: the screen shows
objects, nested records, corruption, size, and conflicts separately for
characters, chats, personas, lorebooks, and presets. Until confirmation, the
library, the import log, and the backup are not modified.

The user chooses the categories and one explicit conflict policy: keep existing,
create copies, safely merge, or replace from the archive. Immediately after
confirmation, a protective backup is created, then only the selected categories
are imported. Secrets, plugins, themes, and unsupported groups are listed as
skipped. Analysis, confirmation, local processing, error, cancellation, and
final-report states are supported.

## 14. Backup and restore

- The screen shows the date, size, schema version, source, and state of each
  backup.
- Creating a backup does not block reading local data.
- Before restoring, the app creates a protective backup of the current state.
- Restoring requires confirmation and reports that a restart is needed.
- Restore must not be presented as successful until integrity is verified.
- A restore error offers automatic rollback to the protective copy.
- Deleting a backup reports whether it is the last working copy.

## 15. Plugins and themes

### 15.1. Installation

- Before installation, the author, version, source, compatibility, signature,
  and permissions are shown.
- New permissions on update require separate consent.
- Dangerous permissions are described in terms of the concrete action and data
  involved.
- Installation is atomic; on error, the previous version remains.

### 15.2. Management

- Visible states: enabled, disabled, requires permissions, incompatible, error.
- Disabling a plugin removes its UI, hooks, timers, routes, and subscriptions
  without a restart, when the contract allows it.
- A plugin's error is isolated, and disabling only that plugin is offered.
- For a legacy extension, the compatibility level and known limitations are
  shown.

### 15.3. Themes

- A preview is available before applying.
- From the preview, you can accept the theme, go back, or open its settings.
- Changing the theme, component skin, and shell layout does not require a
  restart.
- On error, the shell automatically restores the last working shell.
- The system "Reset interface" action cannot be hidden by a theme.

## 16. Settings

- Settings are searchable by name, description, and keywords.
- Changes apply immediately only where they are easily reversible.
- Settings with side effects use an explicit "Apply".
- Parameters changed from their default values are marked and have an
  individual reset.
- Dependent settings explain why they are unavailable.
- Settings import and export exclude secrets by default.
- The backend returns a machine-readable error code; the user-facing text is
  localized by the frontend.

## 17. Search and command palette

- Global search covers characters, chats, messages, and lorebooks.
- Results are grouped by type and include match context.
- Jumping to a message opens the chat at the right position.
- The command palette is keyboard-accessible, shows shortcuts, and respects the
  current context.
- Plugin commands visually mark their source.
- An unavailable command is either hidden or explains the condition for its
  availability.

## 18. System states

Every major screen MUST have:

- an initial load;
- a background reload that does not make already shown data disappear;
- an empty state;
- partially available data;
- a local error;
- offline or an unavailable backend;
- a missing permission;
- a cancelled operation;
- a successful completion with a follow-up action.

The skeleton mirrors the geometry of the content. An infinite spinner is not
used as the only feedback for operations lasting longer than two seconds.

## 19. Notifications and confirmations

- A toast is used for a non-critical result that requires no decision.
- An inline message is used next to the cause of an error.
- A dialog is used for a mandatory choice or a dangerous action.
- A notification does not auto-dismiss if, without it, the user could not
  understand or fix the problem.
- The same event is not duplicated as toast, dialog, and inline text at the
  same time.
- Long-running operations remain available in the shared status area and after
  switching screens.

## 20. Text and localization

- The user UI contains no untranslated system strings.
- Wording describes the action: "Create backup", not "OK".
- The confirmation button of a dangerous action names the action: "Delete
  character".
- No blaming wording is used.
- Dates, numbers, sizes, and durations are formatted with `Intl`.
- Fallback: regional language → base language → English.
- The interface is checked with pseudo-locale, long translations, and RTL.
- Switching the language updates `lang` and `dir` on `<html>` without a reload.

## 21. Accessibility

The base theme and the core scenarios conform to WCAG 2.2 AA.

Mandatory requirements:

- a logical Tab order and no keyboard trap outside a modal;
- a skip link to the main area;
- a visible focus with contrast meeting WCAG requirements;
- correct landmarks, heading hierarchy, labels, and accessible names;
- list, menu, tab, and dialog interaction following Radix/WAI-ARIA patterns;
- a minimum touch target of 24 × 24 CSS px, with 44 × 44 as the target size;
- reflow without loss of function at 320 CSS px width and 400% zoom;
- screen reader announcements for asynchronous operations;
- no mandatory drag-, hover-, or pointer-only interactions;
- `prefers-reduced-motion` disables decorative motion while preserving meaning;
- high contrast does not lose borders, focus, or states;
- the OpenDyslexic font is available under Appearance settings for easier
  reading;
- color is never the only way to convey an error, role, or selection.

## 22. Visual and motion base

These rules apply to the base theme; the Theme SDK may change the visual
language while preserving the UX contracts.

- One primary accent color per shell; statuses use semantic tokens.
- Neutral surfaces do not accidentally mix warm and cool palettes.
- Technical UI uses sans-serif; numeric diagnostics may use monospace.
- The default density is moderate; compact mode is enabled separately.
- On desktop, asymmetric areas are acceptable; on phone, a strict single
  column.
- Decorative motion does not trigger continuous React renders.
- `transform` and `opacity` are animated preferentially.
- Hover, pressed, selected, disabled, loading, and focus have distinguishable
  states.
- Durations, easing, shadows, blur, sizes, and z-index are defined by tokens.
- Mandatory infinite animations are not allowed in work areas.

## 23. UX performance

Target metrics:

- a usable UI after cold start — no more than 4 seconds;
- the first page of 100,000 characters — no more than 300 ms;
- the latest chat messages out of 10,000 — no more than 700 ms;
- streaming — no more than 30 UI updates per second;
- the initial frontend bundle — no more than 2 MB gzip without lazy chunks;
- text input is not blocked by background search, generation, or indexing;
- pressing a primary action gets visual feedback in the next frame;
- route changes keep available content visible while server data refreshes.

Metrics are measured on a fixed reference device and dataset. A subjective
feeling of speed is not a substitute for measurement.

## 24. Privacy and trust

- Any action that sends user content to the network shows the chosen recipient.
- LAN/remote access is off by default. A non-loopback bind requires explicit
  server opt-in, an HTTPS origin, and a bootstrap token.
- The remote browser shows a separate login gate. The token is not stored in
  Web Storage; logout deletes the session cookie, app cache, and local browser
  storage of that origin.
- Diagnostic export shows its contents and performs automatic secret removal.
- Cache clearing is separate from deleting user data.
- Deleting an original image is not disguised as thumbnail cleanup.
- Dark patterns are not allowed for telemetry, updates, plugin permissions, or
  external services.

## 25. Diagnostics and recovery

- Safe mode is available before third-party themes and plugins load.
- After a crash loop, the app offers a safe start.
- Diagnostics show the state of the backend, DB, migrations, providers,
  plugins, theme, and free disk space without revealing secrets.
- The screen first shows an aggregated summary and the exact privacy contents.
  The JSON report is generated in the browser only after a separate action; it
  contains no logs, paths, provider settings, or user text.
- FTS rebuild and cleanup of regenerable thumbnails are available next to the
  report. Cleanup requires confirmation and reports the count/size of deleted
  items.
- Every API error has a trace ID that can be copied separately.
- The user can verify FTS and run a rebuild from the UI.
- Restoring the interface does not require manual file editing.

## 26. UX contracts for plugins

A plugin:

- registers content only through documented slots and APIs;
- provides cleanup for every registration;
- uses its own i18n namespace;
- supports loading, empty, error, disabled, and permission denied;
- does not intercept global shortcuts without permission and conflict
  resolution;
- does not block system navigation, safe mode, or the notification layer;
- announces asynchronous changes in an accessible way;
- works correctly when the theme, language, text direction, or shell layout
  changes.

## 27. UX analytics without mandatory telemetry

Criteria are evaluated with local and lab tests:

- first-run success;
- time to first message;
- share of completed imports;
- number of errors before a successful provider connection;
- time to search and open a result;
- backup restore success;
- completion of core scenarios using only the keyboard;
- number of critical accessibility errors;
- task stability at 320 px, 400% zoom, and RTL.

Sending analytics to developers is off by default and requires separate
explicit consent.

## 28. Acceptance criteria for the first stable release

The automated minimum lives in `e2e/release.spec.ts`,
`e2e/flows.spec.ts`, and `e2e/visual.spec.ts`: the core character flow,
route-aware system surfaces over a mounted chat, keyboard/focus restoration,
axe WCAG A/AA, 320 px reflow, and visual regression for light, dark, high
contrast, long pseudo-locale, and mobile RTL.

### 28.1. First launch

- A clean install starts without a terminal, Git, or a separate Node.js
  installation.
- A new user can connect a provider and send the first message.
- A provider error does not block the local library or settings.

### 28.2. Library

- Import can be repeated without duplicates and preserves unknown metadata.
- A catalog of 100,000 characters is not fully loaded into memory or the DOM.
- Search, filters, and returning from a card preserve context.

### 28.3. Chat

- A chat of 10,000 messages opens the latest messages in batches.
- Streaming can be stopped; manual scrolling is not reset.
- A draft survives switching to another screen and route restoration.
- A network error does not create a duplicated response.

### 28.4. Data

- Backups are created and restored from the UI.
- A full SillyTavern ZIP backup is imported from the UI; E2E verifies the path
  from file selection through read-only analysis and confirmation to the
  character appearing in the library.
- A protective copy is created before a dangerous restore.
- Cache clearing does not delete original files.

### 28.5. Extensibility

- Disabling a plugin removes its registrations.
- A new permission after an update requires consent.
- A theme or plugin error does not hide safe mode.
- Theme, shell, and language changes happen without a restart.

### 28.6. Accessibility and devices

- Critical scenarios work with a keyboard and a screen reader.
- The base theme passes automated and manual WCAG 2.2 AA checks.
- The interface keeps its functions at 320 px, 400% zoom, RTL, and with an
  on-screen keyboard.
- Reduced motion disables optional motion.

### 28.7. Quality

- No hardcoded user strings, secrets in logs, or browser storage.
- Loading, empty, error, and offline states are verified for major screens.
- E2E covers first launch, import, provider connection, chat, backup,
  safe mode, and plugin disabling.
- Visual regression covers base shell layouts, long translations, RTL,
  high contrast, and mobile.

### 28.8. Contextual side panel

- Navigation rail icons open the corresponding contextual panel, not a generic repeating list of sections.
- Generation parameters, the active provider, and the context strategy are edited next to the chat without navigating to a separate screen.
- On desktop, the open panel occupies its own column: the chat area starts after the panel and is centered in the remaining space.
- On desktop, the panel width is changed by dragging its right edge, is saved
  locally, and is not overridden by a previously saved interface density.
- On narrow screens the panel stays an overlay, always fills the space from the
  navigation rail to the right edge of the viewport, and does not inherit the
  saved desktop width. The shell container adds no outer vertical padding: the
  top safe area belongs to the header, the bottom one to the scroll body or
  floating cloud; the composer below the panel is not compressed.
- The header, tabs, and content of all built-in panels share a single inner
  frame. The full-height Personas and Characters panels keep an independent
  ScrollArea but are visually aligned with AI Settings via the `--st-space-lg`
  token. Their tablist levitates as a semi-transparent cloud above the content:
  the space around the rounded surface is genuinely transparent, the full-bleed
  viewer is not compressed by a shared padding, and a separate scrollable
  spacer only on the cloud side keeps the first and last controls from getting
  stuck under it. The base theme separates the cloud border/blur without an
  outer shadow.
- Settings buttons in the composer open the embedded AI Settings panel and preserve the current route and the message draft.
- The Config tab contains all supported model request parameters: context,
  response length, streaming, sampling, penalties, seed, and reasoning.
- The API tab mirrors the ST1 working scenario: choosing a saved connection
  profile, API and source, a base URL for compatible servers, choosing a saved
  API key and a single button for the multi-key manager, and a manual model ID
  through the model search menu (load via `/v1/models`, pick from the list, or
  free-form entry). The key field is not a password-input,
  so the browser password manager does not interfere. For a new profile, the
  key button saves only metadata and immediately opens the manager; the
  required key is still verified before fetching models and connecting. For
  OpenAI-compatible endpoints, the URL is entered as `/v1`; loading models
  performs `GET /v1/models`, and the chat request goes to
  `/v1/chat/completions`.
- The Advanced tab exists only for building a custom
  chat/instruct template from ChatML, Llama 3, or Alpaca, with separate role
  templates, an assistant suffix, and stop strings.

## 29. Mandatory UX artifacts

Artifacts do not duplicate the implementation with a separate set of quickly
outdated mockups. The normative source and verifiable evidence for each
artifact:

| Artifact                                                 | Source of truth                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Screen and route map                                     | Sections 6–7, `apps/web/src/components/systemSurfaces.ts`                       |
| Interactive prototype of first launch, catalog, and chat | The working SPA and the scenarios in `e2e/release.spec.ts`, `e2e/flows.spec.ts` |
| Keyboard shortcuts                                       | Section 29.1                                                                    |
| Content guide and vocabulary                             | Section 29.2 and the i18n resources in `packages/i18n/src/resources/`           |
| Accessibility checklist and results                      | Section 29.3                                                                    |
| Large library and long chat                              | `packages/db/scripts/benchmark.ts`, the `pnpm benchmark` command                |
| Usability-testing scenarios                              | Section 29.4                                                                    |
| Visual regression matrix                                 | `e2e/visual.spec.ts` and the golden snapshots next to it                        |
| Known UX limitations                                     | Section 29.5                                                                    |

### 29.1. Keyboard shortcuts

- `Tab` and `Shift+Tab` move focus in document order; a modal surface keeps
  focus inside itself.
- `Enter` sends the message, `Shift+Enter` adds a line. The hint next to the
  composer always shows the current mode.
- `Escape` closes the top panel or modal surface and returns focus to the
  button that opened it. An open nested dialog closes first.
- Browser Back closes a route-aware surface and returns to the saved chat
  route; pressing Back again follows normal history.
- A plugin MUST register its hotkey through the Plugin SDK and release the
  registration when disabled; intercepting the browser's system shortcuts is
  prohibited.

### 29.2. Content guide and vocabulary

- An action name starts with a verb: "Create backup", "Open characters",
  "Connect AI". "OK" and internal API names are not used.
- An error explains what happened and which safe action is available next;
  the backend code is localized on the frontend.
- The label names the value, the helper explains the consequences, and the
  placeholder shows an example without replacing the label.
- `Chat` — a saved conversation branch; `character` — a participant and its
  card; `persona` — the user's profile; `AI provider` — a local or remote
  model connection; `theme` changes the shell and skin; `plugin` adds behavior
  with explicitly granted permissions.
- English and Russian strings are working translations; pseudo-locale
  is mandatory for checking hardcoded and long strings.

### 29.3. Accessibility checklist and results

Audit of 2026-07-29:

- all system surfaces have dialog/region semantics, an accessible name,
  keyboard close, and focus restoration;
- the main content has a skip link, landmark, and visible focus;
- touch targets, reduced motion, high contrast, `dir="rtl"`, and 320 px reflow
  are covered by styles and Playwright;
- axe finds no automatic WCAG A/AA violations on `/home`,
  `/characters`, `/chats`, `/providers`, `/themes`, and `/plugins`;
- light, dark, high contrast, and pseudo-locale mobile RTL are checked against
  golden snapshots.

Standard actions use the shared `ActionBar`: the quick toolbar on a narrow
panel stays horizontal and collapses icon buttons down to 44 px, keeping
localized accessible names and tooltips; form/footer actions may wrap or
stack, and a long row gets local scroll. The decision is made from the
measured natural content width and the available width of the toolbar itself,
without viewport/container breakpoints; hysteresis prevents back-and-forth
switching when the resize handle moves a few pixels. Control panel tabs
(Settings, Personas, Characters, AI Settings, plugin panels) use a single
segment variant with equal columns; on a narrow panel the row stacks into two
columns. The Settings menu is a tabbed panel (role="tablist") with General,
Themes, and Data tabs: theme installation, active theme selection, SillyTavern
migration, and backups live here, not on a separate page. In General, the
start Home choice uses the same full-width
segmented control as Contrast and other binary settings; the options explicitly
show Home and saving the current screen. Two compact dropdowns independently
choose the message style (Clean, Classic, Bubbles, Document, Cards, or
Paragraphs) and the avatar shape (Round, Square, Portrait, Banner, or Hidden).
The choice applies immediately to Home and the open chat and is saved locally
without a reload. On viewports ≤ 600 px, the tab list moves to the bottom of
the panel (mobile tab bar) while keeping tablist/tab roles and DOM order for
screen readers. In full-height panels, the mobile tab bar stays a floating
cloud and the scrollable content gets a bottom safe offset. The 320 px
behavior is locked in by release E2E, axe, and visual snapshots.

Before the stable release, an operational manual sign-off remains in current
Narrator, VoiceOver, and TalkBack, as well as at 400% browser zoom. Automated
checks are not presented as a substitute for real assistive technology.

### 29.4. Usability-testing scenarios

1. A new user changes the language and text size, connects AI, creates a
   character, and sends the first message without leaving the chat workspace.
2. A returning user opens the catalog and history, then closes the surface and
   continues the same chat draft.
3. A SillyTavern user analyzes and imports a full ZIP, verifies the
   result, and re-imports without duplicates.
4. A theme author downloads `theme-starter.zip`, changes semantic tokens and
   the shell, installs the package, and restores the base theme through safe
   mode.
5. A plugin author installs the package, checks permissions, opens the
   registered surface, and confirms that disabling removes its UI.

Each run records the number of actions, wrong turns, time to
result, unclear terms, and the point of failure. Secrets and user content
are not included in the result record.

### 29.5. Known UX limitations

- Golden screenshots are currently tied to Chromium/Windows; behavioral checks
  do not depend on a pixel baseline.
- The RTL shell is verified with a forced `dir="rtl"`; a ready Arabic/Hebrew
  translation pack is not yet part of the base distribution.
- The production build fits the target gzip budget, but Vite reports one
  chunk larger than 500 kB; further splitting must not change the
  route/surface contract.

## 30. Related documents

- [Architecture](../architecture/README.md)
- [API](../api/README.md)
- [Plugin SDK](../plugin-sdk/README.md)
- [Theme SDK](../theme-sdk/README.md)
- [Data and SQLite](../data/README.md)
- [Desktop and Web Client](../desktop/README.md)

## Message details and version controls

At viewport widths up to 600 px, message details use an ST1-style bottom sheet.
The details mode contains compact author and generation metadata, one horizontally
scrollable row of every currently available core and plugin action, a bordered message
body, and a bottom bar containing only Copy, the centered action-menu button, and Edit.
The drag handle is an interactive 44 px target: dragging it down closes the sheet.

The action-menu mode replaces details with a vertical list. Destructive message deletion
is isolated under Danger zone and removes the message, its variants, and its edit
revisions. Core and registered plugin actions are rendered only when operational; absent
plugins never produce disabled WeatherPack, Narrate, or similar placeholders.

Assistant-message version controls live below the message on mobile and desktop. History
and Regenerate are icon-only accessible buttons on the left, while the N/M swipe pager is
on the right. History is never offered for user messages. Regenerate is enabled only for
the latest assistant message and creates a swipe variant, not a manual edit revision.

`MessageRevisionHistoryCard` shows the current text and archived manual edits newest
first, supports lazy pagination and full-text expansion, and restores with CAS. A stale
restore remains in the sheet and displays a localized inline conflict.

All controls preserve visible focus, dialog focus trapping, logical inline direction for
RTL, safe-area padding, localized accessible names, and a minimum 44 px touch target.
