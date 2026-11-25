# Maintained outcome evidence

Scope for the public Mill source repository. This work uses the native
maintainer route described in the [workflow](../WORKFLOW.md).

## Outcome

A maintainer can check whether independent evidence still applies to one
repository-owned claim after a run closes. The first claim covers installation
of wheel bytes staged as `mill_maintenance_probe-1.0.0-py3-none-any.whl` offline
and the JSON output a CLI consumer depends on. The maintainer chooses the
governing policy, the subject commit, and the artifact digest to assess.

## Architecture

- Keep the run record as historical evidence. A read-only `handoff` mode derives
  current validity from a committed policy and explicit inputs. It performs no
  scheduled execution, hosted lookup, or state mutation.
- Bind the verifier's signed observation to the exact policy path, policy
  revision, claim, tested commit, artifact, runtime, and check. Compare the same
  inputs at the requested subject. An unrelated commit can preserve technical
  evidence when the check consumes its dependencies by immutable identity.
  Changes to governed inputs require another observation.
- Record owner acceptance separately. The owner's signature identifies the exact
  subject and the evidence the owner reviewed. Reuse of technical evidence
  across revisions does not carry the owner decision across.
- Return the affected claim and next human decision through `handoff`. A valid
  failure points to a bounded follow-up under the repository's existing planning
  and approval path.

## Acceptance

| ID    | Evidence                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MO-01 | A clean checkout and existing handoff behavior remain intact. The new mode identifies the subject, supplied artifact identity, affected input and next decision without making a remote call or changing repository state.                        |
| MO-02 | A current signed pass remains usable across a revision with identical declared inputs. An artifact, runtime, check or governing policy change cannot inherit acceptance. Missing, expired, malformed and mismatched evidence do not yield a pass. |
| MO-03 | Explicit, independent owner acceptance applies to one exact subject and verifier proof. A missing, wrong-key, changed-subject or changed-proof decision fails to establish acceptance.                                                            |
| MO-04 | Fresh passing and failing Python wheel observations exercise pip and the real CLI with network access denied. A live loopback control confirms the denial. A failed observation surfaces its claim and a bounded follow-up.                       |
| MO-05 | End-to-end fixture, native validation, packed-package checks, independent review and hosted source CI pass on the delivered revision.                                                                                                             |

The pilot measures the implemented cases with one fixture. A maintainer can
compare the result with the same hand check using missed regressions, repeat
review steps, and human time. Measurements from real repository maintenance are
a separate evaluation.
