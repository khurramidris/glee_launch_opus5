# Architecture

Glee is a [Tauri 2](https://tauri.app) desktop app. React draws the interface,
Rust owns everything that touches the disk or other processes, and two local
[llama.cpp](https://github.com/PrismML-Eng/llama.cpp) servers run the AI.

```text
React UI ── Tauri commands ──> Rust backend ──> SQLite (+ sqlite-vec)
   │                              │
   │  HTTP via the Tauri          ├─ starts/stops ─> llama-server (chat model)
   │  HTTP plugin, per-launch     └─ starts/stops ─> llama-server (embeddings)
   └─ API key ─────────────────────────────────────> chat llama-server
```

## First run: AI resources

The installer contains only the app. `src-tauri/resources/manifest.json` is
compiled into the binary and pins every AI file with a size and SHA-256 hash:

- the chat model (Ternary Bonsai 2 4B, PQ2_0 GGUF, PrismML's packing with fast CPU, Metal, and Vulkan kernels),
- the embedding model (BGE Small EN v1.5),
- one llama.cpp archive per platform (Windows CPU and Vulkan, macOS Apple
  Silicon (Metal) and Intel, Linux CPU for development).

On launch the frontend asks `resource_status`. If anything is missing,
`prepare_first_run_resources` (`src-tauri/src/resources.rs`) downloads it:

1. Each file is tried from the configured mirrors first
   (`<mirror>/<sha256>/<file name>`), then from its upstream URL.
2. Downloads resume with HTTP Range requests and survive dropped connections.
3. The SHA-256 is computed while downloading and must match the manifest.
4. Engine archives (zip or tar.gz) are extracted into a staging folder with
   path checks, then moved into place.
5. `installed.json` records what was verified, so later launches only compare
   file sizes and timestamps instead of re-hashing gigabytes.

Optional components (Vulkan on Windows) never block setup.

## Starting the model

`runtime_selection.rs` picks the engine and GPU settings:

- **Apple Silicon:** the Metal build with all layers on the GPU.
- **Windows:** the Vulkan build is asked to list its devices. A dedicated GPU
  with at least 3 GB of memory is used automatically; integrated and software
  GPUs stay on the CPU unless the user chooses GPU in Settings. A GPU launch
  that fails falls back to the CPU build.
- **Everything else:** the CPU build.

`runtime_manager.rs` launches `llama-server` bound to `127.0.0.1` on a free
port with a fresh API key file, `--no-webui`, and `--no-slots`, waits for
`/health`, and records process ownership so an orphaned server is cleaned up
on the next start. The chat server uses an 8,192-token context, the model's
non-thinking mode (`--reasoning off`), and the model author's recommended
sampling.

## Writing a reply

`src/features/chat/use-chat-orchestration.ts` coordinates each turn, and
`src/features/chat/response-system/` builds the prompt: it interprets the
latest message, gathers character, persona, scene, and memory context, and
ranks what matters for this turn.

The runtime adapter (`runtime-adapters/llama.ts`) turns that into chat
messages so that the **system message stays identical between turns** (the
character, persona, and rules), while short per-turn notes ride on the newest
user message: a one-line read of the latest move, live scene facts, memory,
and group-round hints, capped at about 700 characters. This lets llama-server
reuse its prompt cache and keeps the text it must re-read small, which keeps
replies fast on a CPU. Replies stream back, are cleaned up, checked, and
stored.

## Data

SQLite is the source of truth for characters, chats, messages, personas,
presets, memory, and settings. Migrations take a backup first, and manual
backups can be restored from Settings. Vector search uses sqlite-vec, compiled
into the app.

## Module map

### Frontend (`src/`)

| Area | Role | Size / shape |
| --- | --- | --- |
| `App.tsx` | Layout, every modal, palette actions, message list, composer | about 5,000 lines, one component with roughly 45 `useState`/`useRef` calls |
| `features/*` | Domain hooks and pure helpers (`use-personas`, `use-character-management`, `theme-domain`, ...) | small files, mostly tested |
| `features/chat/response-system/` | Pure prompt pipeline: interpret, plan, rank, compile | no React, no stores, no IPC |
| `features/chat/runtime-adapters/llama.ts` | Turns a compiled prompt into llama-server chat messages | pure |
| `features/chat/use-chat-orchestration.ts` | Queueing, streaming, repair, persistence, group rounds | about 2,300 lines, one hook |
| `stores/*` | Zustand stores, one per concern (chat, character, model, profile, preset, persona, context, app, diagnostics, runtime settings, update) | five of them call `api/tauri` directly |
| `api/tauri.ts` | Every IPC call and the raw-to-domain mapping | about 1,800 lines, one file |
| `lib/*` | Small pure utilities (SSE parser, chat helpers, runtime fetch) | pure |
| `extensions/*` | Extension registry, pipeline, declarative packs, built-in examples | new, see [EXTENSIONS.md](EXTENSIONS.md) |

### Backend (`src-tauri/src/`)

| Module | Role |
| --- | --- |
| `lib.rs` | Process wiring, about 70 `#[tauri::command]` handlers, state types, and about 1,900 lines of tests |
| `db/*.rs` | SQLite access split by table family (`characters`, `chats`, `messages`, `memory`, `presets`, `profiles`, `settings`, ...); `db/mod.rs` owns the connection, migrations, and backups |
| `resources.rs`, `runtime_selection.rs`, `runtime_manager.rs`, `gpu_check.rs` | First-run downloads, engine choice, process lifecycle |
| `character_card.rs`, `portraits.rs` | Card import and avatar files |
| `embedding_service.rs`, `memory_service.rs` | Embedding server and retrieval |
| `types.rs`, `errors.rs` | Shared records and the error type |

### Dependency directions

```text
App.tsx ──> features/* ──> stores/* ──> api/tauri.ts ──> Rust commands ──> db/*
   │             │
   │             └──> response-system (pure) ──> runtime-adapters (pure)
   └──> extensions (registry, via a provider)
```

The arrows that should hold, and do: `response-system`, `runtime-adapters`,
`lib`, and the `*-domain` files import nothing from React, stores, or IPC.
`extensions/` core imports only its own files (React types are type-only).
On the Rust side `resources.rs` depends only on `types`/`errors`,
`runtime_selection.rs` adds `resources`, and `db/*` depends on `types`/`errors`.
One wart: `db/*` reaches back into `lib.rs` for `GENERATION_FAILURE_PREFIX`;
that constant belongs in `types.rs`.

## Modularity audit

### Where it is good

- **Prompt building is a pure library.** `response-system/` is plain functions
  over plain data with its own test corpus. It can change without touching UI.
- **`resources.rs`, `runtime_selection.rs`, `runtime_manager.rs`** each own one
  decision (what to download, which engine, how to supervise it) behind small
  public functions, with tests next to the code.
- **`db/*.rs` is split by table family**, so a schema change usually touches one
  file plus a migration.
- **`features/*` hooks** (`use-personas`, `use-preset-management`,
  `use-runtime-management`, ...) are the right unit: one concern, one hook,
  returning state and handlers.
- **Domain helpers are testable.** `theme-domain`, `persona-domain`,
  `app-domain`, `reply-presentation` are pure and covered.

### Where it is weak

1. **`App.tsx` is a monolith.** All modals, the message list, the composer,
   and the palette are inline. Handlers are threaded through the one component,
   so anything new (a button, a setting) means editing a 5,000-line file, and
   merge conflicts are likely when two features land together. Sub-trees are
   not memoised, so a streaming token re-renders everything.
2. **Props explosion.** Where `App.tsx` does hand pieces out (`GroupReplyControls`,
   `PersonaPicker`, the character editor), they take 8-20 props that are
   mostly store fields and callbacks the parent already read from the same
   stores. A component that read its own store slice would need two props.
3. **`lib.rs` holds every command and every test.** Adding a command means
   editing the registration list, the handler, and a shared test module in the
   same 5,800-line file. Command handlers mix argument parsing, orchestration,
   and domain logic.
4. **Store coupling.** Five stores import `api/tauri` and fetch inside actions,
   so a store cannot be tested or reused without mocking IPC, and two stores
   (`chat-store`, `model-store`) are read directly by non-React modules
   (`auto-summary.ts`) through the store singletons. There is no event layer:
   features that care about "a message was added" or "runtime status changed"
   each poll or re-derive it.
5. **Chat orchestration does many jobs.** `use-chat-orchestration.ts` queues
   replies, builds the request, streams and parses SSE, repairs bad output,
   persists messages, runs group rounds, regenerates, and manages memory
   refresh. It reads six stores, so every job is coupled to every other and
   there is no seam to hook behaviour into without editing it.
6. **`api/tauri.ts` is one file** mixing wire types, mapping, and about 80
   functions; every feature imports from it.
7. **`db/mod.rs`** still owns migrations, backup logic, and integrity checks in
   one large file.

## Refactor roadmap

Ordered by value over risk. Each step is independently shippable and keeps the
tests green. "Seam" means the extension points in `src/extensions/` are the
reason the step is worth doing first.

| # | Step | What moves where | Risk | Why now |
| --- | --- | --- | --- | --- |
| 1 | **Wire the extension registry** | `ExtensionProvider` at the root; palette, message toolbar, composer slot, and Settings sections read from it (see [EXTENSIONS.md](EXTENSIONS.md#how-to-wire-it-in)). Built-ins register at startup | Low: additive, behind empty lists | Creates the seams the rest of the roadmap uses; no behaviour change until something registers |
| 2 | **Chat pipeline seams** | Add `beforeSend`, turn-notes override, and `afterReply` call sites in `use-chat-orchestration.ts` and `llama.ts` | Low-medium: hot path, but every hook fails open | Makes later features (and plugins) additions instead of edits |
| 3 | **Extract Settings sections** | One file per section under `features/settings/` (theme, runtime, backups, diagnostics, extensions manager), each reading its own stores; `App.tsx` renders a list | Low: moves JSX, no logic | Biggest cut of `App.tsx` with the least coupling |
| 4 | **Extract the message list** | `features/chat/message-list.tsx` + `message-bubble.tsx` (memoised per message); bubble toolbar becomes a component with the extension actions slot | Medium: streaming scroll-pinning refs must move with it | Fixes full-tree re-render on every token |
| 5 | **Extract the composer** | `features/chat/composer.tsx` owning draft, textarea sizing, send; slots for persona picker, group controls, extension tools | Medium: focus and IME behaviour | Removes the largest props cluster |
| 6 | **Extract modals** | Group builder, profile, character profile, onboarding into `features/*/` components that take ids, not state | Low-medium | Each is self-contained; shrinks `App.tsx` below 1,500 lines |
| 7 | **Split orchestration** | `reply-queue.ts` (queue + abort), `reply-stream.ts` (request, SSE, repair), `reply-persist.ts` (append, memory refresh), thin `use-chat-orchestration.ts` composing them | High: the core loop; do it with the existing orchestration tests as a net and one commit per piece | Only after steps 1-2, so the new modules have stable seams |
| 8 | **Event emission from stores** | Emit `chat:message-added`, `runtime:status-changed`, `character:changed`, `persona:changed` into the registry's bus from a single `app-events.ts` subscriber, not from every call site | Low | Feeds extensions without coupling stores to them |
| 9 | **Stores stop calling IPC** | Move fetching into `features/*` hooks or a service layer; stores keep state and pure reducers | Medium: wide but mechanical | Makes stores testable and reusable |
| 10 | **Split `api/tauri.ts`** | `api/characters.ts`, `api/chats.ts`, `api/runtime.ts`, ... re-exported from `api/index.ts` so imports do not change | Low | Pure file moves |
| 11 | **Split `lib.rs`** | `commands/{resources,runtime,characters,chats,memory,settings,...}.rs` each with its handlers and tests; `lib.rs` keeps `run()` and the handler list | Low-medium: mechanical, but one big diff; do it when no other Rust work is in flight | Smaller review units, parallel work |
| 12 | **Split `db/mod.rs`** | `db/migrations.rs`, `db/backup.rs`, `db/integrity.rs` | Medium: migration code is safety-critical; move without edits, then clean up | Last, because it changes least |

Rules for every step: move first, change second; keep each commit
reviewable on its own; no step may change a Tauri command name or a persisted
shape.

## Extensions

Features that can be added or removed without editing the shell live behind
`src/extensions/`: a typed in-process registry, a chat pipeline with timeouts
and a prompt-note budget, and data-only packs for characters, context,
personas, prompt snippets, and themes. The design, API, and security model are
in [EXTENSIONS.md](EXTENSIONS.md).

## Security boundaries

- The WebView can only call the backend's commands and the local engine port.
- The local engine requires a per-launch key and exposes no web UI or slot data.
- All downloaded executable code and models are hash-verified before use.
- Diagnostics exports replace local paths and the account name with placeholders.
- Extensions run in-process with only the capabilities they declare; packs are
  validated data and never execute code. Third-party script plugins are not
  supported until the sandbox described in [EXTENSIONS.md](EXTENSIONS.md) exists.
