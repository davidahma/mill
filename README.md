# Mill

[![CI](https://github.com/davidahma/mill/actions/workflows/ci.yml/badge.svg)](https://github.com/davidahma/mill/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Mill turns one approved software change into a tested, reviewed Git commit. It
gives a maintainer a way to show which requirement each check covers, which
revision it ran against, and which action still needs approval.

Mill runs locally. It gives the coding agent a disposable worktree, runs the
repository's native checks in an offline OCI verifier, and independently reviews
the committed diff. You can accept a build-only result locally or separately
authorize delivery to GitHub.

## Why Mill

A patch is one step in delivery. The hard part is deciding what counts as done
and keeping that decision intact through testing, fixes, review and
interruptions. Mill freezes the task, its allowed paths and its acceptance
checks before model work. A passing result names the exact candidate commit. If
a remote action may already have happened, Mill reads back its outcome before
another attempt.

Mill is useful when you own a Git repository, can name an independent check for
the change, and want to keep approval and recovery decisions with a human
maintainer.

## Quick start

Use Git and the Node version in [.node-version](.node-version). The public
preview builds from source.

```sh
git clone https://github.com/davidahma/mill.git
cd mill
npm ci --ignore-scripts
npm run build
node dist/cli.js --version
```

Try the bundled preparation example in a temporary Git repository. It returns
drafts and questions without writing authority files, calling a model, or
running the example's tests.

```sh
example_dir=$(mktemp -d)
cp examples/preparation/PRD.md examples/preparation/request.yaml "$example_dir/"
git -C "$example_dir" init --quiet
node dist/cli.js --json --cwd "$example_dir" init prepare \
  --prd PRD.md --request request.yaml
```

The result includes `data.executionReady: false`. The example deliberately
leaves acceptance ownership unresolved. The [planning guide](docs/planning.md)
shows how to resolve the questions and prepare an approved task for a real
repository.

## From an approved task to a result

1. **Approve one outcome.** Select the acceptance checks, allowed paths and
   budget. Run native baseline qualification and review its approval digest.
2. **Build one candidate.** Admit the task with that digest. The worker's
   changes stay in a disposable worktree and Mill records the committed
   candidate.
3. **Verify and review.** Run the frozen checks against the exact commit.
   Optionally import signed results from an independent runner before review.
4. **Choose the handoff.** Record an attended local completion for build-only
   work, or plan and approve the exact draft PR in a delivery-enabled
   repository. Any attended merge has its own approval and resulting-main
   checks.

The [operator guide](docs/operator-guide.md) has the commands, prerequisites and
recovery paths. The `millctl start` wrapper can coordinate one ready outcome.

## What you can use

| Workflow                        | Evidence and scope                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Planning an existing repository | Read-only discovery, preparation, task compilation and readiness diagnostics                                                          |
| Node and TypeScript             | Bundled Next.js recipe and bounded adoption. The pnpm workspace canary exercises one pinned layout.                                   |
| Python CLI or library           | Experimental build-only profile. Its real CPU fixture runs tests, builds a wheel and installs it offline.                             |
| External verification           | Experimental signed receipt import for candidate-bound claims. The operator runs or delegates the job separately.                     |
| Maintained outcome evidence     | Inspect one signed claim against the selected artifact and verification inputs across revisions. [Guide](docs/maintained-outcomes.md) |
| GitHub delivery                 | Optional attended draft PRs, exact-head check observation and provider readback. Requires your repository's delivery policy.          |

The built-in Codex worker runs on a **trusted host**. Use it with source and
host access you are comfortable exposing to the worker. The offline verifier
bounds native command execution and the shipper has separate authority. See the
[security model](SECURITY.md) and [support scope](SUPPORT.md) for the assessed
boundaries, including the status of hardware and isolation qualification.

## Development

```sh
npm run check
npm audit --omit=dev --audit-level=high
```

The [development guide](docs/development.md) explains what each gate proves. The
[documentation index](docs/README.md) links to architecture, schemas, examples
and evidence. The [launch plan](product/public-source-launch.md) records the
scope and acceptance checks. See [Contributing](CONTRIBUTING.md) to propose a
change and [Security](SECURITY.md) to report a vulnerability.
