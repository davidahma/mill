# Operate one Mill task

Build Mill from a [reviewed source revision](release.md#source-identity). In
commands below, `millctl` means your source-built CLI. One way to use it from
another checkout is to define this function in your shell:

```sh
millctl() { node /path/to/mill/dist/cli.js "$@"; }
```

Use a clean target Git checkout. Read-only preparation needs Git and Node.
Execution also needs operator-authenticated Codex CLI and an already-prepared
digest-pinned OCI verifier with the repository's approved environment. GitHub
delivery needs `gh` and a configured repository identity.

## Inspect and prepare

```sh
millctl --json doctor --mode inspect
millctl --json discover .
millctl --json init prepare --prd product/PRD.md --request product/preparation.yaml
```

The request example and [planning guide](planning.md) describe the input files.
Choose the outcome with the owner, prepare independent acceptance evidence and
freeze the approved task and its impact in Git. Use
[brownfield adoption](brownfield.md) when the repository still needs Mill
controls. Preparation and discovery give you evidence for those decisions.

## Qualify, build, verify and review

Use your task path in place of `product/tasks/TASK.yaml`; copy the returned run
ID and approval digest from the preceding commands.

```sh
millctl --json readiness --task product/tasks/TASK.yaml
millctl --json qualify --baseline --task product/tasks/TASK.yaml
millctl --json run --task product/tasks/TASK.yaml --approve APPROVAL_DIGEST --attended
millctl --json verify --task product/tasks/TASK.yaml --run RUN_ID
millctl --json review --task product/tasks/TASK.yaml --run RUN_ID
```

If the repository uses a Node dependency snapshot, explicitly prepare it first
using `millctl --json dependencies prepare --attended`. For the Python profile,
the pinned image supplies the interpreter and dependencies. For a task with a
signed evidence requirement,
[export the candidate request and import its receipts](python-external-verification.md#receive-results-from-an-independent-runner)
before running review. When `start` pauses for evidence, use the verifier IDs
reported in `continuation` or `handoff`. Export requests while the verification
window is open and leave time for the runner and the subsequent CPU checks.

Review covers the complete candidate diff against its bound baseline. If
validation or review blocks, consult the status and retained evidence before
starting another worker. [Review policy](review-policy.md) describes the bounded
repair options.

## Accept a local result

In a build-only repository, ask for the exact local-completion plan after clean
review. It records the acceptance of this candidate and permits the next
approved task in the same repository.

```sh
millctl --json complete-local --task product/tasks/TASK.yaml --run RUN_ID
millctl --json complete-local --task product/tasks/TASK.yaml --run RUN_ID \
  --approve LOCAL_COMPLETION_DIGEST --attended
```

`local_completed` records an attended local decision. GitHub merge has its own
evidence and closure. The local decision uses the original run deadline. A
verifier recovery allowance covers verification and review of the candidate.

## Deliver through GitHub

In a delivery-enabled repository, inspect the exact candidate, target and
delivery scope before approving the draft PR.

```sh
millctl --json pr plan --task product/tasks/TASK.yaml --run RUN_ID
millctl --json pr open --task product/tasks/TASK.yaml --run RUN_ID \
  --approve DELIVERY_DIGEST --attended
millctl --json pr observe --task product/tasks/TASK.yaml --run RUN_ID
```

A human can finish the PR on GitHub. In repositories that opt into attended
merge, [the merge process](approvals.md) has a separate exact plan and approval.
Use `pr finalize` after the provider confirms merge and the required checks on
resulting main are available.

## Resume or reconcile

```sh
millctl --json status --run RUN_ID
millctl --json continuation --run RUN_ID
millctl --json handoff --run RUN_ID
```

Read the next action and its reason. Use [the timeline](run-timeline.md) to
understand how the run reached that decision. If a remote effect is uncertain,
use `pr reconcile` or `pr merge-reconcile` before retrying. If a container may
still own a resource, use [OCI recovery](oci-recovery.md) first. For a supported
infrastructure failure, [candidate recovery](verifier-recovery.md) can authorize
fresh verification against the unchanged commit.
[Review the support instructions](../SUPPORT.md) before sharing a support
bundle.
