# Python development and external verification

The Python profile and signed receipt input are experimental. The Python fixture
exercises a pinned CPU environment. Each target runner and hardware profile
needs its own qualification.

## Adopt an existing Python repository

Prepare an OCI image explicitly with the exact Python interpreter and
dependencies from the reviewed `pyproject.toml` and `uv.lock`. The image must
contain `/opt/venv/bin/python` and `/opt/mill-python-profile.json`. That
manifest has exactly `schemaVersion`, `python`, `projectDigest` and
`lockDigest`: version `1`, the exact interpreter version, and SHA-256 digests of
the two files' bytes. Mill checks it inside every verification container before
executing the declared command.

The preflight and declared Python script use isolated mode (`-I`) and suppress
bytecode writes (`-B`). Repository modules cannot replace preflight imports, and
manifest checks use explicit failures rather than optimizable assertions.
Scripts must add their intended source path explicitly when testing unpackaged
code; ambient `PYTHONPATH` and `PYTHONOPTIMIZE` are ignored.

If the container cannot complete preflight, inspect the image pin, interpreter
and raw project and lock digests. Mill permits a source repair only after the
frozen command records a normal failing exit. A signalled or interrupted check
requires investigation of the verifier.

The [Python example](../examples/python-cli-library/README.md) includes a locked
environment, tests, wheel build and installation check. Its Dockerfile is an
operator-side preparation tool. Verification never pulls an image or installs
dependencies. Rebuild and review the image when either input changes.

In the proposed build-only configuration, set `verifier.pythonProfile`:

```yaml
pythonProfile:
  id: python-cli-library
  version: "3.12.14"
  interpreter: /opt/venv/bin/python
  manifestPath: /opt/mill-python-profile.json
  projectPath: pyproject.toml
  lockPath: uv.lock
```

The surrounding verifier still requires an actual image digest and
`network: none`. Omit Node dependency snapshots. Each command invokes an
existing repository script through that interpreter, freezes the script and both
project/lock files in `controlPaths`, and runs with `execution: oci` and
`cwd: .`. Candidate verification must select both a required test command and a
required package-install command. An approved baseline may select a narrower
set. Temporary builds belong in declared scratch or `/tmp`. The source and image
environment stay read-only.

Runtime admission validates manually prepared profiles and requires selected
scripts to be control paths outside the builder's writable scope. Verification
rechecks the profile and command shape before creating a resource lease. An
unsafe configuration is rejected before baseline execution; adoption is not the
only place this boundary is checked.

Run `millctl --json adopt-native --config adoption.yaml` to inspect the plan.
Apply the exact reviewed digest with `--apply --approve sha256:... --attended`.
Apply creates only Mill controls in an isolated worktree. It does not approve
product acceptance, execute Python, replace the source, or declare
qualification. The same product/task/impact preparation and baseline workflow
follows adoption. The generated lock binds the reviewed controller digest.
Verify it as part of a [source pin change](release.md#source-identity).

## Receive results from an independent runner

Frozen `mill.yaml` may declare `externalVerifiers`, keyed by verifier ID. Each
entry contains one Ed25519 SPKI public PEM in `publicKeyPem`, a `profileDigest`
and bounded `maxAgeSeconds` of at most 86,400. Review the public key and
executable profile before admission. The runner retains the private signing key
in its own controlled environment.

Admission validates the claims and each selected producer before any builder
runs. Claim IDs must use the syntax in the request schema. A run may select up
to 32 producers and a request up to 512 claims. Legacy external scenarios
without a configured producer retain their permitted owner-attestation path.

A version-2 task selects `evidence: { mode: external, verifierId: gpu }` for an
acceptance item. A corresponding scenario uses `oracleOwner: external` and
`executionRef: gpu`; an externally checked invariant uses
`verification: { mode: external, ref: gpu }`. These are expert task packets. The
automatic task compiler continues to require repository-owned command oracles.

After the builder creates its committed candidate:

```sh
millctl --json verification-request --task product/tasks/TASK.yaml --run RUN --verifier gpu
millctl --json verify --task product/tasks/TASK.yaml --run RUN --external-receipt /private/results/receipt.json
```

The first command exports the immutable request in the JSON envelope's `data`
field. Give that exact request and candidate to the independent runner. Use the
[request schema](../schemas/external-verification-request.schema.json) and
[receipt schema](../schemas/external-verification-receipt.schema.json). The
request binds repository, run, candidate commit and tree, frozen task and
configuration, verifier profile and individual claim digests.

After running the reviewed profile, the runner prepares a receipt payload. Each
claim names a report. Each report contains its name, SHA-256 byte digest and
bounded text content. The signed runtime manifest identifies the relevant
hardware, model and serving settings. A signature authenticates the producer and
the bytes it attests to. Qualify the actual runner and behavior separately.

The [Python reference signer](../test/fixtures/external-receipt/sign.py) uses
Python 3 and OpenSSL 3 to sign the payload's canonical UTF-8 JSON with Ed25519:

```sh
python3 test/fixtures/external-receipt/sign.py payload.json /secure/runner-key.pem > receipt.json
```

Its deterministic
[golden receipt](../test/fixtures/external-receipt/receipt.json) uses a fixed
test clock, Unicode and escaped text to exercise interoperability. Use fresh
real receipts for an admitted run.

Supply a regular local receipt file up to 4 MiB. The importer rejects special
files and final symlinks. FIFO inputs are rejected without waiting for a writer.
Multiple required producers use multiple paths after `--external-receipt`. Use
`continuation` or `handoff` to find the outstanding verifier IDs. Missing,
duplicate, stale, future-dated, unsigned or mismatched evidence blocks import
while leaving the candidate committed. Signed test failure blocks acceptance and
review. Accepted receipts and reports remain in private storage bound to the
candidate and attempt. Routine output shows digests and dispositions.

CPU checks still run in Mill's offline verifier. External acceptance passes only
with complete passing claims for its exact IDs; a generic successful CI job or
human assertion cannot replace that receipt. Review and later promotion recheck
expiry. Plan the runner/review window within the frozen task deadline and
receipt lifetime. An expired qualification needs a new approved qualification
workflow; Mill does not renew evidence by editing timestamps or waive review.

Required GitHub checks remain a separate gate after draft delivery. The
independent runner's owner is accountable for its workload and performance
assertions. Mill authenticates the result and checks the candidate and frozen
authority binding.
