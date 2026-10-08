# Release notes — TestHub Run (GitHub Action)

What changed in each release, newest first. `## Unreleased` collects the changes since the last release tag (`vX.Y.Z`, with the moving major tag `v1`). Use its section as the text of the GitHub release (README, *Publishing (maintainers)*).

## Unreleased

Changes since 1.0.0.

### Changed

- **The Agent runs from its git repository**, not npm: `npx -y --package=git+https://github.com/andrianyablonskyy/thub-agent.git#<ref> thub …`. `agent-version: latest` means its newest release tag; a version like `1.1.11` means that release's tag. Anything else is refused.

## 1.0.0 — 2026-10-08

The first release, `v1.0.0`.

### Added

- **Runs a TestHub job from a workflow step**: `url`, `key`, `type`, `command`, plus `labels`, `client`, `download-files`, `env`, `args`, `suite`, `timeout`, `priority`, `meta`, `dry-run` and the USB power inputs (`power-on-start`, `power-on-end`, `power-reset-delay`). The job's log streams into the step, and the step passes or fails with the job (`fail: false` reports only).
- **Job Summary** with the verdict, board, Client, duration, test counts, every test case and the artifacts (`summary`).
- **Pull-request comment**, updated in place on every re-run: one per workflow job (`comment`, `comment-key`, `pr-number`). `comment: on-failure` posts only once something fails.
- **Commit status** `TestHub / <key>`, linking to the job page (`commit-status`).
- **Every test case** in the summary and the comment, from the JUnit XML the job lists in `$THUB_ARTIFACTS_FILE`, fetched with `artifact-headers`.
- **Canceling the workflow cancels the TestHub job**, so the bench is free again.
- **Outputs** for later steps: `job-id`, `job-url`, `state`, `exit-code`, `client`, `board`, `duration-sec`, and the test counts (`total`, `passed`, `failed`, `skipped`).
- Uses the Agent from npm (`agent-version`, default `latest`) or one already installed (`agent`), and installs Node.js 24 first unless `setup-node: false`.
