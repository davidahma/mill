# Check whether outcome evidence is current

Use `handoff` to inspect one repository-owned claim about an artifact after the
original run has closed. For example, a maintainer can ask whether the Python
wheel currently under review has evidence of an offline install and the expected
CLI JSON output. The repository supplies the claim and the required check. An
independent verifier performs the check and signs the observed result.

## Select the authority and inputs

Commit an owner-approved
[maintained-outcome policy](../schemas/maintained-outcome-policy.schema.json) in
the downstream repository. It names the outcome, the claim, the decision owner,
a runtime descriptor file, a check file, and the maximum age of verification
evidence. It also pins distinct Ed25519 public keys for the verifier and the
owner. Keep each private key with its signer.

Set `reuseScope` to `immutable-inputs`. The verifier signs only when the check
uses the exact artifact, committed check bytes, and dependencies loaded by
immutable identities described in the runtime descriptor. A check must run
without live services, mutable repository helper paths, or other unchecked
inputs. Package a helper into the check or load it by a verified content digest.

The published policy schema checks the document shape and the PEM envelope. Mill
also checks that each PEM contains a canonical Ed25519 SPKI public key with a
nonidentity point in the prime-order subgroup, the keys are distinct, and the
runtime and check use separate paths. Use unique JSON member names in the policy
and both signed records so every participant reads the same claim and evidence.
Write claim text without control characters or bidirectional formatting marks.

Maintained outcome inspection requires a repository that uses SHA-1 Git object
IDs. Select the full 40-character commit ID that contains the approved policy
and the full subject commit ID to assess. A repository using SHA-256 Git object
IDs reports `UNSUPPORTED_MAINTAINED_OUTCOME_GIT_OBJECT_FORMAT`. Mill verifies
Git object IDs along the paths it reads for the policy, runtime descriptor, and
check. A positive ancestry check follows verified parent links through local Git
history.

Supply the SHA-256 digest of the exact artifact to check. Use a digest from a
trusted build or release record. The independent verifier must hash the actual
bytes it tests and confirm that they match. Mill reports the supplied identity
without looking up which artifact is deployed.

```sh
node dist/cli.js --json --cwd "$repo" handoff \
  --maintained-outcome quality/wheel-outcome.json \
  --policy-commit "$approved_policy_commit" \
  --subject "$subject_commit" \
  --artifact-digest "$wheel_digest"
```

Use the command's request to give an authorized verifier the exact inputs. The
verifier independently resolves the approved claim, policy path and commit, and
subject commit. The verifier confirms the actual artifact, runtime, check bytes
and Git file mode, then executes those check bytes before signing. A wheel
verifier can install the wheel in a clean environment with the package index
disabled, invoke the installed CLI, and compare its JSON against the expected
contract.

Supply the returned
[verification record](../schemas/maintained-outcome-verification.schema.json)
with `--evidence <repo-relative-path>`. To show an explicit owner decision,
supply the separately signed
[acceptance record](../schemas/maintained-outcome-acceptance.schema.json) with
`--acceptance <repo-relative-path>` and the verification record it references.
Keep the records from earlier checks available so a maintainer can see what each
one proved.

The signers use Ed25519 over Mill's
[canonical JSON](../src/contracts/canonical.ts) representation of each payload.
The owner record identifies the complete signed verification envelope by its
canonical digest. Both signatures bind the exact repository-relative policy
path. See the schemas for the exact fields. Write signed timestamps in UTC with
three fractional digits, for example `2026-10-12T12:00:00.000Z`.

## Read the decision

Read `data.status` in the JSON result. The outer `ok` and exit code zero
indicate a successful inspection, including when the evidence is stale, failed,
or unverified. A nonzero exit reports an invocation or inspection error. If Mill
reports `MAINTAINED_OUTCOME_POLICY_INSPECTION_UNAVAILABLE`, restore access to
Git and the committed policy and history, then retry the same pinned selection.
`MAINTAINED_OUTCOME_ANCESTRY_INSPECTION_UNAVAILABLE` means Mill could not verify
the ancestry. Each ancestry check is limited to 4,096 candidate commits and 30
seconds. Restore incomplete history and retry. For a lineage beyond those
limits, use a more recent policy commit approved by the owner and collect
evidence for that selection.

