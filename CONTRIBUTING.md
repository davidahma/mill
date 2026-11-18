# Contributing

Open a [GitHub issue](https://github.com/davidahma/mill/issues) for a
reproducible defect or to discuss a change that affects an approval, contract or
execution boundary. Describe the observed outcome, the expected outcome and the
smallest case that shows the difference.

1. Build using the Node version in [.node-version](.node-version) and
   `npm ci --ignore-scripts`.
2. Read [the working contract](AGENTS.md) and the relevant section of the
   [development guide](docs/development.md). For bug fixes, add the smallest
   regression case. For contract changes, cover both accepted and rejected
   input.
3. Run `npm run check` and `npm audit --omit=dev --audit-level=high`. Run
   affected real OCI canaries when you change their execution paths.
4. Sign off every commit with `git commit -s`. By signing off, you certify the
   [Developer Certificate of Origin 1.1](https://developercertificate.org/).
   [Apache-2.0](LICENSE) applies to accepted contributions.
5. In the PR, include checks, limits and any agent assistance that affected the
   change. Keep private logs, credentials, real customer data and local state
   out of the patch.

For a vulnerability, follow the [private reporting path](SECURITY.md).
