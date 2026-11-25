# Source distribution

Build this public preview from a reviewed Git revision. The repository's
`package.json` is private. The local packed-package test builds and installs a
tarball in a temporary consumer to exercise the CLI, its schemas and bundled
files. GitHub Actions performs verification and requires no publication
credentials.

## Source identity

Record the full Git commit and the CLI's controller digest. A branch name alone
will resolve to different source over time.

```sh
git rev-parse HEAD
npm ci --ignore-scripts
npm run clean
npm run build
node dist/cli.js --json build-info
```

For another machine, check out the same full revision, use its committed
lockfile and compare the returned `controllerDigest` with the reviewed identity.
New integration and native adoption locks record this digest, so another binary
with the same version cannot silently take its place. An existing lock without a
digest retains its historical version check. The controller digest covers Mill's
compiled JavaScript, runtime scripts and direct dependency declarations. The Git
revision and lockfile identify the source and dependency inputs. Retain the
outer artifact digest when transferring a tarball.

If you share a local tarball, retain the exact bytes and its SHA-256 along with
the source identity. Verify both the outer tarball digest and the CLI's
controller identity before using it. Keep the earlier validated source revision
or artifact for rollback and preserve any operational evidence it produced.

## CI evidence

Use the runs linked from the public repository's
[CI workflow](https://github.com/davidahma/mill/actions/workflows/ci.yml).
Inspect the result for the source revision you intend to use. Three checks are
expected:

- `validate` runs the native suite, the maintained-outcome wheel pilot through
  the packed package, production dependency audits for Mill and the web starter,
  and an exact-checkout structural audit.
- `pnpm-oci` runs the pinned pnpm fixture in a real local Docker environment.
- `python-oci` runs the pinned Python CPU fixture, including wheel installation
  and negative controls.

These checks qualify what they exercise. Where you intend to use an external
runner, qualify that runner separately on your target platform and claims.
[Support](../SUPPORT.md) defines the limits of the source preview.

## Historical distribution records

The [earlier version notes](releases/) describe the predecessor's registry
distribution as observed at the time. Their repository identities and dated
qualification evidence apply to those versions. They are kept for reference and
do not confer support on this repository's source checkout. The archived
workflow cases under [test fixtures](../test/fixtures/workflows/) exercise
historical release-policy verification without creating an active release job.
