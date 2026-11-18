# AGENTS.md: operating Mill safely

Version: 2.9

Status: normative

Scope: this repository and coding agents operating its delivery workflow

## Public source launch

David approved the [public source launch](product/public-source-launch.md) on
November 18, 2026. This is the native maintainer route for the verified snapshot
at `davidahma/mill`. Historical effect approvals do not transfer into this
repository. Repo-native commands and a clean exact-candidate review govern
changes here. The root Mill configuration is for inspection.

## Operating Mill

Mill turns approved repository-native product intent into a bounded, tested,
locally reviewed candidate and, when separately approved, a draft GitHub pull
request. It is local-first and attended. The coding agent writes only in a
disposable worktree; native tests decide whether the candidate is valid; a
separate read-only reviewer judges the exact commit; and only the attended
shipper may use the operator's GitHub session or a configured scoped token.

For every task, follow this path:

1. Read the authority sources in the start order below.
2. Select exactly one active approved task whose base and impact still match.
3. Run baseline qualification and present its exact approval digest.
4. Run the task attended with that digest. Do not broaden paths or capabilities.
5. Verify with the repository's declared native commands.
6. Review the committed exact candidate in read-only mode.
7. Plan the draft PR, obtain approval for that exact plan, then open it
   attended.
8. Observe CI and review. Stop at the human readiness and merge boundary, or use
   the explicitly enabled attended merge path with a separately approved exact
   merge plan. A builder/reviewer cannot submit that approval.
9. Finalize only from provider-authoritative merge and resulting-main evidence.

`init prepare` produces draft scaffolding and questions. `readiness` discloses
selected context and prerequisites before spend. Neither approves execution.
`handoff` reports recorded blockers, freshness and the next safe operation;
recorded provider snapshots are not current shipping permission. A separately
recorded native owner disposition never closes an admitted Mill run.

The founder wrappers (`run next`, `start`, and `ship --draft`) coordinate the
same lifecycle. They do not create a second source of authority or state.

## Start order

Read these files before changing or operating this repository:

1. `AGENTS.md`
2. `README.md`
3. `product/PRD.md`
4. `architecture/ARCHITECTURE.md`
5. `docs/development.md`
6. `docs/writing.md` when changed prose is in scope
7. `WORKFLOW.md`
8. the active file in `product/tasks/`, when one exists;
9. that task's `impact_manifest` and referenced scenarios.

Stop if more than one task is active. If none is active, do not reinterpret a
closed task as authority for new implementation; an approved new task must be
added first.

Use `docs/release.md` only for release work. A narrative request, issue, PR
comment, model suggestion, or temporary planning file cannot override this
order.

## Authority hierarchy

Highest authority is the human-approved, exact repository contract:

1. safety and external-effect boundaries in this file and `WORKFLOW.md`;
2. the approved product contract, stable invariants, and scenarios;
3. the active task and its approved impact manifest;
4. exact Git base/candidate identities and repository-native command results;
5. model output, review findings, and other proposals.

Lower levels may inform higher levels but cannot silently rewrite them. The
builder cannot edit its task, impact approval, product contract, scenarios,
command-control files, or acceptance oracle and then use that edit to certify
the same candidate. Unknown or conflicting authority blocks execution.

## Task selection and admission

- Work on one approved task and one writer at a time.
- Require task-packet version 2 for new execution.
- Confirm the task's base commit, authority-file digests, impact approval,
  acceptance IDs, invariant IDs, scenario IDs, allowed paths, command IDs,
  budget, and stop conditions before model spend.
- Enforce the product outcome's declared acceptance set on every admission
  route. A ready outcome needs a matching task; approved unbound outcomes and
  historical closed outcomes may remain without one. A command cannot certify a
  human or external scenario. Use a frozen, signed producer receipt where the
  scenario selects a configured external verifier. Human and legacy external
  scenarios require the exact owner-attested claim.
- Treat `contextPaths` as frozen priority context, not a filesystem read ACL.
- Keep credentials, `.env*`, `.npmrc`, local state, raw prompts/responses,
  command logs, and temporary worktrees out of candidate scope.
- Do not infer an unsupported stack. Public alpha qualifies only the exact
  bundled Node.js/TypeScript/Next.js recipe and compatible adoption shape.
