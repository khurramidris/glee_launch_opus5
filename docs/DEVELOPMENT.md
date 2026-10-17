# Development

## Requirements

- Node.js 22 (see `.node-version`) and pnpm 10
- Rust (the version in `rust-toolchain.toml` installs automatically)
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your
  system. On Ubuntu/Debian:

  ```sh
  sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev build-essential pkg-config
  ```

## Running the app

```sh
pnpm install
pnpm app:dev
```

On first launch the app downloads the AI model and engine for your platform
into its app data folder, exactly like a release build. Linux is supported for
development only (CPU).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm app:dev` | Run the desktop app with hot reload |
| `pnpm app:build` | Build an installer for the current platform |
| `pnpm check` | Version check, manifest check, lint, type-check, unit tests |
| `pnpm test:rust` | Rust unit and integration tests |
| `pnpm resources:smoke` | Download this platform's model and engine and chat with them |
| `pnpm eval:model` | The smoke test plus Glee's prompt pipeline against the real model |

## Useful environment variables

| Variable | Purpose |
| --- | --- |
| `GLEE_RESOURCE_MANIFEST` | Use a different resource manifest (for example one that points at a local test server) |
| `GLEE_RESOURCES_DIR` | Store AI files somewhere other than the app data folder |
| `GLEE_MODEL_EVAL_MIN_PASS_RATE` | Share of live-model eval cases that must pass for `pnpm eval:model` to succeed (default `0.8`) |

App data lives in the platform's standard folder for the identifier
`com.glee.desktop` (for example `~/.local/share/com.glee.desktop` on Linux).
Delete it to repeat the first-run experience.

## Project layout

```text
src/                 React interface, stores, and the chat response system
src-tauri/src/       Rust backend: database, AI resources, runtime management
src-tauri/resources/ The pinned AI resource manifest and bundled license texts
scripts/             Release and resource tooling
tests/evals/         Live evaluation against the real model
docs/                Architecture, development, and release guides
```
