# Contributing to Glee

Thanks for helping make Glee better. Bug reports, ideas, documentation fixes,
and code are all welcome.

## Reporting a bug

Open an issue with the bug report form. The most helpful reports include your
Glee version, your operating system, what you expected, what happened, and the
steps to reproduce it. A diagnostics bundle (**Settings → Diagnostics → Export
diagnostics**) helps a lot; it replaces local paths with placeholders, but
please check it before attaching it.

Never post chat logs or files you would not want to be public.

## Making a change

1. Fork the repository and create a branch.
2. Set up your environment as described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
3. Keep the change focused, and add or update tests for the behavior you change.
4. Run the checks:

   ```sh
   pnpm check
   cargo fmt --manifest-path src-tauri/Cargo.toml
   cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

5. Open a pull request that explains what changed and why.

By submitting a pull request, you agree that your contribution is licensed
under the project's [MIT License](LICENSE).

## Ground rules

- Privacy comes first. Conversations must never leave the user's computer, and
  any new network access needs a clear reason and a mention in
  [PRIVACY.md](PRIVACY.md).
- Glee is for people who are not technical. Prefer sensible automatic behavior
  and plain-language messages over new settings.
- Changing the AI model or engine means updating
  `src-tauri/resources/manifest.json` (see [docs/RELEASING.md](docs/RELEASING.md))
  and letting the model smoke test pass on every platform.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
