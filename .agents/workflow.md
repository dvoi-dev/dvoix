# Workflow

## Before the change

- Read `AGENTS.md` and the matching file in `.agents/`.
- Read the affected code before you change it. Follow the existing patterns (take a similar core feature or plugin as the template).
- Clarify unclear requirements briefly, or pick the most obvious reading and name it in the PR.

## During the change

- One topic per branch and PR. Do not rebuild or reformat anything on the side.
- Versions: newest version of Node.js, Rust, dependencies and actions (see basic rule 6 in `AGENTS.md`).
- No secrets, tokens or personal paths in the repo.

## Before the commit

```sh
npm run check
npm run build
npm run test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

All six must be green, just like in the CI. If something could not run (e.g. missing system libraries), say so in the PR.

- Update the README when something changes for users or developers.
- Update these rules (`AGENTS.md`, `.agents/`) when structure, commands or conventions change. They must always match the code.

## Commits and PRs

- Commit messages in English, imperative mood, one summary line (e.g. "Add kanban board as a core plugin"), and if needed a short paragraph with the why.
- PR description: what changes, why, how it was checked. Visible changes with a screenshot.
- Never push directly to `main`, never rewrite other people's branches, never disable tests to get the CI green.

## Releases

- Bump the version everywhere with `npm run bump <version>`, commit it, merge to `main`, then push the matching tag `v<version>`.
- The `Release` workflow runs the CI, builds signed Windows/macOS/Linux bundles and uploads them plus `latest.json` to a draft GitHub release. Publish the draft to activate the in-app update feed.
- Required secrets: `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Optional Apple secrets sign and notarize macOS. Never commit the private updater key.
- Renovate (`renovate.json`) automates dependency updates; the Renovate GitHub App must be installed on the repository.
