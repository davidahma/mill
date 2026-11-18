# Security

## Report a vulnerability

Use
[GitHub private vulnerability reporting](https://github.com/davidahma/mill/security/advisories/new).
Include the exact commit, affected interface, observed impact and a minimal
reproduction without credentials or private source. The maintainer coordinates
triage and disclosure on a best-effort basis.

## Execution and credentials

The built-in Codex worker runs on a trusted host. Its disposable worktree and
workspace sandbox limit normal edits. They provide no hostile-host containment
for the rest of the filesystem, keychain, local services or network. Use a host
and repository whose exposure you can accept.

Native verification uses a pre-prepared digest-pinned container with a read-only
source mount, bounded resources and no network. Dependency preparation is a
separate attended action. A Docker daemon is part of this trust boundary.

Codex and `gh` authenticate through the operator's existing sessions. Only the
attended shipper may use a configured delivery credential. Keep credentials, raw
model text and local run state out of commits and shared troubleshooting
material. External verification accepts only an Ed25519 public verification key
in repository configuration. The independent runner keeps its signing key in its
own controlled environment.

The [delivery guide](docs/delivery-access.md) describes scoping the GitHub
identity. The [operator guide](docs/operator-guide.md) covers approval and
recovery.
