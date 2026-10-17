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

- the chat model (Ternary Bonsai 2 4B, Q2_0 GGUF),
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
character, persona, and rules), while per-turn notes ride on the newest user
message. This lets llama-server reuse its prompt cache, which keeps replies
fast on a CPU. Replies stream back, are cleaned up, checked, and stored.

## Data

SQLite is the source of truth for characters, chats, messages, personas,
presets, memory, and settings. Migrations take a backup first, and manual
backups can be restored from Settings. Vector search uses sqlite-vec, compiled
into the app.

## Security boundaries

- The WebView can only call the backend's commands and the local engine port.
- The local engine requires a per-launch key and exposes no web UI or slot data.
- All downloaded executable code and models are hash-verified before use.
- Diagnostics exports replace local paths and the account name with placeholders.
