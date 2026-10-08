# TestHub Run — GitHub Action

Run a test job on real lab hardware (or an emulator) through [TestHub](https://github.com/andrianyablonskyy/thub-coordinator), straight from a workflow:

- **One step instead of `npx … thub run`.** The job's log streams into the step, and the step passes or fails with the job.
- **A Job Summary** with the verdict, board, Client, duration, test counts, every test case and the artifacts.
- **A pull-request comment** with the verdict, board, Client, time and links to the job's log and the workflow run. It's updated in place on every re-run, so a PR has one TestHub comment per workflow job, not one per push.
- **An optional commit status** that links straight to the TestHub job page.
- **Canceling the workflow cancels the TestHub job**, so the bench is free again.

```yaml
- uses: andrianyablonskyy/thub-action@v1
  with:
    url: https://thub.example.com
    key: ${{ secrets.THUB_CI_TOKEN }}
    type: hw
    labels: board:nucleo-f401re
    download-files: ${{ needs.build.outputs.image_url }}
    command: st-flash --reset write "$THUB_DOWNLOAD_1" 0x08000000 && ./ci/hw-tests.sh
```

The pull-request comment (and, with every test case, the Job Summary) looks like this:

```
### ❌ TestHub HW smoke: FAILED
| Job      | A-00042                                   |
| Result   | FAILED (exit code 1)                      |
| Board    | nucleo-f401re on lab-hw-01                |
| Tests    | 42 total · 40 passed · 2 failed · 0 skipped |
| Duration | 3m 12s (queued 20s)                       |
| Commit   | abcdef1                                   |
| Links    | Job page and full log · Workflow run      |
▸ Failed tests (2)
```

## A complete workflow

```yaml
name: firmware
on:
  pull_request:
  push:
    branches: [main]

jobs:
  build:
    runs-on: [self-hosted, fw-build]
    outputs:
      image_url: ${{ steps.upload.outputs.image_url }}
    steps:
      - uses: actions/checkout@v4
      - run: cmake -B build -G Ninja && cmake --build build
      - id: upload
        env: { ART_TOKEN: "${{ secrets.ARTIFACTORY_TOKEN }}" }
        run: |
          URL="https://artifactory.example.com/fw-local/app/${GITHUB_SHA::7}-${GITHUB_RUN_NUMBER}/app.bin"
          curl -fsS -H "Authorization: Bearer $ART_TOKEN" -T build/app.bin "$URL"
          echo "image_url=$URL" >> "$GITHUB_OUTPUT"

  test-hw:
    needs: build
    runs-on: ubuntu-latest
    # Hardware runs code from the PR: not for pull requests from forks.
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: read
      pull-requests: write      # the PR comment
      statuses: write           # commit-status: true
    strategy:
      fail-fast: false
      matrix:
        board: [nucleo-f401re, nucleo-l476rg]
    steps:
      - id: thub
        uses: andrianyablonskyy/thub-action@v1
        with:
          url: https://thub.example.com
          key: ${{ secrets.THUB_CI_TOKEN }}
          name: HW smoke (${{ matrix.board }})
          type: hw
          labels: board:${{ matrix.board }}
          download-files: ${{ needs.build.outputs.image_url }}
          env: |
            GH_TOKEN
            REPO=${{ github.repository }}
            SHA=${{ github.event.pull_request.head.sha || github.sha }}
          command: |
            git init -q src && cd src &&
            git fetch -q --depth 1 "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" "$SHA" && git checkout -q FETCH_HEAD &&
            st-flash --reset write "$THUB_DOWNLOAD_1" 0x08000000 && ./ci/hw-tests.sh
          suite: smoke
          timeout: 30m
          power-on-start: reset
          commit-status: true
        env:
          GH_TOKEN: ${{ secrets.TESTS_READ_TOKEN }}

      - if: always() && steps.thub.outputs.job-id
        run: echo "${{ steps.thub.outputs.job-id }} on ${{ steps.thub.outputs.client }}: ${{ steps.thub.outputs.state }}"
```

Each matrix entry gets its own comment (its `name` is part of the comment's key), and each re-run updates it.

## Inputs

| Input | Required | Default | |
|---|---|---|---|
| `url` | ✓ | | The Coordinator, e.g. `https://thub.example.com`. |
| `key` | ✓ | | A CI token (dashboard → **CI tokens**) or a user's access key, from a secret. |
| `type` | ✓ | | `hw` or `sw`. |
| `command` | ✓ | | The job's entry point (`sh -c` on the Client, in its work directory). Its exit code is the verdict. |
| `labels` | | | Labels the Client must have: one per line or comma-separated (`board:nucleo-f401re`). |
| `client` | | | Only this Client (name or id). |
| `download-files` | | | URLs the Client downloads first, one per line (`$THUB_DOWNLOAD_1`, …). |
| `env` | | | Variables for the command, one per line: `NAME=value`, or `NAME` alone to take it from the step's `env:` (keeps secrets out of the job spec's visible fields). |
| `args`, `suite`, `timeout`, `priority` | | | As `thub run --arg` (one per line), `--suite`, `--timeout`, `--priority`. |
| `meta` | | | Extra `key=value` lines. The run's URL, repository, commit, ref, PR and actor are added for you (`githubRun`, `githubSha`, …). |
| `dry-run` | | `false` | Schedule it, but only log what the Client would run. |
| `power-on-start`, `power-on-end`, `power-reset-delay` | | | USB port power on HW Clients (uhubctl): `on`, `off` or `reset`, and the reset's off time in seconds. |
| `name` | | | A title for the summary and the comment, e.g. `HW smoke (nucleo-f401re)`. |
| `fail` | | `true` | Fail the step unless the job PASSED. `false`: report only, and read the outputs. |
| `summary` | | `true` | Write the Job Summary. |
| `comment` | | `true` | The PR comment: `true`, `on-failure` (only once something fails; a later pass updates it to green), or `false`. |
| `comment-key` | | workflow / job / name | What identifies this comment, for updating it. |
| `pr-number` | | the event's PR | For events other than `pull_request` (e.g. `workflow_run`). |
| `commit-status` | | `false` | Also a commit status, `TestHub / <key>`, linking to the job (needs `statuses: write`). |
| `artifact-headers` | | | `Name: value` lines for fetching the JUnit XML the job lists in `$THUB_ARTIFACTS_FILE`, e.g. `Authorization: Bearer ${{ secrets.ART_TOKEN }}`. |
| `github-token` | | `github.token` | For the comment and the status. |
| `agent-version` | | `latest` | The thub-agent version (npm). Pin it for reproducible pipelines. |
| `agent` | | | A command to use instead of `npx thub-agent`, e.g. `thub` on a self-hosted runner that has it. |
| `setup-node` | | `true` | Install Node.js 24 first. `false` if the runner has it. |

## Outputs

`job-id`, `job-url`, `state` (`PASSED`, `FAILED`, `ERROR`, `TIMEOUT`, `LOST`, `CANCELED`), `exit-code`, `client`, `board`, `duration-sec`, `total`, `passed`, `failed`, `skipped`.

## Test results

The Coordinator keeps the JUnit **counts** the Client read from `results/` or `artifacts/`. For a table with **every test case**, have the command publish its JUnit XML and list it in `$THUB_ARTIFACTS_FILE`. The action fetches every listed `.xml` file, using `artifact-headers` if the storage needs credentials:

```yaml
          command: |
            ./ci/hw-tests.sh --junit results/junit.xml; rc=$?
            url="https://artifactory.example.com/qa/$THUB_JOB_ID/junit.xml"
            curl -fsS -H "Authorization: Bearer $ART_TOKEN" -T results/junit.xml "$url" &&
              printf '[{"name":"junit.xml","link":"%s"}]' "$url" > "$THUB_ARTIFACTS_FILE"
            exit $rc
          env: ART_TOKEN
          artifact-headers: "Authorization: Bearer ${{ secrets.ARTIFACTORY_TOKEN }}"
        env:
          ART_TOKEN: ${{ secrets.ARTIFACTORY_TOKEN }}
```

## More examples

**Use the outputs** in later steps, e.g. a chat message or your own gate:

```yaml
      - id: thub
        uses: andrianyablonskyy/thub-action@v1
        with:
          url: https://thub.example.com
          key: ${{ secrets.THUB_CI_TOKEN }}
          type: hw
          labels: board:nucleo-f401re
          command: ./ci/hw-tests.sh
      - if: always() && steps.thub.outputs.job-id
        run: |
          echo "TestHub ${{ steps.thub.outputs.job-id }} on ${{ steps.thub.outputs.client }}: ${{ steps.thub.outputs.state }}"
          echo "${{ steps.thub.outputs.passed }}/${{ steps.thub.outputs.total }} tests passed in ${{ steps.thub.outputs.duration-sec }} s"
          echo "Log: ${{ steps.thub.outputs.job-url }}"
```

**Report only, quietly:** the step never fails (`fail: false`), the PR is commented on only when something fails (`comment: on-failure`), and the verdict is a commit status. Make `TestHub / <workflow> / <job>` a required check in branch protection to block merges on it:

```yaml
      - uses: andrianyablonskyy/thub-action@v1
        with:
          url: https://thub.example.com
          key: ${{ secrets.THUB_CI_TOKEN }}
          type: sw
          command: ./ci/sw-tests.sh
          fail: false
          comment: on-failure
          commit-status: true
```

**A self-hosted runner** that already has Node.js 24 and the Agent (`npm i -g --install-links git+https://github.com/andrianyablonskyy/thub-agent.git`): no download on every run.

```yaml
    runs-on: [self-hosted, linux]
    steps:
      - uses: andrianyablonskyy/thub-action@v1
        with:
          url: https://thub.example.com
          key: ${{ secrets.THUB_CI_TOKEN }}
          type: hw
          command: ./ci/hw-tests.sh
          setup-node: false
          agent: thub
```

**Try it without hardware:** `dry-run: true` schedules the job on a matching Client, which logs what it would run instead of running it. Every report still appears, with a synthetic PASS:

```yaml
      - uses: andrianyablonskyy/thub-action@v1
        with:
          url: https://thub.example.com
          key: ${{ secrets.THUB_CI_TOKEN }}
          type: sw
          command: ./ci/sw-tests.sh
          dry-run: true
```

## Permissions and pull requests from forks

- **The PR comment** needs `pull-requests: write` (or `issues: write`). **The commit status** needs `statuses: write`. Without them the action warns and goes on: the job and the Job Summary are unaffected.
- **Pull requests from forks** get a read-only `GITHUB_TOKEN` and no secrets. They also run code you haven't reviewed, so **don't let them reach your lab**. Skip the job for them, as in the example above. Never run TestHub from `pull_request_target` with the PR's code checked out: that gives anyone who opens a PR a shell on your benches. To test a contributor's change, push it to a branch in your repository after review.
- **The key** is masked in logs, and reaches only the Agent the action runs. The job's command never sees it.

## Cancellation

Canceling the workflow (or a newer push with `concurrency: cancel-in-progress`) stops the step. The action passes the signal to the Agent, which cancels the TestHub job, so the bench is freed at once. A runner killed outright (`SIGKILL`) leaves the job to its `timeout`.

## Publishing (maintainers)

The action lives in its own public repository (`andrianyablonskyy/thub-action`), with `action.yml` at the root. This directory is that repository's content.

1. Create the repository and push this directory's content to it. Its `.github/workflows/test.yml` runs the tests on every push.
2. Release: `git tag -a v1.0.0 -m v1.0.0 && git tag -fa v1 -m v1 && git push origin v1.0.0 && git push -f origin v1`. Workflows use the moving major tag `@v1`; move it on every compatible release.
3. **GitHub Marketplace:** open the repository's **Releases → Draft a new release** for the tag, tick **Publish this Action to the GitHub Marketplace**, and accept the agreement (once per account; it requires 2FA). Pick the categories *Continuous integration* and *Testing*. The `name` in `action.yml` must be unique on the Marketplace; `branding` sets its icon.

## License

See [LICENSE.md](./LICENSE.md).
