# Prepare, inspect and hand off one change

Start with `init prepare`, then resolve its questions and independently review
the proposed acceptance checks. Draft scaffolding cannot authorize a run. The
[planning guide](planning.md) describes the approval path.

## Before spending

```sh
millctl --json readiness --task product/tasks/TASK.yaml
millctl --json readiness --task product/tasks/TASK.yaml --run <same-task-run-id>
```

The result names selected commands, context files and bytes, playbooks, verifier
image, delivery policy and token allowance. A prior run must match the exact
task and configuration. Partial or unavailable usage cannot establish a
remaining allowance. These are source bytes, not tokens or proof of what the
worker read. Context selection is not a filesystem access-control list.

By default no repository commands, images or models execute. Add
`--probe-verifier --attended` to inspect local image availability. It never
pulls an image and does not establish baseline qualification or hosted-review
service availability. The token guard operates between calls; it cannot cap a
call already in flight. Resolve missing prerequisites before the ordinary
admitted run.

## One change, several kinds of evidence

`schemas/change-evidence.schema.json` names a stable `changeId` and measured or
unavailable preparation, run and native-review references. Each measurement
binds its candidate and evidence digest. Input and output counts add together;
cached input is a subset, so it is not added again. Duplicate receipts and
measurement IDs are rejected. Missing measurements leave the complete total
unavailable while preserving the measured subtotal.

```sh
millctl --json change-evidence --file quality/change-evidence.json
```

Human preparation, review and repair minutes stay null until measured. Hosted
requests are operator-declared; hosted tokens and currency cost remain
unavailable. The manifest validates declarations, not their authorship or the
external receipt contents. A development-evidence ledger record may bind the
manifest's relative `path` and SHA-256 `digest` under `changeEvidence`; its ID
must equal `changeId`. `report` then includes the linked summary without adding
it to the older per-record usage totals.

## A useful handoff

```sh
millctl --json handoff --run <run-id>
```

The result combines validation, local review, recorded remote checks/review,
integrity, pending effects, last durable progress and all known blockers. The
next safe operation respects reconciliation first. A recorded remote snapshot
must be refreshed by ordinary readback before delivery; it grants no live
approval. Silence does not establish a stall, and unverifiable process identity
stays unknown.

If an owner used a separate native route after a terminal run, an optional
`--owner-disposition` file may record that distinction. It binds the exact
candidate commit and tree, actor, route (`native_owner` or `not_accepted`),
reason and evidence digest. It does not authenticate the owner, change state,
close the Mill run, or establish owner acceptance in Mill.

## Public runtime and private qualification

`schemas/consumption-manifest.schema.json` binds distinct owner and consumer
repositories, exact release version/source revision, platform, registry manifest
digest, image configuration digest, archive checksum and preceding rollback
identity. Those digests describe different objects and are never
interchangeable.

```sh
millctl --json consumption inspect --file product/runtime-consumption.json
```

Source review, artifact qualification, pin adoption and customer qualification
are separate declared transitions. Validation establishes the manifest's format
and separation, not publication, signatures or customer execution. Existing
repository-specific release pins remain authoritative; adapt them explicitly
rather than maintaining two editable runtimes. Keep private customer evidence
outside the public implementation.
