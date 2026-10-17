# Extensions

Glee can grow without every feature living inside `App.tsx`. Extensions add
commands, message buttons, composer controls, Settings sections, and chat
pipeline hooks through a small typed registry. Data packs add characters,
context, personas, prompt snippets, and themes with no code at all.

Source: `src/extensions/`. Everything in the core is plain TypeScript with no
runtime React dependency; the React hooks are in `src/extensions/react.ts`.

## Tiers

| Tier | What | Runs code? | Status |
| --- | --- | --- | --- |
| 1. Built-in extensions | Features shipped with Glee, written against the same API a third party would use | Yes, in-process, trusted | Implemented (three examples) |
| 2. Data packs | JSON files: character, context, persona, snippet, and theme packs | No, validated data only | Implemented (loader, validator, `applyPack`); installing into the app is a wiring step |
| 3. Script plugins | Third-party code in a sandbox, with an install-time permission prompt | Yes, isolated | Design only, see [Tier 3](#tier-3-sandboxed-script-plugins-design) |

The API is shaped so tier 3 is a transport change, not a redesign: every
function an extension can call is a registration or a small data request, and
every value crossing the boundary is plain JSON-compatible data.

## Quick start

```ts
import type { Extension } from "../extensions";

export const shout: Extension = {
  id: "example.shout",
  name: "Shout",
  version: "1.0.0",
  apiVersion: "1",
  permissions: ["ui:commands"],
  activate(ctx) {
    ctx.commands.register({
      id: "shout",
      label: "Shout",
      hint: "Show a notice",
      run: () => ({ notice: "HELLO" }),
    });
  },
};
```

```ts
import { createDefaultRegistry } from "../extensions";

const registry = createDefaultRegistry({ host: { notify, copyText } });
registry.register(shout);
await registry.start();
```

Disabling it (`await registry.disable("example.shout")`) removes the command
immediately; enabling brings it back. Nothing needs a restart.

## API reference

### `Extension`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Dotted lowercase words, 64 characters max, e.g. `glee.word-count`. Unique. |
| `name` | `string` | Shown in Settings. 80 characters max. |
| `version` | `string` | `1`, `1.2`, or `1.2.3`. |
| `description` | `string?` | One sentence. |
| `apiVersion` | `string` | The contract version it was written against, e.g. `"1"`. See [versioning](#versioning-and-compatibility). |
| `permissions` | `Permission[]` | Everything it needs. See [permissions](#permissions). |
| `dependencies` | `string[]?` | Ids of extensions that must be active first. |
| `priority` | `number?` | Lower runs first in pipeline hooks and breaks ordering ties. Default 100. |
| `activate(ctx)` | `void \| Promise<void>` | Register things here. Must finish within 2 seconds. |
| `deactivate()` | `void?` | Optional cleanup for anything you allocated yourself. Registrations made through `ctx` are removed automatically. |

### `ExtensionContext`

The only object an extension receives. It exposes registration functions and
nothing else: no stores, no IPC, no DOM handles. Every `register`/`on` call
returns an unsubscribe function.

**`ctx.commands.register({ id, label, hint?, run })`** (`ui:commands`).
Adds a command-palette entry. `run` may return `{ notice?, copyText? }`; the host
performs those effects (see [Action results](#action-results)).

**`ctx.settingsSections.register({ id, title, order?, render })`** (`ui:settings`).
`render()` returns a React element (usually `createElement(SomeComponent)`);
do not call hooks inside `render` itself, put them in the component. Use
`lazyRender(() => import("./panel"), props)` from `react.ts` to load heavy
panels on demand. Sorted by `order` (default 100).

**`ctx.messageActions.register({ id, label, when?, run })`** (`ui:message-actions`).
A button in the message toolbar. `when(message, chat)` decides whether it
shows for that message; `run(message, chat)` handles the click. A throwing
`when` hides the button and counts as a failure.

**`ctx.composerTools.register({ id, order?, render })`** (`ui:composer`).
A small control above the message field, rendered like a settings section.

**`ctx.chatPipeline`** (permissions per hook below). Hooks run on the reply
path; see [Pipeline semantics](#pipeline-semantics).

| Hook | Permission | Receives | Returns |
| --- | --- | --- | --- |
| `beforeSend(draft)` | `chat:write` | `{ chatId, text }` | nothing (keep), a new draft `{ chatId, text }`, or `cancelSend(reason?)` |
| `transformPromptNotes(notes, ctx)` | `prompt:notes` | the current note lines (read-only) and a `NotesContext` | `{ prepend?: string[], append?: string[] }` or nothing |
| `afterReply(reply)` | `chat:read` | `{ chatId, messageId, speakerCharacterId?, content }` | nothing (observe only) |
| `onChatOpened({ chat })` | `chat:read` | `ChatView` | nothing |
| `onChatClosed({ chat })` | `chat:read` | `ChatView` | nothing |

`NotesContext`: `chatId`, `characterId?`, `participantIds`, `isGroup`,
`isRegeneration`, `userText` (empty without `chat:read`), and
`remainingChars`, the room this extension may still use. Respect it and you
will never be dropped.

**`ctx.storage`** (`storage`). A private, namespaced key-value store:
`get<T>(key)`, `set(key, value)`, `remove(key)`, `keys()`. Values are
JSON-serialised. Limits: keys are letters, digits, `.`, `_`, `-` (64 max),
values up to 32,768 characters, 64 keys per extension. Another extension's
keys are unreachable. The host supplies the backend through a
`StorageAdapter`; tests use `createMemoryStorageAdapter()`, the app can use
`createBrowserStorageAdapter()` today and a settings-table adapter later.

**`ctx.events.on(name, handler)`**. Subscribe to app events:

| Event | Payload | Permission |
| --- | --- | --- |
| `chat:message-added` | `{ chatId, message }` | `chat:read` |
| `chat:message-deleted` | `{ chatId, messageId }` | `chat:read` |
| `chat:cleared` | `{ chatId }` | `chat:read` |
| `character:changed` | `{ characterId \| null }` | `chat:read` |
| `persona:changed` | `{ chatId, personaId \| null }` | `chat:read` |
| `runtime:status-changed` | `{ status }` | none |

The host emits with `registry.emit(name, payload)`; handlers run in extension
order, each isolated.

**`ctx.logger`**. `debug/info/warn/error(message, data?)`, scoped to the
extension, kept in a ring of the latest 100 lines (`registry.getLogs(id)`) and
forwarded to an optional `logSink`.

### Action results

Commands and message actions may return `{ notice?: string; copyText?: string }`.
The registry applies them through the host's `HostEffects` (`notify`,
`copyText`), clipping notices to 300 characters and clipboard text to 10,000.
An extension never touches the clipboard or the notice system itself, which
keeps it portable to the sandbox. A thrown error becomes an error notice and a
counted failure; `run()` on a view never rejects.

### `ExtensionRegistry`

```ts
const registry = new ExtensionRegistry({
  apiVersion, storage, host, now, hookTimeouts, notesBudget,
  totalBlockingMs, activationTimeoutMs, maxFailures, failureWindowMs, logSink,
});
```

| Method | Purpose |
| --- | --- |
| `register(ext, { builtin? })` | Validate and record. Returns `{ ok }` or `{ ok: false, reason }`. Does not run code. An incompatible extension is recorded with status `incompatible` so Settings can explain why. |
| `start()` | Load user preferences, then activate everything not turned off, dependencies first. Safe to call again for later registrations. |
| `enable(id)` / `disable(id)` | User actions; persisted through the storage adapter. Disabling cascades to dependents (they come back when the dependency does). |
| `unregister(id)` | Deactivate and forget. |
| `dispose()` | Deactivate all and drop subscribers. |
| `beforeSend(draft)` | Run the hook; returns `{ draft, cancelled? }`. |
| `transformPromptNotes(notes, ctx)` | Returns `{ notes, added }`. |
| `afterReply(reply)`, `chatOpened(chat)`, `chatClosed(chat)` | Observer hooks. |
| `emit(name, payload)` | Deliver an app event. |
| `getSnapshot()` / `subscribe(fn)` | `useSyncExternalStore`-ready; the snapshot object is stable until something changes. |
| `listExtensions()` | `ExtensionInfo[]`: id, name, version, status, `statusReason`, `disabledBy`, `failureCount`, `lastError`, `contributionCount`, permissions. |
| `listCommands()` | `CommandView[]` shaped like the palette's `CommandAction` (`id`, `label`, `hint`, `run`). |
| `listSettingsSections()`, `listComposerTools()` | Sorted views with a safe `render()`. |
| `listMessageActions(message, chat)` | Buttons for one message (`when` evaluated here). |
| `getLogs(id)`, `reportFailure(id, error)` | Diagnostics and error-boundary reporting. |

Statuses: `inactive` (registered, not started), `active`, `disabled` (see
`disabledBy`: `user`, `auto`, or `dependency`), `failed` (activation threw or
timed out), `incompatible`.

### React helpers (`src/extensions/react.ts`)

`ExtensionProvider`, `useExtensionRegistry()`, `useExtensions()`,
`useRegisteredCommands()`, `useMessageActions(message, chat)`,
`useComposerTools()`, `useSettingsSections()`. Settings and composer hooks
return `{ id, extensionId, node }` where `node` is already wrapped in an error
boundary and `Suspense`, so a crashing extension component renders nothing and
is reported, never white-screens the app.

### Packs API

`loadPack(jsonTextOrValue) -> { ok: true, pack } | { ok: false, errors }` and
`applyPack(pack, targets)`; see [Data packs](#data-packs).

## Pipeline semantics

All hooks go through one runner (`pipeline.ts`).

- **Order.** Ascending `priority`, then registration order. Contributions in
  menus sort by `order`, then the same two keys, then local id. Deterministic
  for a given registration sequence.
- **Fail open.** If a hook throws, times out, or returns something invalid, the
  app behaves as if that hook were absent. A message is never lost to an
  extension bug.
- **Timeouts.**

  | Hook | Default timeout |
  | --- | --- |
  | `beforeSend`, `transformPromptNotes` | 250 ms each, 750 ms total per run (later hooks are skipped once spent) |
  | `afterReply` | 2,000 ms |
  | `onChatOpened`, `onChatClosed` | 1,000 ms |
  | event handlers | 1,000 ms |
  | `activate` | 2,000 ms |

  All configurable through `RegistryOptions`.
- **`beforeSend` chains.** Each hook sees the draft the previous one produced.
  `cancelSend(reason)` stops the chain and the host should not send. A hook
  cannot change `chatId`. Results must be non-empty text up to 20,000
  characters.
- **`transformPromptNotes` is additive.** Hooks receive a frozen copy of the
  notes (mutation throws) and can only prepend or append. Each line is
  flattened to one line, stripped of control characters and of the notes
  block markers, and dropped whole if it does not fit. Budget defaults:
  320 characters total, 160 per extension, 160 per line (each line costs its
  length plus one). The built-in notes keep their own 700-character cap, so
  extensions can never crowd them out. Lines dropped for budget count as a
  failure of kind `budget`.
- **Observers** (`afterReply`, lifecycle, events) run sequentially, results
  ignored.

## Error isolation

Guarantees:

1. An exception in any hook, command, action, `when`, `render`, or
   `activate` is caught, logged against the extension, and counted.
2. A hook that does not settle within its timeout is abandoned (its result is
   ignored if it arrives later) and counted.
3. Failures are counted in a sliding window (default 5 within 10 minutes).
   Crossing it turns the extension off with `disabledBy: "auto"` and a
   user-visible `statusReason` including the last error. Auto-disable is not
   persisted: it is lifted by restarting or by the user pressing Enable
   (which resets the count).
4. Disabling or removing an extension removes every command, section, tool,
   hook, and event listener it registered. A saved reference to the context
   goes inert: registration calls throw, callbacks stop firing.
5. One extension's failure never affects another's hook run, and a broken
   subscriber never blocks other subscribers.
6. React rendering is contained by an error boundary per contribution.

Limits of in-process isolation (the reason for tier 3): a synchronous infinite
loop or heavy CPU use inside a hook cannot be preempted, and extension code can
reach globals such as `window`. Built-in extensions are reviewed code;
untrusted code does not run in-process.

## Permissions

| Permission | Status | Grants |
| --- | --- | --- |
| `chat:read` | granted | Real message text and chat titles in message actions and hooks; `afterReply`, `onChatOpened/Closed`; message, character, and persona events. Without it, text and titles arrive as empty strings. |
| `chat:write` | granted | Register `beforeSend`. |
| `prompt:notes` | granted | Register `transformPromptNotes`. |
| `ui:commands` | granted | Register palette commands. |
| `ui:settings` | granted | Register Settings sections. |
| `ui:message-actions` | granted | Register message toolbar buttons. |
| `ui:composer` | granted | Register composer controls. |
| `storage` | granted | Use `ctx.storage`. |
| `network` | **denied** | Reserved. Glee is offline; an extension that declares it is marked `incompatible` and never starts. |
| `memory:read` | reserved | Accepted, grants nothing yet; reserved for a memory API in a later minor version. |

Enforcement: each context function checks the declared set and throws
`PermissionDeniedError` naming the missing permission. Throwing inside
`activate` marks the extension `failed` with that message, so a missing
permission is found the first time the extension runs.

## Data packs

Packs are JSON documents. The loader never executes anything and rejects
rather than repairs. Every pack:

```json
{
  "schemaVersion": 1,
  "kind": "characters | context | personas | snippets | theme",
  "name": "Harbour set",
  "description": "optional",
  "author": "optional",
  "version": "1.0.0"
}
```

plus one payload key: `characters`, `entries`, `personas`, `snippets`, or `theme`.
Unknown fields anywhere are errors. Input over 1,000,000 characters is refused
before parsing. Errors come back as `{ path, message }` pairs, up to 25, e.g.
`characters[2].tags[0]: Is 53 characters; the limit is 40.`

Text rules: control characters (except tab and newline) and bidirectional
override characters are rejected; names and keywords must be one line; CRLF
becomes LF.

### Character packs

```json
{
  "schemaVersion": 1,
  "kind": "characters",
  "name": "Harbour set",
  "characters": [
    {
      "name": "Mira",
      "description": "A harbour pilot.",
      "personality": "Dry humour, patient.",
      "systemPrompt": "Stay in character.",
      "greeting": "Tide's turning.",
      "alternateGreetings": ["Hello again."],
      "tags": ["sea"],
      "exampleDialogue": "{{user}}: hi\n{{char}}: Welcome aboard."
    }
  ]
}
```

Fields are the character fields the editor has, without `avatar` and
`cardExtensions` (packs are text only). Card-style names are accepted as
aliases, matching `src-tauri/src/character_card.rs`: `first_mes`,
`mes_example`, `system_prompt`, `post_history_instructions`,
`alternate_greetings`, `creator_notes`, `character_version`, `char_name`,
`char_persona`, `world_scenario`, and a `{ "spec": ..., "data": {...} }`
wrapper. Giving a field under two spellings is an error. Limits: 50 characters
per pack; name 100; most prose fields 4,000; backstory, system prompt, and
example dialogue 8,000; 25 tags of 40; 10 alternate greetings.

### Context (lorebook) packs

```json
{
  "schemaVersion": 1,
  "kind": "context",
  "name": "Harbour lore",
  "entries": [
    {
      "title": "The lighthouse",
      "keywords": ["lighthouse", "beacon"],
      "content": "It guards the bay and has not been dark in a century.",
      "scope": "global"
    },
    {
      "scope": "character",
      "characterName": "Mira",
      "title": "Mira's boat",
      "keywords": ["boat"],
      "content": "A small blue cutter called Wren."
    }
  ]
}
```

`scope` defaults to `global`. A pack cannot know character ids, so character
scope carries `characterName` and the host resolves it. `enabled` defaults to
true. Limits: 500 entries; title 100; content 4,000; 20 keywords of 60.

### Persona packs

`personas: [{ "name", "about"?, "preferences"? }]`, up to 50; `about` and
`preferences` 4,000 characters each.

### Prompt snippet packs

```json
{
  "schemaVersion": 1,
  "kind": "snippets",
  "name": "Tone helpers",
  "snippets": [
    { "id": "calm-tone", "name": "Calm tone", "text": "Keep a calm tone.", "enabledByDefault": false }
  ]
}
```

`id` is lowercase letters, digits, and dashes (40 max), unique within the pack.
`text` is at most 400 characters and 4 lines. Enabled snippets reach the
prompt only through the built-in `glee.prompt-snippets` extension, within the
note budget. Snippets are namespaced by pack name (`snippetKey(pack, id)`).

### Theme packs

```json
{
  "schemaVersion": 1,
  "kind": "theme",
  "name": "Harbour dusk",
  "theme": {
    "base": "black",
    "colorScheme": "dark",
    "variables": {
      "--bg": "#10151c",
      "--text": "rgb(230, 236, 244)",
      "--surface-shell": "linear-gradient(180deg, #17202b 0, #10151c 100%)",
      "--shadow-sm": "0 12px 28px rgba(0, 0, 0, 0.28)"
    }
  }
}
```

Only variables in `THEME_VARIABLES` are accepted: the colour, gradient, shadow,
font, and motion tokens of the `:root` and `html[data-theme]` blocks in
`App.css` (layout variables such as rail widths are excluded so a pack cannot
break the shell). A test fails if the list drifts from the stylesheet, and
another checks that every value in the shipped themes passes validation.

Values are checked by an allow-list parser, not a deny-list. Accepted: hex
colours, `rgb/rgba/hsl/hsla()`, `linear-gradient()`/`radial-gradient()` of
those, numbers with `px rem em % deg turn`, a short keyword set
(`transparent`, `inset`, `to top`, ...), and `var(--x)` where `--x` is itself
whitelisted. Shadows allow no gradients or `var()`. Fonts are plain family
names or a reference to another `--font-*` variable. Durations look like
`140ms`; easings are keywords or `cubic-bezier(a, b, c, d)`. Everything else
is refused, including `url()`, `image-set()`, `element()`, `expression()`,
`@import`, `javascript:`, `attr()`, `env()`, `calc()`, `var()` fallbacks,
semicolons, braces, backslashes, comments, `!important`, nesting deeper than
four levels, and values over 300 characters. `base` must be a built-in theme id.

### Installing a pack

`applyPack(pack, targets)` hands validated items to callbacks the app provides:

```ts
interface PackTargets {
  createCharacter(item): Promise<unknown>;
  createContextEntry(item): Promise<unknown>;   // resolve characterName -> id here
  createPersona(item): Promise<unknown>;
  setTheme(theme, packName): void | Promise<void>; // set properties on <html>
  registerSnippet(snippet): void | Promise<void>; // snippetLibrary.add(...)
}
```

It applies items one at a time and returns `{ applied, failed: [{ label, error }] }`;
one failure does not stop the rest. Show the user a preview (name, author,
counts) before calling it.

## Versioning and compatibility

- `API_VERSION` is `1.0.0`. An extension declares `apiVersion: "1"` or
  `"1.2"`.
- **Compatible** means the same major version and the extension's minor is not
  newer than the host's. Patch is ignored.
- Within a major version the API only grows: new optional fields, new events,
  new hooks, new permissions. Removing or changing the meaning of anything
  needs a major bump, and the host keeps loading the previous major for at
  least one release where practical.
- An incompatible extension is registered as `incompatible` with the reason
  ("Needs extension API 2.x but this app provides 1.x."), never half-started.
- Pack `schemaVersion` is separate and currently `1`. Newer packs are refused
  with "made for a newer version of Glee".
- A new permission is never granted implicitly: an extension that wants it
  must declare it, and for tier 3 re-prompt the user.

## Security

In-process extensions are trusted code. What protects the user from mistakes
(not malice):

- Capability objects, not globals: the context has no store, IPC, or
  filesystem reference, so a buggy extension cannot corrupt chat data.
- Declared permissions, enforced at call time.
- Output limits: notices, clipboard text, note lines, draft size, storage size.
- Host-performed effects: the clipboard and notices are never touched by
  extension code through the API.
- Data packs cannot run code and are validated before anything is written.
- The network is not available to the API at all (`network` is denied).

What it does not protect against: a hostile in-process extension can still use
browser globals. That is why only built-in code runs in-process today.

## Tier 3: sandboxed script plugins (design)

Not implemented. Goal: let users install third-party plugins without trusting
them.

**Packaging.** A plugin is a folder or `.gleeplugin` archive: `manifest.json`
(the `Extension` metadata fields plus `entry`), one JavaScript entry file, and
optional assets. The manifest lists `permissions`, `apiVersion`, and the
SHA-256 of every file. Installing computes and displays the bundle hash; the
bundle is stored read-only. Optional detached signatures (Ed25519) allow a
"verified publisher" badge, but an unsigned plugin can still be installed after
a clear warning. Updates require the same signer or a new prompt.

**Sandbox.** Each plugin runs in its own isolated context:

- Preferred: a dedicated `Worker` created from a `blob:` URL of the verified
  entry file, inside a sandboxed `<iframe sandbox="allow-scripts">` with a
  null origin and a strict CSP (`default-src 'none'; script-src blob:`;
  `connect-src 'none'`). The iframe has no same-origin access to the app or its
  storage. Tauri scopes IPC by origin and capability; before relying on this,
  verify with a test plugin that a null-origin frame cannot reach the IPC
  bridge, and add a capability rule denying it if it can.
- UI contributions that need rendering (settings sections, composer tools) are
  described declaratively (a small component vocabulary: text, toggle, select,
  button, list) and drawn by the host, or rendered inside the same sandboxed
  iframe and placed in a host-owned frame. Plugins never receive host DOM
  nodes or React elements.

**Transport.** A `postMessage` RPC maps one-to-one onto `ExtensionContext`:

```text
plugin                         host
  │ { id, method: "commands.register", params } ─────────────▶ permission check
  │ ◀──────────── { id, result | error }                      registry.register
  │ ◀── { method: "hook.beforeSend", params: draft } ─────────  pipeline runner
  │ { id, result } ─────────────────────────────────────────▶  timeout + validation
```

Callbacks become opaque handles (`hookId`) the host invokes by message. Every
payload is structured-cloneable JSON and is validated with the same shape
checks the in-process path already applies (the pipeline treats results as
untrusted today). Timeouts become enforceable for real: a plugin that misses a
deadline is `terminate()`d, and a CPU-bound loop only stalls its own Worker.

**Permissions.** The manifest's permissions are shown at install time in
plain language (the descriptions in `PERMISSION_INFO`), with the dangerous
ones (`chat:read`, `chat:write`) highlighted, and stored with the bundle hash.
The host builds the same permission-gated context it uses today and exposes
only that over RPC; a method outside the grant answers with a
`PermissionDeniedError`. Changing the permission set or the bundle hash
disables the plugin until the user approves again.

**No network by default.** The CSP forbids connections and `network` stays
denied. If it is ever offered, it will be a host-mediated `fetch` restricted to
origins listed in the manifest, shown at install time, with size and rate
limits and no cookies, never raw sockets.

**Resource limits.** Per-plugin message rate and payload caps, a memory
ceiling where the platform allows, the same failure window and auto-disable,
and a kill switch in Settings.

**Migration path.** (1) Wire the in-process registry and move features to
tier 1. (2) Ship pack installation (tier 2). (3) Add a `PluginHost` that
implements `ExtensionContext` over RPC and registers a proxy `Extension` per
plugin in the existing registry, so permissions, ordering, isolation, and UI
code are unchanged. (4) Add install UI, hash and signature checks.

## How to wire it in

Names below are the nearest existing functions; line numbers move, so search
for them. Nothing in `src/extensions/` imports the app, so each step is
additive.

### 1. Create and start the registry

In `src/main.tsx` (or a small `src/extensions-runtime.ts` imported by it):

```ts
const snippetLibrary = createSnippetLibrary();
export const extensionRegistry = createDefaultRegistry({
  snippetLibrary,
  storage: createBrowserStorageAdapter(),
  host: {
    notify: ({ kind, message }) => appStore.getState().setNotice({ kind, message }),
    copyText: (text) => navigator.clipboard.writeText(text),
  },
});
```

Wrap `<App />` in `<ExtensionProvider registry={extensionRegistry}>` inside
`AppErrorBoundary`, and call `void extensionRegistry.start()` after bootstrap
(`features/bootstrap/use-bootstrap.ts`) or at module load. Check the exact
`NoticeState` shape in `stores/app-store.ts` when binding `notify`.

### 2. Command palette

`App.tsx`, `commandActions` (the IIFE that builds the `actions` array, passed to
`useCommandPalette(commandActions)`). Add
`const extensionCommands = useRegisteredCommands();` near the other hooks and
append `...extensionCommands` to the returned array. `CommandView` already has
the `CommandAction` shape (`id`, `label`, `hint`, `run`), and `runCommand` in
`use-command-palette.ts` already awaits `run()`.

### 3. Message toolbar

`App.tsx`, the message list: the `<div className="bubble-tools">` that holds
Edit / Regenerate (the non-editing one, guarded by `!isEditing`). Hooks cannot
be called inside the `.map`, so extract a small component, for example
`MessageExtensionActions({ message, chat })`, that calls
`useMessageActions(message, chat)` and renders
`<button className="ghost" onClick={() => void action.run()}>{action.label}</button>`
for each result. Build `MessageView`/`ChatView` from `ChatMessage` and
`ChatSummary` (fields map one-to-one; `participantIds` from the chat). Put it
after the Regenerate block.

### 4. Composer

`App.tsx`, inside `<form className="composer-box">`, directly above
`{groupChatActive && ... <GroupReplyControls />}` and `<PersonaPicker />`. Render
`<ComposerExtensionTools />`, a component that maps `useComposerTools()` to
`<Fragment key={tool.id}>{tool.node}</Fragment>`. (Later, `PersonaPicker` and
`GroupReplyControls` can themselves become composer tools registered by
built-in extensions.)

### 5. Settings modal

`App.tsx`, the Settings dialog (`settingsOpen`, `<div className="settings-grid">`).
After the last built-in `settings-section`, render
`useSettingsSections()` as
`<section key={s.id} className="detail-section settings-section"><h4>{s.title}</h4>{s.node}</section>`.
Add an "Extensions" section listing `useExtensions()` with a toggle per row
(`registry.enable/disable`), `statusReason`, `failureCount`, and the permission
list (`PERMISSION_INFO` for wording).

### 6. Chat pipeline

All in `src/features/chat/`. Get the registry with `useExtensionRegistry()` in
`use-chat-orchestration.ts`.

- **`beforeSend`**: in `sendMessage`, right after `text` is trimmed and the
  runtime/queue guards pass, before `appendMessage({ role: "user" })`:

  ```ts
  const outcome = await registry.beforeSend({ chatId: activeChat.id, text });
  if (outcome.cancelled) { setNotice({ kind: "info", message: outcome.cancelled.reason ?? "Message not sent." }); return; }
  const finalText = outcome.draft.text;
  ```

  Use `finalText` for `appendMessage`, the queued `ReplyTask.text`, and the
  composer-clear comparison. Do not clear the composer on cancel.
- **`transformPromptNotes`**: in `streamAssistantReplyText`, `prepareResponseRequest`
  is synchronous and builds the notes inside `toLlamaChatMessages`
  (`runtime-adapters/llama.ts`, via `mergeTurnNotes(turn, TURN_NOTES_CHARS)`),
  so add two small seams:
  1. in `llama.ts`, export `buildTurnNoteLines(compiledPrompt): string[]`
     (the `mergeTurnNotes(...).split("\n")` part) and give
     `toLlamaChatMessages`/`toLlamaChatRequest` an optional `turnNotes?: string[]`
     that replaces the computed notes when present;
  2. in `streamAssistantReplyText`, after `prepareResponseRequest`:

     ```ts
     const base = buildTurnNoteLines(preparedResponse.compiledPrompt);
     const { notes, added } = await registry.transformPromptNotes(base, {
       chatId, characterId: speaker?.id, participantIds, isGroup: mode === "group",
       isRegeneration, userText: latestUserText,
     });
     if (added.length > 0) {
       requestBody = toLlamaChatRequest({ ...sameInputs, turnNotes: notes });
     }
     ```

     Rebuilding the request is cheap (pure) and only happens when an
     extension contributed, so the common path is unchanged. Keep the stable
     system message untouched: extension lines only ride in the per-turn
     notes, preserving the prompt-cache behaviour described above.
- **`afterReply`**: in `appendAssistantReplyWithFallback`, after the successful
  `appendMessageFn` for the generated reply (not the generation-failure
  message), call `void registry.afterReply({ chatId, messageId: appended.id,
  speakerCharacterId: appended.speakerCharacterId, content: appended.content })`.
  Do not await it.
- **`onChatOpened` / `onChatClosed`**: where the active chat id changes. Simplest
  is a `useEffect` in `App.tsx` on `activeChatId` that calls `chatClosed(prev)`
  and `chatOpened(next)`, building `ChatView` from `chats`; or subscribe to
  `chatStore` once (step 7).
- **Events**: one `src/features/app/app-events.ts` that subscribes to the
  zustand stores and calls `registry.emit`: `chatStore` (`messagesByChat`
  growth to `chat:message-added`), `modelStore` (`runtime.status` to
  `runtime:status-changed`), `characterStore` (`activeCharacterId` to
  `character:changed`), `profile`/preset stores for `persona:changed`. Emitting
  from one place avoids touching every call site.

### 7. Pack installation

Add an import action (palette command or Settings button) that reads a file,
calls `loadPack`, shows the preview or errors, then `applyPack` with:
`createCharacter` to `api.createCharacter`, `createContextEntry` to
`api.createContextEntry` (look up `characterName` in `characterStore` for
character scope), `createPersona` to `api.createPersona`, `setTheme` to
`document.documentElement.style.setProperty` per variable (clear them when the
user picks a built-in theme in `theme-domain.ts`; persist the pack under
`glee.ui.theme-pack`), `registerSnippet` to `snippetLibrary.add({ key:
snippetKey(pack, id), ... })` (and persist pack contents; the built-in only
persists which snippets are enabled).

### Wiring checklist

- [ ] Registry created, provider mounted, `start()` called.
- [ ] `useRegisteredCommands()` appended to palette actions.
- [ ] Message toolbar slot (component, not hook-in-map).
- [ ] Composer slot above `GroupReplyControls`/`PersonaPicker`.
- [ ] Settings: extension sections and an Extensions manager list.
- [ ] `beforeSend` in `sendMessage`.
- [ ] `buildTurnNoteLines` + `turnNotes` override + `transformPromptNotes` in `streamAssistantReplyText`.
- [ ] `afterReply` after the persisted reply.
- [ ] `app-events.ts` store subscriber and chat opened/closed.
- [ ] Pack import UI with `applyPack` targets.

## Writing and testing an extension

Keep an extension in one file, declare the fewest permissions, and test it
against a real registry with an in-memory adapter:

```ts
const registry = new ExtensionRegistry({ host: { copyText, notify } });
registry.register(myExtension);
await registry.start();
const [action] = registry.listMessageActions(message, chat);
await action.run();
```

`src/extensions/testing/misbehaving.ts` is a deliberately hostile extension
(throws, hangs, overflows the note budget, uses an undeclared permission, leaks
its context) used to prove the isolation guarantees; reuse it when changing the
registry. Timeouts are testable with fake timers.
