# Changelog

All notable changes to Glee are documented here. Glee follows
[Semantic Versioning](https://semver.org/).

## [0.2.0]

### Added
- **Long-term memory:** characters remember facts about you and what you did
  together across chats. Memories are written in the background, recalled when
  relevant, and shown in a Memories screen where you can edit, pin or delete
  them.
- **Update notifications:** Glee tells you when a newer version exists and can
  download and open the installer for you (Settings, Updates).
- **Finish setup from inside the app:** an interrupted AI download resumes from
  where it stopped, with a banner and progress, no restart needed.
- **Extensions foundation:** an internal extension registry, safe data packs,
  and documentation for building on Glee (docs/EXTENSIONS.md).
- **AI & Models** in Settings for everyone: see which model is running and
  where (processor or graphics), switch models, add a `.gguf` model file, run
  on the processor only, and pause or resume the AI.
- **Personas:** save other versions of yourself and pick one per chat from the
  box above the message field.
- **Delete any message**, **edit character replies**, **rename chats**, and a
  **Create Group Chat** button on the home screen.
- **Group chats:** choose who answers your next message, or ask a character
  to speak without sending anything.
- **Backups:** save a copy of any backup to a folder you choose, and restore a
  backup file from another computer.
- **Automatic chat summaries:** long chats keep a running summary of what
  scrolled out of the model's context, written by the model in the background.
- **Update notifications:** Glee checks GitHub for new versions and offers a
  one-click download that is verified before it opens the installer. Turn it
  off under Settings → Updates.
- Chat export and character-card export now open a normal "Save as" window.

### Improved
- Shorter, clearer prompts: the model has less to read before each reply, so
  replies start sooner, especially on computers without a graphics card.
- The reply checker no longer throws away good replies (for example ones that
  start with "Of course", recount what another character said, or are cut
  short by the length limit).
- Memory recall skips messages that are already in the conversation and
  ignores weak matches.
- Group chats: when nobody is addressed by name, at most two characters
  answer; names with accents or non-Latin letters are recognised.
- Portraits are copied into Glee's own folder, so they survive moving or
  deleting the original image.

### Fixed
- Exporting character cards failed because the save window was not allowed.
- First-run recovery screen mentioned an installer that does not exist and its
  retry button could not download the AI files.

## [0.1.0]

First public release.

- Chat with AI characters that run entirely on your computer, powered by
  Ternary Bonsai 2 4B and llama.cpp.
- Create characters or import character cards (JSON and PNG, V2 and V3).
- Personas, group chats, memory, regenerating, editing, and branching.
- One-time automatic download of the AI model and engine on first launch, with
  progress, resume, retry, and integrity checks.
- Automatic GPU acceleration on Apple Silicon (Metal) and on capable Windows
  graphics cards (Vulkan), with a CPU fallback.
- Local backups, restore, and a diagnostics bundle for support.
- Installers for Windows 10/11 and macOS 14 or newer.
