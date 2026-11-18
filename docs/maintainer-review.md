# Local review for maintainer and dependency changes

Use this route for a committed change that has no admitted Mill task, including
Dependabot updates. It runs the validation command you select, then invokes a
fresh Codex reviewer in read-only mode. P0/P1 findings block; P2/P3 findings
stay in the receipt as advisory. The operator still decides whether the selected
validation covers the change.

When the immutable base configures `review.checklists`, the script selects the
path-matched files from that base and records their digests with the changed
paths. The reviewer uses them as focus guidance while inspecting the full diff.

Run from a clean repository root, with dependencies already prepared. Supply
full commit IDs. The base must be an ancestor of the candidate, and the
candidate must be the current HEAD. Store the receipt outside the repository.

Git replacement refs, grafts, hidden index flags and repository/environment
overrides that can change the inspected bytes are rejected. Local and worktree
Git configuration must use supported static settings; executable helpers,
includes and transforming attributes are unsupported. The receipt also binds Git
control-file digests, so configuration drift requires a new review. The
validation and reviewer processes disable replacement objects and grafts.

```sh
node /path/to/mill/scripts/maintainer-review.mjs run \
  --base <full-base-commit> --head <full-candidate-commit> \
  --validation '["npm","run","check"]' \
  --receipt /private/review-evidence/candidate.json

node /path/to/mill/scripts/maintainer-review.mjs check \
  --base <full-base-commit> --head <full-candidate-commit> \
  --receipt /private/review-evidence/candidate.json
```

Keep the same source revision for recording and checking a receipt. A changed
script, promotion-policy helper, base, candidate, tree, checklist scope, or
dirty checkout requires fresh evidence. The checker does not fetch the provider
base; the operator must supply its current exact commit.

The validation argument is an argv array, not a shell expression. It executes
with the operator's environment and authority. Choose the repository's native
checks, and do not put secrets in command arguments. Each command has a
30-minute timeout and a bounded output buffer. Failed or excessive output blocks
evidence creation; rerun the command directly to diagnose it. The receipt stores
a digest of validation stdout, not raw logs.

The receipt records reviewer input, output, and cache-input tokens only when the
provider emits usable measurements. Currency cost remains unavailable. Its
readiness result comes from the same exact-candidate validation and blocking
review evaluator used before admitted delivery and merge. It does not include
GitHub checks or hosted review; those remain separate post-push gates.

Codex uses its existing local login. Its process receives no standard GitHub or
npm token environment variables. Strict configuration and the read-only sandbox
reduce accidental mutation; they do not isolate a hostile host or remove
credentials stored elsewhere on that host. This route is for trusted maintainer
checkouts. It performs no push, PR, merge or release operation.

## Preparation sessions

Create one external session before reviewing a preparation change. Keep it
across candidate repairs. The session policy is fixed at creation. The numbered
journal retains every attempt, result, replan and operator-declared hosted
request. Use absolute canonical paths.

For example, write `/private/review-evidence/policy.json` with the repository's
real path and full initial base:

```json
{
  "version": 1,
  "id": "integration-preparation",
  "root": "/absolute/repository",
  "base": "<full-base-commit>",
  "allowedPaths": ["product/task-preparation.md", "test/new-feature/**"],
  "maxRounds": 4,
  "recoveryRounds": 2,
  "maxModelTokens": 600000,
  "maxElapsedMs": 14400000,
  "maxHostedRequests": 1
}
```

```sh
node /path/to/mill/scripts/review-session.mjs create \
  --session /private/review-evidence/session \
  --request /private/review-evidence/policy.json

node /path/to/mill/scripts/maintainer-review.mjs run \
  --base <full-base-commit> --head <full-candidate-commit> \
  --validation '["npm","run","check"]' \
  --receipt /private/review-evidence/candidate-1.json \
  --session /private/review-evidence/session

node /path/to/mill/scripts/review-session.mjs status \
  --session /private/review-evidence/session
```

Round and measured input-plus-output token totals accumulate across candidates.
Elapsed time starts at session creation. Limits are checked before reservation
and immediately before the model call, so one call may exceed the remaining
token/time allowance. `maxModelTokens: null` disables only that token guard.
Missing measurements block further token-limited calls. Failed attempts count
and retain unavailable usage. A lock prevents two reviewers spending the same
allowance; interrupted locks and incomplete attempts require operator
reconciliation, never automatic erasure or budget reset.

Allowed paths support exact files and directory prefixes ending in `/**`.
Repository and initial base remain in the retained policy. A base continuation
appends a separately approved transition; it keeps every prior attempt, token
reservation, elapsed-time origin and expiry. It never opens an empty history.

## Recovery without another approval loop