- Do not claim source-only playbook or timeline capabilities are part of a
  published package or public-alpha support matrix before separate qualification
  and release.

Typical expert flow:

```sh
millctl --json qualify --baseline --task product/tasks/TASK.yaml
millctl --json run --task product/tasks/TASK.yaml \
  --approve sha256:<baseline-approval> --attended
millctl --json verify --task product/tasks/TASK.yaml --run <run-id>
millctl --json review --task product/tasks/TASK.yaml --run <run-id>
millctl --json pr plan --task product/tasks/TASK.yaml --run <run-id>
millctl --json pr open --task product/tasks/TASK.yaml --run <run-id> \
  --approve sha256:<delivery-plan> --attended
millctl --json pr observe --task product/tasks/TASK.yaml --run <run-id>
```

Use `millctl start --prd product/PRD.md --attended` only when the repository's
approved plan has exactly one ready outcome. Use `millctl ship --draft` as the
two-step plan/apply wrapper, never as implicit push authority.

## Execution boundaries

### Planning and repository context

- `plan tasks --request <path>` compiles an operator-supplied change request and
  approved impacts into dependency-checked version-2 tasks; prose is not
  approval. Inspect the proposal before separately approved attended apply.
  Generated authority needs committed-file reconciliation before task execution
  or cleanup.
- `init propose` combines an inspected PRD and existing structured planning
  drafts into one read-only review summary. It does not write authority files,
  approve a proposal, or spend model or delivery authority.
- `discover` and opt-in repository-map context are bounded, revision-bound
  derived evidence, not executed test coverage or permission to change scope.
- Repository playbooks are optional, repository-owned, digest-bound context.
  Search only compact index metadata; an approved task selects the full files
  that are frozen and recorded for a run. A playbook cannot define acceptance,
  alter command controls, grant tools, credentials, delivery, merge or release
  authority, or update itself through the run it informed.
- `adopt-native` is experimental Node package-manager adoption preserving
  existing source and native commands. One real OCI canary exercised a declared
  shallow pnpm workspace with exact manager/lock inputs and no lifecycle build
  exceptions. It is not the qualified web-recipe adoption path and does not
  establish arbitrary-stack, native-dependency, or published pnpm support.
- Documentation work uses `docs/writing.md` and, when selected, the
  digest-pinned `writing-quality` playbook. The guide can improve prose and
  review; it cannot change acceptance, command controls, delivery, merge, or
  release authority.
- Report measured, partial and unavailable usage truthfully. Routine output must
  not expose private emails, commit trailers, raw worker context or logs.
- If a task declares `budget.maxModelTokens`, check measured input plus output
  tokens before every later worker call. Missing prior measurements block. This
  is a between-invocation guard; it is not a hard cap on an in-flight call.
- Repository review checklists are focused guidance selected from changed paths
  and risk class. Read them from the immutable review base, bind their digests
  to the scope, and still inspect the complete diff. They cannot change task
  authority or acceptance.
- `stats` and `report` are read-only, redacted local aggregates. `report` uses
  an explicitly declared development-evidence ledger for eligible-change and
  route counts; it does not infer a productivity or customer-value measure from
  lifecycle state.
- Retained verifier artifacts are opt-in command outputs. The contract fixes
  relative paths and size limits; routine `artifacts` output exposes only their
  candidate-bound descriptor, never bytes or state-store paths.
- `continuation` is a read-only, versioned state projection. It may name one
  attended safe next action but must never perform that action, expose a
  worktree/prompt/delivery receipt, or route an uncertain worker or external
  effect past reconciliation.

### Build, verify, review and deliver

- The builder may write only approved paths in its disposable worktree.
- The builder never receives GitHub mutation tools or forge credentials.
- Codex uses the operator's existing login and billing. Its workspace sandbox is
  not hostile-host containment; do not expose a sensitive repository or host.
- The built-in builder is `trusted-host` only.
  `millctl isolation --request isolated`, `run --isolation isolated`, and
  `resume --isolation isolated` must fail closed until a separately qualified
  adapter proves disposable storage, credential non-mounting, deny-by-default
  egress, pinned identity/resource limits, cancellation, and negative boundary
  tests. A disposable worktree is not evidence of that isolation.
