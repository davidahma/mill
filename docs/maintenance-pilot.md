# Compare a maintenance pilot

This protocol measures whether Mill changes the effort needed to get an
independently accepted software change. Use real work in one trusted repository.
The project bootstrap, publication, training tasks and synthetic canaries are
outside this comparison.

For the synthetic wheel pilot that checks evidence reuse and staleness, see
[maintained outcome evidence](maintained-outcomes.md#replay-the-wheel-pilot).

## Decide before measuring

- Name the owner who will accept each outcome. Agree on the same review standard
  and follow-up window for both routes. For example, use 14 calendar days after
  acceptance to record regressions and reversals.
- Choose a time box or count before starting. Use consecutive eligible
  maintenance changes with small scopes, one owner, and a reproducible oracle.
  Record exclusions and their reasons as work enters the queue.
- Match changes by risk, expected effort and affected surface. Allocate paired
  changes to Mill or the ordinary assisted route before work starts. Record
  crossovers and keep the original route and reason in the analysis.
- Use the same toolchain, acceptance standard and elapsed-time start point in
  both routes. If you switch because a receipt, command or budget blocks, record
  that attempt and the reason before the next one.

## Capture one row per eligible change

Point `reporting.ledgerPath` at a repository-owned pilot ledger. Record status,
route, outcome and measured effort using the
[development evidence contract](report.md). Human minutes count active
preparation, review and repair. Elapsed time runs from accepted intake to an
owner decision or documented abandonment. Define when a repair counts before
measuring. Use `null` for unmeasured time and zero for time measured as zero.

These are synthetic rows showing the ledger format:

```yaml
schemaVersion: "1"
records:
  - id: DEMO-MILL
    change: Synthetic fixture for an eligible log-format change
    eligibility: { status: eligible }
    route: { kind: mill }
    outcome: accepted
    effort: { preparationMinutes: 9, reviewMinutes: 12, repairMinutes: 0 }
    elapsedMinutes: 32
    repairs: 0
  - id: DEMO-MANUAL
    change: Synthetic fixture for an eligible error-message change
    eligibility: { status: eligible }
    route: { kind: manual, reason: Assigned to the ordinary assisted route }
    outcome: abandoned
    effort: { preparationMinutes: 8, reviewMinutes: null, repairMinutes: 6 }
    elapsedMinutes: 27
    repairs: 1
```

Keep the matched pair, route changes, supporting acceptance and follow-up notes
in a private measurement record keyed by the ledger ID. At follow-up, record
owner-confirmed regressions, reversals, or that no follow-up observation was
available. Keep secrets and private runner reports outside the ledger.

## Read the result

`millctl --json report` supplies denominators, accepted counts and totals. A
combined time or provider-usage total is `null` if any eligible measurement
needed for it is missing. Use the individual rows to compare the routes. Show
eligible, attempted, failed, abandoned and accepted counts first, then available
time and repair distributions by route, with the sample size and missing
measurements beside each comparison.

Identify the step where time moved and check the observed follow-up defects
before narrowing or extending the trial. A small prospective pilot supports an
operating decision for this repository. Wider productivity or quality claims
require further evidence.