The normal allowance is `maxRounds - recoveryRounds`. Two candidate rounds
reporting P0/P1 with the same stable defect identity, or exhaustion of the
normal allowance, produce `nextAction: reassess-and-replan`. An explicit
`defectId` is preferred; otherwise the normalized description plus subsystem
form the identity. A shared subsystem alone is not recurrence. The comparison
does not infer semantic equivalence. A supervisor consolidates the blocking
findings, revisits the design/check coverage, records one replan, and continues.
The approved session already reserves its recovery rounds; it does not need
another permission request for an in-scope repair.

Write an external replan request:

```json
{
  "head": "<latest-attempted-candidate>",
  "paths": ["test/new-feature/**"],
  "design": "Describe the consolidated correction and why it addresses recurrence.",
  "verification": "List preserved assertions and representative incorrect cases.",
  "acceptanceChanged": false,
  "acceptanceReview": null
}
```

```sh
node /path/to/mill/scripts/review-session.mjs replan \
  --session /private/review-evidence/session \
  --request /private/review-evidence/replan.json
```

If acceptance changes, first run a separate read-only reviewer round with
`--purpose acceptance` and the same session. Set `acceptanceChanged: true` and
`acceptanceReview` to its clean exact-candidate receipt path. This round also
counts toward the original total. The replan checks that receipt against the
current checkout, implementation and Git controls. It does not grant the builder
permission to edit its own oracle or admit a replacement product task.

Prior context is capped at 128 KiB before another model call. The reviewer
receives earlier findings, priorities, subsystems and replans as untrusted
evidence while inspecting the complete diff. Every receipt retains its
blocking/advisory ledger. The latest exact candidate still needs validation and
complete review. Recovery cannot waive a P0/P1, renew itself, or reset total
spending. When genuine uncertainty survives the allowance, report the specific
blocker and safe next action rather than looping or merging it.

## Hosted review

Push the locally reviewed candidate as a draft. Wait for CI, mark it ready once,
then observe the automatic hosted review. Request another review only when that
automatic review is absent or a changed head needs one. Record each manual
request before sending it with
`review-session.mjs hosted --session <directory> --request <file>`; the request
contains `head` and a concrete `reason`. The helper counts operator-declared
requests but does not call GitHub or intercept other tools. Hosted tokens and
currency cost remain unavailable.

Immediately before push, use the receipt checker with the same `--session` to
bind the latest candidate result. Earlier passing receipts cannot supersede a
newer review or incomplete attempt. Session status is spend/recovery guidance,
not GitHub approval or permission to ship. Admitted runtime repairs retain their
own frozen budget and approval rules.

## What the receipt establishes

The checker detects missing fields, malformed findings, candidate drift and
inconsistent dispositions. It does not authenticate the author of a receipt: a
user with filesystem access can manufacture or edit local evidence. It is
neither an admitted Mill run receipt nor a trusted CI producer attestation.

Use it as an attended pre-push check for maintainer changes. Dependabot has
already pushed its branch, so review its exact candidate before merge. An
optional local hook can invoke the checker but can be bypassed. Enforcing this
policy on GitHub requires a separately trusted required-check producer; this
script does not install one or claim that ordinary Git pushes are intercepted.

## CLI operations and interrupted sessions

The installed package exposes the same scripts through `millctl`:

```sh
millctl --json preparation-session status --session /private/review-evidence/session
millctl --json preparation-session handoff --session /private/review-evidence/session
millctl --json maintainer-review check \
  --base <full-base-commit> --head <full-candidate-commit> \
  --receipt /private/review-evidence/candidate.json \
  --session /private/review-evidence/session
```

A review has `purpose: candidate` or `acceptance`. A passing acceptance review
can support a replan, but `readyToPush` stays false. The final current candidate
still needs its own complete validation and review.

For a dead controller, first inspect a reconciliation plan:

```sh
millctl --json preparation-session reconcile --session /private/review-evidence/session
millctl --json preparation-session reconcile --session /private/review-evidence/session \
  --approve sha256:EXACT_OPERATION --attended
```

A live or unverifiable controller, native check or reviewer blocks
reconciliation. It retains the interrupted attempt as failed with unavailable
usage and keeps its allowance charged. It never erases a lock merely because
time passed.

A continuation request contains only `base` (the full new base) and a concrete
`reason`. The plan binds the retained journal, policy and accounting. The next
maintainer review checks the exact base commit and its ancestry before
validation or model spend. Preview, then approve the retained-history plan:

```sh
millctl --json preparation-session continue --session /private/review-evidence/session \
  --request /private/review-evidence/continuation.json
millctl --json preparation-session continue --session /private/review-evidence/session \
  --request /private/review-evidence/continuation.json \
  --approve sha256:EXACT_OPERATION --attended
```

This can recover an in-scope rebase without another budget reset or review loop.
Changed acceptance still needs separate review. Genuine unresolved authority,
live execution or exhausted allowance remains a blocker.