An inspection shares a 60-second Git lookup budget and a 16 MiB cumulative
tree-read budget across the selected paths. A path that exceeds either budget
reports unavailable evidence.

| Status       | Meaning                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `current`    | The supplied signed pass covers the selected policy and the artifact, runtime and check.  |
| `stale`      | A binding changed or verified evidence expired. Check the reason before requesting proof. |
| `failed`     | The verifier signed a failure for the selected inputs.                                    |
| `unverified` | No usable verification record establishes the claim.                                      |

The next decision names the owner and the scope of the proposed action. If Mill
cannot read a committed runtime descriptor or check, the handoff names the
unavailable input and withholds a verification request. Rechecking can reuse the
repository's existing CI or an independent runner. For a failure, the owner can
authorize a task to restore this claim while preserving the independent check.
Technical evidence can remain current across an unrelated commit when the policy
and declared inputs match. Mill checks freshness after verifying those inputs.
Owner acceptance is bound to the exact subject and proof the owner reviewed.

This view evaluates the supplied record. To use it in a team workflow, keep the
latest authorized observation in a trusted record store and always supply that
observation. Mill's local inspection does not look up newer failures or check a
deployment. Existing `outcome --run` and regular `handoff` show historical run
evidence and lifecycle progress. [Run outcomes](run-outcome.md)

## Replay the wheel pilot

From the Mill source checkout, build the CLI and run the fixture with Python 3,
its `venv` and pip support, and OpenSSL 3. The pilot uses `sandbox-exec` on
macOS and `libseccomp.so.2` on Linux.

```sh
npm ci --ignore-scripts
npm run build
python3 scripts/qualify-maintained-outcome.py node dist/cli.js
```

The native gate, `npm run check`, exercises the pilot through the installed
tarball via `npm run test:package`. The package check uses `python3` on `PATH`
and fails if the interpreter is unavailable or lacks `venv` and `ensurepip`. Set
`MILL_PORTABLE_RECEIPT_PYTHON` to the absolute path of a working interpreter
when you need to select one explicitly.

```sh
MILL_PORTABLE_RECEIPT_PYTHON=/path/to/python3 npm run check
```

The pilot uses temporary Git and Python environments and disposable keys. It
denies network access to pip and the installed CLI. A loopback control verifies
that the same client can connect before isolation and is denied afterward. The
probe includes the isolation provider and its restrictions in the runtime
identity. The signed claim names the fixed universal filename used to stage the
wheel, so the artifact digest identifies the bytes it installs regardless of the
incoming file's name. Test wheels exercise the expected JSON, an incompatible
value, duplicate JSON member names, an installation rejection, and an entry
point that exits with an error. Each probe measures the interpreter, standard
library, installed pip code, and native libraries. For this synthetic Python
fixture, the verifier checks native load attempts and the libraries reported by
pip and the installed CLI before signing. Controls change pip source without
changing its version and load different native libraries from the same path.
Both changes must produce a different runtime identity. The pilot checks current
evidence, staleness after an artifact change, fresh signed failures, and
acceptance bound to the reviewed revision. The packed-package check exercises
the same pilot in CI.

The pilot has a five-minute deadline for checks and terminates its probe process
group before cleaning the temporary directory on timeout.

The fixture supervisor holds both disposable signing keys and demonstrates
distinct cryptographic identities. The native observer runs inside the
cooperative fixture process, which supplies its report to the supervisor. A team
verifier needs separate custody for each signer's key and a measurement boundary
that the artifact under test cannot write to.

The wheel launcher must point directly to the measured Python interpreter. If
you override `TMPDIR`, use a short executable path without whitespace so pip can
generate a direct Python launcher.

Mill reuses the first result after a documentation-only commit with identical
inputs. A fresh check on the changed wheel detects the incompatible output. The
fixture records the extra check the change required and the one the unrelated
commit avoided. It measures evidence handling against synthetic inputs.