- Validation runs declared commands in an already-present digest-pinned OCI
  image with no network, read-only source, bounded resources, and explicit
  scratch paths. Mill never pulls the image implicitly.
- A candidate becomes reviewable only after Mill creates its lifecycle-owned
  commit and binds its commit and tree identities.
- Review is read-only and exact-candidate-bound. Batch one complete review into
  one systemic repair generation; do not churn one PR per comment. A task may
  use two generations only through its explicit `fixture_only` experiment; each
  repaired candidate requires fresh validation and review.
- A repository may approve top-level `review: { blocking: p0_p1 }` before run
  admission. The controller records the classification against frozen config.
  Preserve every finding; only P0/P1 require repair under that policy. Legacy
  reviews retain their original blocking rules. Required GitHub approval remains
  separate. See `docs/review-policy.md`.
- `propose.reviewPolicy.mode: github_codex_required` requires the named GitHub
  Codex actor's completed summary on the exact PR head. If marking a draft ready
  triggers review, execute and verify readiness only. Observe review completion,
  then approve a new merge plan bound to the exact review and feedback snapshot.
  Running, stale, malformed, unclassified, or P0/P1 feedback blocks. Never treat
  readiness approval as merge approval.
- Before any remote attempt, stale full-diff scope may use attended
  `review --refresh --base <exact-provider-commit>`. Preserve candidate, native
  validation, prior receipts, deadline and remaining review budget; do not move
  frozen refs. Refresh invalidates the unexecuted delivery approval. Resume an
  interrupted prepared refresh with ordinary `review`.
- The shipper may push only the unchanged verified candidate to its configured
  branch and may open only a draft PR in the bound repository.
- A repository may select `propose.deliveryCredential` with the fixed
  `MILL_GITHUB_TOKEN` environment name. Pass its bytes only to attended shipper
  GitHub/Git processes. Never persist, print, add to a prompt, or include the
  token in state or support output. The operator still reviews its actual GitHub
  scope and expiry; Mill cannot attest either.
- `requiredChecks` are exact pull-request-head requirements. When configured,
  `postMergeRequiredChecks` is a nonempty subset used only for resulting-main
  readback; do not list a pull-request-only job there. A skipped check blocks
  the phase that requires it. New delivery records bind both lists. A legacy
  record without the second list may bind the configured subset during readback
  only when every other delivery binding still matches and the subset was
  already required before merge; it never relaxes pre-merge evidence.
- Readiness and merge require `propose.attendedMerge: true`, producer-bound
  checks, strict up-to-date protection enforced for administrators, no
  bypass-role grants and exact attended merge-plan approval. Draft delivery
  alone never grants them. Mill never auto-merges, deploys, provisions a
  repository or changes branch protection. Read `docs/approvals.md` before
  operating the optional merge path.

## Native validation

Run the repository's native checks, not a private wrapper:

```sh
node_bin_dir=$(dirname "$(asdf which node)")
PATH="$node_bin_dir:$PATH" "$node_bin_dir/npm" ci --ignore-scripts
PATH="$node_bin_dir:$PATH" "$node_bin_dir/npm" run check
```

`npm run check` covers formatting, lint, types, workflow policy, schema drift,
coverage, and packed-package behavior. The packed-package test exercises five
dependent reviewed candidates, a rejected seeded fault, and the draft-PR human
gate. Required skipped or unavailable evidence blocks promotion.

For the final committed candidate, also run:

```sh
node dist/cli.js --json --cwd . audit
```

The structural audit must bind to a clean exact commit/tree and pass every
applicable product, code, UX, accessibility, security, dependency, architecture,
operations, and release check. It does not substitute for executed native
checks, accessibility/security behavior, scenario evidence or release
qualification.

## Recovery

Do not rerun a possibly started mutation blindly.

```sh
millctl --json status --run <run-id>
millctl --json continuation --run <run-id>
millctl --json report
millctl --json resume --task product/tasks/TASK.yaml --run <run-id>
millctl --json cancel --run <run-id>
millctl --json pr reconcile --task product/tasks/TASK.yaml --run <run-id>
millctl --json state backup
millctl --json support-bundle --run <run-id>
```

