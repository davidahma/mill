# Consume public Mill source from a private repository

Keep each component owned by one repository. Develop Mill in its public source
repository. Keep private workflow material, runner credentials and qualification
evidence in the private repository or approved evidence store.

## Draw the export boundary

Review an inclusion list before copying source. Classify source, tests, build
files, synthetic fixtures, dependency obligations and public instructions.
Verify the exact export, including any Git history you intend to share. Keep
customer code, private authority, external runner receipts, logs and credentials
outside the export. Preserve licenses and attribution.

A synthetic verifier fixture can demonstrate repository-independent behavior. It
cannot establish customer performance or hardware qualification. Publish claims
only at the level shown by the retained evidence.

## Pin and verify the controller

Follow the [source identity procedure](release.md#source-identity) on the public
checkout. Record the commit, controller digest and relevant profile and contract
versions in the private consumption record. For a local tarball, add the
tarball's SHA-256. Record the registry/image manifest digest separately from the
tarball and controller identities.

Review the exact adoption plan in the target repo. Native Python adoption
records the controller digest in its lock. A reviewer on a second machine can
verify the same identity and reopen the exact approved downstream configuration.
Rebuild and reapprove separately if a Python project, lock or image changes.

## Qualify the actual target

Give the target an independently owned acceptance case and perform the
[approved task workflow](operator-guide.md). Confirm the verifier's exact base,
image, commands and locks. Inspect scratch, report output and cleanup using the
actual declared commands. Host tests, fake adapters and successful adoption each
answer different questions from the target verification.

For external hardware, qualify the runner and its signed profile independently.
Bind each claim to the exact candidate and retain private reports. The
[external verification guide](python-external-verification.md) describes the
request, receipt and policy.

## Enable GitHub delivery separately

Select a reviewed policy for `propose` trust only after build qualification.
Bind repository identity, remote, human operators and required checks. Use an
appropriately scoped shipper identity and separately approve the exact draft PR
plan. Use [delivery access](delivery-access.md) and
[attended approvals](approvals.md) for the full policy.

Keep the preceding controller, lock and image available for rollback. A failed
pin upgrade leaves the private consumer on the previous validated artifact. A
public CI result covers the public source checks. A private target keeps its own
qualification, acceptance and closure evidence.
