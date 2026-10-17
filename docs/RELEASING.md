# Releasing

## Cut a release

1. Update the version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json` (`pnpm verify:version` checks they match), and
   add an entry to `CHANGELOG.md`.
2. Commit, then tag and push:

   ```sh
   git tag v0.1.1
   git push origin v0.1.1
   ```

3. The **Release** workflow builds the Windows installer and the universal
   macOS disk image and attaches them to a **draft** GitHub release.
4. Test the installers, then publish the draft.

## Signing (recommended)

Unsigned builds work, but Windows SmartScreen and macOS Gatekeeper show
warnings on first launch.

- **macOS:** with an Apple Developer account, add these repository secrets and
  the release workflow signs and notarizes automatically: `APPLE_CERTIFICATE`
  (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`.
- **Windows:** sign `*-setup.exe` with an Authenticode certificate (for example
  through SignPath's free program for open-source projects, or a Certum
  open-source certificate). See the Tauri guide on
  [Windows code signing](https://v2.tauri.app/distribute/sign/windows/).

## Changing the AI model or engine

1. Edit `src-tauri/resources/manifest.json`: file name, size, SHA-256, and a
   download URL pinned to an immutable revision (a Hugging Face commit, or a
   GitHub release tag).
2. If the engine's command-line flags change, update `chat_server_args` in
   `src-tauri/src/runtime_selection.rs` and `CHAT_ARGS` in
   `scripts/resources.mjs`.
3. Push. The **Model smoke test** workflow downloads the files on Windows,
   macOS, and Linux, checks their hashes, and chats with the model.
4. If you use a mirror, run the **Upload AI files to the mirror** workflow.

## Download mirror (Cloudflare R2)

By default the app downloads from Hugging Face and GitHub. A mirror you
control keeps downloads working even if those files move.

1. Create an R2 bucket and give it a public custom domain (or enable the
   `r2.dev` URL).
2. Create an R2 API token with write access to the bucket.
3. In the repository settings add secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   and `R2_SECRET_ACCESS_KEY`, and variables `R2_BUCKET` and optionally
   `R2_PREFIX` (for example `glee/`).
4. Run the **Upload AI files to the mirror** workflow.
5. Set the repository variable `GLEE_DOWNLOAD_MIRROR` to the public base URL,
   for example `https://downloads.example.com/glee/`. Releases built after
   that try the mirror first and fall back to the original sources.

Files are stored as `<sha256>/<file name>`, so each version is immutable and
old app versions keep working after you add new models.