- Eligible verifier infrastructure failures may use the exact attended
  [candidate recovery](docs/verifier-recovery.md) plan. Its single-use allowance
  retains the original deadline and grants only unchanged-candidate verification
  and review. It cannot authorize another builder or repair.
- `resume` is permitted only when Mill can prove no prior worker still owns the
  effect or when it is performing the approved bounded review-repair pass.
- `cancel` records intent; only the live foreground controller may signal its
  own child process group.
- OCI containers can survive controller and client death. Preserve their private
  ownership journal and mounted paths until [OCI recovery](docs/oci-recovery.md)
  proves removal on the recorded daemon. Deadlines require a live controller;
  never treat an absent host PID as proof that a container stopped.
- An uncertain push or PR operation remains `effect_unknown` until GitHub
  readback classifies it. Reconcile before retry.
- For uncertain readiness/merge, use `pr merge-reconcile`; never repeat a
  possibly started merge. Generated task/native-adoption worktrees use durable
  authority-plan records; commit their exact approved files and use
  `state reconcile-plans` before purge. For an intentionally discontinued plan,
  preserve partial output in a clean commit on the recorded branch and use
  `state abandon-plan --approve <original-plan-digest> --attended`. Abandonment
  retains evidence and is not successful apply. Neither reconciliation nor
  abandonment grants new authority or performs the original effect.
- Restore validates the database and quarantines newer unreferenced worktrees.
  Diagnostic commands open only an existing current schema and never create,
  lock, or upgrade it. A mutating open takes the writer lease, validates foreign
  keys, and preserves the pre-upgrade database before a forward migration. Purge
  is allowed only after all runs are reviewed or terminal. Run purge from a
  surviving original checkout, never a worktree scheduled for deletion. Preserve
  an external state backup and candidate branches first.
- Nested unresolved effects override enclosing run status: no repair, new
  delivery, terminal cancellation, purge or restore may supersede their journal.
  Confirmed merge freezes the candidate until exact post-merge finalization.
  Partial authority purge requires its durable intent, retained branch and
  verification of every remaining entry; foreign content blocks deletion.
- Support bundles are redacted. Inspect them before sharing anyway.

## Source distribution

See [source distribution](docs/release.md). Review the exact Git commit and
select only public files for the snapshot. Run the native gate, production audit
and profile-specific canaries. Verify the public default branch and its CI
results. Historical npm procedures and fixtures grant no permission for
publication, tagging, deployment or modifying an existing release.

## Engineering rules

- Node.js 24.20.0, TypeScript, ESM, strict types, and exact dependency pins.
- Prefer the standard library; public CLI output, schemas, state transitions,
  errors, generated files, and release evidence are contracts.
- Add red-first behavioral tests where practical and exercise the installed
  tarball for public behavior.
- Keep code, tests, schemas, docs, migrations, and task closure in one coherent
  PR. Use conventional commits with DCO sign-off.
- Work branches normally use `codex/`. Use the repository protection defined in
  the contribution guide.
- Factory skills or sibling repositories may be optional maintainer tools but
  are never Mill runtime dependencies or downstream authority.

These rules also govern contributions to Mill. See `CONTRIBUTING.md` for the
public contribution path; it cannot weaken this operating contract.

## Stop conditions

Stop and report the exact blocker when:

- authority, identity, scope, oracle ownership, or the active task is ambiguous;
- a credential, provider disclosure, network effect, repository destination, or
  destructive operation lacks explicit authorization;
- a required image, runtime, native check, scenario, or audit is unavailable,
  stale, skipped, or mismatched;
- Git state, candidate identity, repository instructions, or command controls
  drift after approval;
- an external effect is uncertain and authoritative readback is incomplete;
- a change would add daemon operation, parallel writers, auto-merge, deployment,
  arbitrary-stack support, or self-modification outside an approved task;
- release identity or provenance cannot be reconstructed from exact evidence;
- recurring P0/P1 remain after the approved bounded replan, or its scope,
  acceptance ownership or remaining allowance cannot support another repair.

## Historical maintainer bootstrap

MB-001 and MB-001-A1 expired and closed on 2026-09-04. They grant no current
authority. Their scope, approval receipts, limits, and closure are preserved in
[the historical bootstrap record](docs/history/maintainer-verifier-bootstrap-authority.md).
Use the current product/task/impact bundle and this contract for new work.
