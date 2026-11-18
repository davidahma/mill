# Prepare one outcome

Use the source-built CLI from a repository containing these two input files. The
project's [quick start](../../README.md#quick-start) runs the same example in a
temporary repository:

```sh
millctl --json init prepare \
  --prd examples/preparation/PRD.md \
  --request examples/preparation/request.yaml
```

The result inventories conventional planning files, reports contradictions and
missing decisions, and returns source, product, scenario and impact drafts in
JSON. It reads local files without executing repository commands, calling a
model, writing authority files, or approving an outcome.

This request deliberately leaves acceptance and its independent preparer open.
Expect blocking questions and `executionReady: false`. A draft's `schemaValid`
field reports structural validity only. Null fields and empty arrays show
incomplete scaffolding and need owner decisions before schema validation can
pass. No task or ready outcome is generated.

The optional `inputs` object selects existing `sources`, `proposal`, `product`,
`scenarios`, `impact`, `plan` and `policy` paths. Without it, Mill inventories
`product/sources.yaml`, `product/proposal.yaml`, `product/contract.yaml`,
`quality/scenarios.yaml`, `product/impact.yaml`, `product/plan.yaml` and
`mill.yaml`. Missing conventional files are expected during first preparation.
Selected paths must name repository-relative regular files.

When extending an existing product, reuse its outcome and acceptance IDs only
while their meanings remain the same. Supply `outcome.acceptanceIds` to select
existing acceptance, or draft `acceptance` and `invariants` using the existing
product contract shapes. An `acceptancePreparer` names the proposed independent
owner; it does not establish independence or approval by itself.

Context disclosure reports paths, byte counts and identical repeated material
from this static read. Later worker reads and model token costs remain unknown.
These paths are priority context, not a filesystem read ACL or a token cap.

Resolve the questions, independently prepare acceptance, and review exact
authority through the ordinary planning process before task compilation.
