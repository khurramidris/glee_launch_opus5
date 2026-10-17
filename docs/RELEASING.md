# Releasing

## Cut a release

1. Update the version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json` (`pnpm verify:version` checks they match), and
   add an entry to `CHANGELOG.md`.
2. Commit and push to `main`.
3. In the repository's **Actions** tab, open **Release** and click
   **Run workflow** (or push a tag such as `v0.1.1`). The workflow builds the
   Windows installer and the universal macOS disk image and attaches them to
   a **draft** release named after the version.
4. Test the installers, then publish the draft.

## How updates reach users

Glee is not code-signed yet, so it uses its own keyless flow instead of the
signed Tauri updater:

1. The release workflow writes the update address into
   `src-tauri/resources/update-source.json` before building
   (`node scripts/update-source.mjs set <url>`), pointing at
   `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.
   In a normal checkout the file holds an empty address, which turns update
   checks off (development builds). `GLEE_UPDATE_MANIFEST_URL` overrides it
   for testing.
2. After both installers are built, the **Publish update manifest** job finds
   the draft release, downloads the `.exe` and `.dmg` to compute their size
   and SHA-256, adds the notes from the matching `CHANGELOG.md` section, and
   attaches `latest.json` to the draft (`scripts/make-update-manifest.mjs`).
   Set the repository variable `GLEE_MIN_SUPPORTED_VERSION` to force older
   versions to update (they cannot skip it).
3. **Publishing the draft** makes it the repository's `releases/latest`, so
   `latest.json` starts resolving and installed apps see the new version. Drafts
   stay invisible to the app.
4. The app shows a banner, downloads the installer into the Downloads folder
   after the user clicks, verifies size and SHA-256, and opens it. On Windows
   Glee then closes so the installer can replace it; on macOS the user drags
   the app to Applications.

The manifest (schema version 1) lists one asset per platform under
`windows-x64` and `macos-universal`. Asset URLs may only use `https` on
`github.com`, `*.githubusercontent.com`, a host from the resource `mirrors`,
or the host the manifest itself came from.

**Hosting somewhere else.** Upload `latest.json` and the installers to a host
you control and run `node scripts/update-source.mjs set https://host/latest.json`
in the build; the manifest's own host is trusted for its asset URLs.

**Moving to the signed Tauri updater later.** Only `src/api/updates.ts` and
`src-tauri/src/updates.rs` are specific to this flow; the banner and settings
section read the same store.

1. Run `pnpm tauri signer generate -w ~/.tauri/glee.key` and keep the key safe.
2. Add the private key as the repository secret `TAURI_SIGNING_PRIVATE_KEY`
   (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if set).
3. Put the public key in `tauri.conf.json` under `plugins.updater.pubkey`, add
   the `latest.json` endpoint, and set `bundle.createUpdaterArtifacts` to
   `true` so the build produces signed update bundles.
4. Add `tauri-plugin-updater` (Rust and JS), register it, grant
   `updater:default`, and replace the bodies of `check_for_update` /
   `download_update` / `install_update` with the plugin's `check()` and
   `downloadAndInstall()`.
5. Let `tauri-action` upload the updater `latest.json` (`includeUpdaterJson`)
   and drop the **Publish update manifest** job.

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
