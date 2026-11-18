# Support

Mill is a public source preview maintained on a best-effort basis.

Use [GitHub Issues](https://github.com/davidahma/mill/issues) for reproducible
defects. Include the full source commit, controller digest from
`millctl --json build-info`, OS and tool versions, command, stable error code
and a minimal reproduction. Inspect and redact any support-bundle output before
sharing it. For vulnerabilities, use [private reporting](SECURITY.md).

The public CI checks the native CLI and selected pnpm and Python CPU fixtures.
The bundled web recipe and frozen adoption contracts describe bounded ways to
onboard repositories. GPU workloads, arbitrary workspace layouts, CUDA, vLLM and
native dependencies each need target-specific qualification. Personal account
recovery, production incident response and hosted execution are outside the
project's support scope.

Follow [source distribution](docs/release.md) for artifact identity and
rollback, or [operator recovery](docs/operator-guide.md#resume-or-reconcile) for
a blocked run.
