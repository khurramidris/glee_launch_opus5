<p align="center">
  <img src="brand/assets/glee-icon-white-on-yellow-1024.png" alt="" width="96" height="96">
</p>

<h1 align="center">Glee</h1>

<p align="center"><strong>Private AI characters that live on your computer.</strong></p>

Glee is a desktop app for chatting with AI characters. Create your own
characters or import character cards, choose who you want to be in each chat,
and talk one-on-one or in a group. The AI runs on your own computer: no
account, no subscription, and your conversations never leave your device.

## Download

Get the latest installer from the [Releases](../../releases/latest) page.

| System | File |
| --- | --- |
| Windows 10 or 11 (64-bit) | `Glee_<version>_x64-setup.exe` |
| macOS 14 Sonoma or newer (Apple Silicon or Intel) | `Glee_<version>_universal.dmg` |

Install it like any other app. The first time Glee opens, it downloads its AI
model and engine once (about 1.3 GB). After that, Glee works without an
internet connection. Glee tells you when a new version is out and can
download it for you (turn this off under **Settings → Updates**).

**Computer requirements:** 8 GB of RAM and about 3 GB of free disk space.
A dedicated graphics card or an Apple Silicon Mac makes replies faster but is
not required.

> **First launch of an unsigned build.** Windows may show "Windows protected
> your PC": click **More info → Run anyway**. macOS may say the app can't be
> opened: go to **System Settings → Privacy & Security** and click
> **Open Anyway**.

## What you can do

- **Characters:** create characters with a personality, backstory, scenario,
  greeting, and example dialogue, or import character cards (JSON or PNG, V2
  and V3).
- **Personas:** save other versions of yourself and pick who you are in each
  chat.
- **Group chats:** put several characters in one scene; Glee keeps track of
  who is speaking.
- **Memory:** characters remember what matters from earlier in the chat, and
  long chats keep an automatic summary.
- **Branching and editing:** regenerate replies, edit or delete messages, and
  branch a conversation to try another direction.
- **AI controls:** see which model is running, switch or add `.gguf` models,
  and pause the AI, all from Settings.
- **Backups:** back up, save a copy anywhere, and restore from Settings.

## Privacy

Everything you write stays in a local database on your computer, and replies
are generated on your computer. Glee has no telemetry or analytics. The only
network traffic is the one-time download of the AI files, each checked
against a SHA-256 fingerprint built into the app. See [PRIVACY.md](PRIVACY.md).

## The AI inside

- Chat model: [Ternary Bonsai 2 4B](https://huggingface.co/prism-ml/Ternary-Bonsai-2-4B-gguf)
  by PrismML, a 1.1 GB ternary model based on Qwen3.5-4B (Apache-2.0).
- Engine: [PrismML's llama.cpp](https://github.com/PrismML-Eng/llama.cpp),
  with Metal on Apple Silicon, Vulkan on capable Windows graphics cards, and
  optimized CPU code everywhere else.
- Memory search: BGE Small embeddings with
  [sqlite-vec](https://github.com/asg017/sqlite-vec).

## Build from source

You need [Node.js 22](https://nodejs.org), [pnpm 10](https://pnpm.io),
[Rust](https://rustup.rs), and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your
system.

```sh
pnpm install
pnpm app:dev     # run the desktop app in development mode
pnpm check       # lint, type-check, and unit tests
pnpm app:build   # build an installer for this computer
```

The app downloads the AI files on first run, just like the released version.
See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for details and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how Glee works.

## Contributing

Bug reports, ideas, and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately
as described in [SECURITY.md](SECURITY.md).

## License

Glee is released under the [MIT License](LICENSE). The AI model and engine are
separate projects with their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
