# Mill delivery workflow

Mill is a TypeScript CLI maintained through native repository commands and
independent exact-candidate review. The original project developed in five
vertical waves, from static inspection to approved tasks, delivery and
distribution. The public preview keeps that delivery model and publishes
reviewed Git source.

## Prepare the change

1. Identify the approved owner, outcome and affected contract. Freeze the task,
   allowed paths, acceptance checks, exclusions, budget and stop conditions.
2. Capture a failing regression case where the defect can be exercised.
3. Implement one coherent change. Keep approval inputs and independent
   acceptance oracles outside the builder's writable scope.
4. Run focused checks and then the full native gate. Commit the exact candidate
   before collecting final acceptance or review evidence.

Before admitting a new Mill task, freeze the source manifest, approved product
contract, outcome and invariants, scenario set, decisions and impact approval.
The impact must resolve to its approved outcome. Each required item must resolve
to an executed command, a current signature from a configured external verifier,
a permitted unexpired owner attestation, or a disposition that blocks execution.
A legacy external scenario may use owner attestation when it has no configured
producer. For configured external claims, follow the
[signed evidence contract](docs/python-external-verification.md).

A current candidate may add future acceptance checks. Use independent evidence
for the current candidate. Expiration removes authority for new actions and
still permits readback of an already attempted effect.

## Verify and review the exact candidate

Use the repository's [native gates](docs/development.md) for a candidate. For a
maintainer change outside an admitted run, use the
[local review script](docs/maintainer-review.md). It binds validation, review
scope, measured model usage and the decision to the exact candidate. Work
through actionable review findings in one coherent repair, then rerun the checks
and review on the changed candidate.

Preparation changes can retain a
[review session](docs/maintainer-review.md#preparation-sessions) across repaired
candidates. Candidate and acceptance review each have their own decision. Use
the approved recovery or base-continuation path if the session stops. The
original spending and expiry still apply.

Factory skills are optional maintainer tools. Mill's native workflow requires no
Factory profile, installed pack or runtime.

## Close or deliver

In a build-only repository, an attended
[local completion](docs/operator-guide.md#accept-a-local-result) accepts the
reviewed local result and releases the next-task gate.

In a delivery-enabled repository, approve the exact draft plan, push the
reviewed commit, and observe its configured GitHub checks. A human can finish
the draft on GitHub. Optional attended readiness and merge each require their
own applicable approval, current provider evidence and a separate effect
journal. Read resulting-main checks before recording merged closure. See the
[operator guide](docs/operator-guide.md#deliver-through-github).

The public repository's [source CI](docs/repository-settings.md) verifies the
combined candidate on a pull request and the exact source checkout on a main
push. The [distribution guide](docs/release.md) describes reproducible build
identity and retained evidence. Public contribution follows
[Contributing](CONTRIBUTING.md).
