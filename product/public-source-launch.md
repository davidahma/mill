# Mill public source launch

David approved implementation and publication of the reviewed Mill source on
November 18, 2026, to `davidahma/mill`. The prior development checkout and its
history remain private inputs to this work. The public repository starts from a
reviewed source snapshot. npm publication and new support qualifications are
outside this launch.

Keep the local Git and SQLite control plane, single-writer admission and
attended delivery. Bind claims, commands, review and decisions to the exact
candidate. Keep Docker execution, signing, readback and approval at their
existing independent boundaries.

| Work                          | Acceptance                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch production dependencies | Exact patched Zod and Next.js pins, passing production audits for Mill and the bundled starter, and real greenfield and adoption checks for the changed recipe.                                                                         |
| Enforce independent evidence  | Public-only Ed25519 configuration, representable and complete claims before spend, redacted errors, durable storage and freshness at completion and promotion.                                                                          |
| Confirm the Python contract   | Selected candidate checks include tests and wheel installation, project and lock identities use raw bytes, and an independently signed receipt works through the packed CLI.                                                            |
| Finish and recover local runs | Two sequential build-only tasks with retained exact review, explicit pending receipt instructions, and replay of a receipt wait followed by an OCI failure and recovery. Remote closure retains its existing evidence requirements.     |
| Identify the controller build | Experimental adoption pins a digest over the compiled controller, its runtime scripts and dependency declarations. Another same-version build fails before consuming the experimental lock.                                             |
| Publish and verify source     | Clear first-run path and scope, Apache-2.0 attribution, reviewed snapshot with no private history, read-only pinned CI running the native gate, audit and both CPU OCI canaries. Verify anonymous access and the CI run on public main. |
| Set up a maintenance pilot    | Use Mill's existing ledger for prospective eligible work and retain ordinary assisted work, aborted work, human time, repair and acceptance. A controlled fixture is evidence of behavior. Comparative results require real changes.    |

Symphony's
[validation profiles](https://github.com/openai/symphony/blob/main/SPEC.md#17-test-and-validation-matrix)
inform the separation of deterministic, profile-specific and real-run findings.
The
[in-toto test result predicate](https://github.com/in-toto/attestation/blob/main/spec/predicates/test-result.md)
illustrates a portable test-result contract. Mill uses its own versioned receipt
format and tests it from another implementation.
[Temporal's replay guidance](https://docs.temporal.io/develop/go/best-practices/testing-suite)
informs journal fixtures exercised through the next-action and recovery code.
