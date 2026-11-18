import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { stringify as yaml } from "yaml";

import { canonicalDigest } from "../src/contracts/canonical.js";
import { prepareOutcome } from "../src/planning/preparation.js";
import { textDigest } from "../src/runtime/inputs.js";
import { temporaryDirectory } from "./helpers.js";

async function preparationFixture() {
  const directory = await temporaryDirectory("mill-preparation-");
  const root = directory.path;
  await mkdir(path.join(root, "product"));
  await writeFile(
    path.join(root, "product/PRD.md"),
    "# Counter\nShow one saved counter value.\n",
  );
  const request = {
    schemaVersion: "1",
    id: "saved-counter",
    outcome: {
      id: "OUT-SAVED-COUNTER",
      statement: "Show one saved counter value.",
    },
    oracleOwner: "repository",
  };
  const requestPath = "product/request.yaml";
  const writeRequest = async (value: unknown) =>
    writeFile(path.join(root, requestPath), yaml(value));
  await writeRequest(request);
  return {
    root,
    request,
    writeRequest,
    input: { root, prdPath: "product/PRD.md", requestPath },
    cleanup: directory.cleanup,
  };
}

describe("deterministic outcome preparation", () => {
  it("keeps unresolved requirements and independent acceptance ownership blocking without writing authority", async () => {
    const fixture = await preparationFixture();
    try {
      const before = await readdir(path.join(fixture.root, "product"));
      const prepared = await prepareOutcome(fixture.input);
      expect(prepared.authority).toBe("draft_only");
      expect(prepared.executionReady).toBe(false);
      expect(
        prepared.questions.some((question) => question.id === "acceptance"),
      ).toBe(true);
      expect(
        prepared.questions.some(
          (question) => question.id === "acceptance-preparer",
        ),
      ).toBe(true);
      expect(prepared.drafts.map((draft) => draft.kind)).not.toContain("task");
      expect(JSON.stringify(prepared.drafts)).not.toContain('"status":"ready"');
      expect(
        prepared.drafts.find((draft) => draft.kind === "impact")?.content,
      ).toMatchObject({ approval: null, acceptanceIds: [] });
      expect(await prepareOutcome(fixture.input)).toEqual(prepared);
      expect(await readdir(path.join(fixture.root, "product"))).toEqual(before);
      expect(prepared.contextDisclosure.workerReads).toBe("unknown");
      expect(prepared.contextDisclosure.isReadAcl).toBe(false);
      expect(prepared.contextDisclosure.isTokenCap).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    { outcome: { id: "wrong", statement: "Wrong ID." } },
    {
      acceptance: [
        {
          id: "ACC-SAVED",
          kind: "functional",
          statement: "Value is saved.",
          sourceRefs: ["SRC-PRD"],
        },
        {
          id: "ACC-SAVED",
          kind: "functional",
          statement: "Value is duplicated.",
          sourceRefs: ["SRC-PRD"],
        },
      ],
    },
    {
      outcome: {
        id: "OUT-SAVED-COUNTER",
        statement: "Show a value.",
        acceptanceIds: ["ACC-SAVED", "ACC-SAVED"],
      },
    },
    { approval: { approvedBy: "request text", proposalDigest: "ignored" } },
    { status: "ready" },
    {
      oracleOwner: "repository",
      acceptancePreparer: "builder",
      independentAcceptance: true,
    },
  ])(
    "rejects invalid, duplicate or authority-bearing request input %j",
    async (patch) => {
      const fixture = await preparationFixture();
      try {
        await fixture.writeRequest({ ...fixture.request, ...patch });
        await expect(prepareOutcome(fixture.input)).rejects.toMatchObject({
          code: "INVALID_PREPARATION_REQUEST",
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("reports unresolved acceptance IDs without fabricating acceptance", async () => {
    const fixture = await preparationFixture();
    try {
      await fixture.writeRequest({
        ...fixture.request,
        outcome: { ...fixture.request.outcome, acceptanceIds: ["ACC-UNKNOWN"] },
      });
      const prepared = await prepareOutcome(fixture.input);
      expect(prepared.contradictions).toContain(
        "acceptance is unresolved: ACC-UNKNOWN",
      );
      expect(
        prepared.drafts.find((draft) => draft.kind === "product")?.content,
      ).toMatchObject({ acceptance: [] });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects escaping and symbolic-link input paths before inventory", async () => {
    const fixture = await preparationFixture();
    try {
      await expect(
        prepareOutcome({ ...fixture.input, prdPath: "../private.md" }),
      ).rejects.toMatchObject({ code: "PREPARATION_PATH_INVALID" });
      await fixture.writeRequest({
        ...fixture.request,
        inputs: { product: "../private.yaml" },
      });
      await expect(prepareOutcome(fixture.input)).rejects.toMatchObject({
        code: "INVALID_PREPARATION_REQUEST",
      });
      await symlink(
        path.join(fixture.root, "product/PRD.md"),
        path.join(fixture.root, "linked.md"),
      );
      await expect(
        prepareOutcome({ ...fixture.input, prdPath: "linked.md" }),
      ).rejects.toMatchObject({ code: "UNSAFE_FILE_TYPE" });
      expect(
        await readFile(path.join(fixture.root, "product/PRD.md"), "utf8"),
      ).toContain("# Counter");
    } finally {
      await fixture.cleanup();
    }
  });

  it("reuses existing stable acceptance and reports changed ID semantics and stale scenario bindings", async () => {
    const fixture = await preparationFixture();
    try {
      const product = {
        schemaVersion: "1",
        id: "counter",
        title: "Counter",
        primaryUser: "Counter user",
        jobToBeDone: "Resume a saved count",
        outcomes: [
          { ...fixture.request.outcome, acceptanceIds: ["ACC-SAVED"] },
        ],
        nonGoals: [],
        assumptions: [],
        unknowns: [],
        sourceRefs: ["SRC-PRD"],
        acceptance: [
          {
            id: "ACC-SAVED",
            kind: "functional",
            statement: "Reopening shows the saved value.",
            sourceRefs: ["SRC-PRD"],
          },
        ],
        invariants: [
          {
            id: "INV-NONNEGATIVE",
            statement: "The count is nonnegative.",
            owner: "maintainer",
            criticality: "high",
            surfaceRefs: ["counter"],
            verification: { mode: "command", ref: "test" },
            sourceRefs: ["SRC-PRD"],
            unknowns: [],
          },
        ],
        decisions: [],
      };
      const scenarios = {
        schemaVersion: "1",
        productContractDigest: canonicalDigest(product),
        scenarios: [
          {
            id: "SCN-SAVED",
            kind: "normal",
            given: ["A value has been saved."],
            when: ["The product is reopened."],
            then: ["The saved value is shown."],
            oracleOwner: "repository",
            acceptanceRefs: ["ACC-SAVED"],
            invariantRefs: ["INV-NONNEGATIVE"],
            coverage: "both",
            visibility: "reviewer_owned",
            executionRef: "test",
            forbidden: [],
          },
        ],
      };
      await mkdir(path.join(fixture.root, "quality"));
      await writeFile(
        path.join(fixture.root, "product/contract.yaml"),
        yaml(product),
      );
      await writeFile(
        path.join(fixture.root, "quality/scenarios.yaml"),
        yaml(scenarios),
      );
      await fixture.writeRequest({
        ...fixture.request,
        acceptancePreparer: "maintainer",
        outcome: { ...fixture.request.outcome, acceptanceIds: ["ACC-SAVED"] },
      });
      const prepared = await prepareOutcome(fixture.input);
      expect(prepared.contradictions).toEqual([]);
      expect(
        prepared.drafts.find((draft) => draft.kind === "product")?.content,
      ).toEqual(product);
      expect(
        prepared.drafts.find((draft) => draft.kind === "scenarios")?.content,
      ).toEqual(scenarios);
      expect(prepared.questions.map((question) => question.id)).not.toContain(
        "acceptance",
      );
      expect(prepared.acceptanceOwnership).toMatchObject({
        preparer: "maintainer",
        independentlyApproved: false,
      });
      await fixture.writeRequest({
        ...fixture.request,
        outcome: {
          ...fixture.request.outcome,
          statement: "Show a different outcome.",
          acceptanceIds: ["ACC-SAVED"],
        },
        acceptance: [
          {
            ...product.acceptance[0],
            statement: "Overwrite the meaning of the existing acceptance.",
          },
        ],
      });
      await writeFile(
        path.join(fixture.root, "quality/scenarios.yaml"),
        yaml({
          ...scenarios,
          productContractDigest: `sha256:${"0".repeat(64)}`,
        }),
      );
      const conflicting = await prepareOutcome(fixture.input);
      expect(conflicting.contradictions).toEqual(
        expect.arrayContaining([
          "outcome ID has different semantics: OUT-SAVED-COUNTER",
          "stable ID has different semantics: ACC-SAVED",
          "existing scenario set binds another product contract",
        ]),
      );
      expect(
        conflicting.drafts.find((draft) => draft.kind === "product")?.content,
      ).toEqual(product);
    } finally {
      await fixture.cleanup();
    }
  });

  it("discloses repeated material and explicitly selected missing inputs without reading unknown worker context", async () => {
    const fixture = await preparationFixture();
    try {
      const prd = await readFile(
        path.join(fixture.root, "product/PRD.md"),
        "utf8",
      );
      await fixture.writeRequest({
        ...fixture.request,
        oracleOwner: "unknown",
        inputs: { policy: "product/PRD.md", impact: "product/missing.yaml" },
      });
      const prepared = await prepareOutcome(fixture.input);
      expect(prepared.contradictions).toContain(
        "selected impact input is missing: product/missing.yaml",
      );
      expect(prepared.contextDisclosure.repeatedMaterial).toEqual([
        {
          digest: textDigest(prd),
          paths: ["product/PRD.md", "product/PRD.md"],
          occurrences: 2,
          repeatedBytes: Buffer.byteLength(prd),
        },
      ]);
      expect(prepared.questions.map((question) => question.id)).toContain(
        "oracle-owner",
      );
      expect(prepared.contextDisclosure.modelCalls).toBe(0);
      expect(prepared.contextDisclosure.totalReadBytes).toBe(
        Buffer.byteLength(prd) * 2 +
          Buffer.byteLength(
            await readFile(
              path.join(fixture.root, "product/request.yaml"),
              "utf8",
            ),
          ),
      );
      await writeFile(
        path.join(fixture.root, "product/contract.yaml"),
        "schemaVersion: '1'\nnotAContract: true\n",
      );
      expect(
        (await prepareOutcome(fixture.input)).inventory.find(
          (entry) => entry.kind === "product",
        )?.status,
      ).toBe("invalid");
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps example preparation deterministic and unresolved", async () => {
    const fixture = await preparationFixture();
    try {
      const exampleRoot = path.join(
        import.meta.dirname,
        "../examples/preparation",
      );
      await writeFile(
        path.join(fixture.root, "product/PRD.md"),
        await readFile(path.join(exampleRoot, "PRD.md")),
      );
      await writeFile(
        path.join(fixture.root, "product/request.yaml"),
        await readFile(path.join(exampleRoot, "request.yaml")),
      );
      const prepared = await prepareOutcome(fixture.input);
      expect(prepared.outcomeId).toBe("OUT-SAVED-COUNTER");
      expect(prepared.contradictions).toEqual([]);
      expect(prepared.executionReady).toBe(false);
      expect(prepared.questions.map((question) => question.id)).toEqual(
        expect.arrayContaining([
          "acceptance",
          "oracle-owner",
          "acceptance-preparer",
        ]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves blocking source, proposal, scenario and closed-history contradictions", async () => {
    const fixture = await preparationFixture();
    try {
      const zeroDigest = `sha256:${"0".repeat(64)}`;
      const item = {
        id: "ACC-SAVED",
        kind: "functional",
        statement: "Saved count is shown.",
        sourceRefs: ["SRC-MISSING"],
      };
      const product = {
        schemaVersion: "1",
        id: "counter",
        title: "Counter",
        primaryUser: "Counter user",
        jobToBeDone: "Resume a count",
        outcomes: [
          { ...fixture.request.outcome, acceptanceIds: ["ACC-ORIGINAL"] },
        ],
        nonGoals: [],
        assumptions: [],
        unknowns: ["Choose a storage mechanism."],
        sourceRefs: ["SRC-MISSING"],
        acceptance: [item, item],
        invariants: [],
        decisions: [
          {
            id: "DEC-STORAGE",
            kind: "architecture",
            question: "Which storage mechanism?",
            decision: "Pending",
            rationale: "Requires owner decision",
            sourceRefs: ["SRC-PRD"],
            status: "proposed",
            costlyToReverse: false,
          },
        ],
      };
      const scenario = {
        id: "SCN-SAVED",
        kind: "normal",
        given: ["A saved value exists."],
        when: ["Reopen."],
        then: ["Value is shown."],
        oracleOwner: "external",
        acceptanceRefs: ["ACC-SAVED", "ACC-UNRESOLVED"],
        invariantRefs: ["INV-MISSING"],
        coverage: "both",
        visibility: "human_acceptance",
        forbidden: [],
      };
      const scenarios = {
        schemaVersion: "1",
        productContractDigest: zeroDigest,
        scenarios: [scenario],
      };
      const source = {
        id: "SRC-PRD",
        class: "user_evidence",
        uri: "product/PRD.md",
        revision: zeroDigest,
        observedAt: "2026-10-01T00:00:00.000Z",
        freshness: "unknown",
        authority: "evidence",
        claims: ["Synthetic input."],
      };
      const sources = {
        schemaVersion: "1",
        trigger: "bootstrap",
        providers: [
          {
            id: "operator",
            name: "Local fixture",
            queries: [],
            networkDisclosure: "None",
          },
        ],
        sources: [
          source,
          { ...source, id: "SRC-REQUEST", uri: "product/request.yaml" },
          { ...source, id: "SRC-REQUEST", uri: "product/other.yaml" },
        ],
      };
      const proposal = {
        schemaVersion: "1",
        prd: { path: "product/other.md", digest: zeroDigest },
        sourceManifestDigest: zeroDigest,
        productContract: { ...product, title: "Other product" },
        blueprints: [
          {
            schemaVersion: "1",
            id: "fixture",
            productContractDigest: zeroDigest,
            recipe: "fixture",
            recipeVersion: "1",
            runtime: "fixture",
            architecture: ["Synthetic"],
            risks: [],
          },
        ],
        scenarioSet: {
          ...scenarios,
          scenarios: [{ ...scenario, given: ["Different fixture."] }],
        },
        assumptions: [],
        contradictions: [
          {
            id: "CON-STORAGE",
            statement: "Storage declarations conflict.",
            sourceRefs: ["SRC-PRD", "SRC-REQUEST"],
            blocking: true,
          },
        ],
        questions: [
          {
            id: "Q-STORAGE",
            prompt: "Resolve storage semantics.",
            recommendedDefault: "No default",
            reversible: true,
            blocking: true,
          },
        ],
        status: "proposed",
      };
      const impact = {
        schemaVersion: "1",
        id: "saved-counter",
        productContractDigest: zeroDigest,
        outcomeId: fixture.request.outcome.id,
        riskClass: "medium",
        acceptanceIds: ["ACC-SAVED"],
        affectedInvariantIds: [],
        uncertainInvariantIds: [],
        surfaces: [
          { id: "counter", kind: "user", change: "Shows saved count" },
        ],
        scenarioIds: ["SCN-SAVED"],
        commandIds: ["test"],
        materialDecisions: [],
        unresolved: [],
        exceptions: [],
        approval: null,
      };
      const plan = {
        schemaVersion: "1",
        productContractDigest: zeroDigest,
        outcomes: [
          {
            id: fixture.request.outcome.id,
            title: "Saved count",
            acceptance: ["Shown count"],
            dependsOn: [],
            status: "closed",
          },
        ],
      };
      await mkdir(path.join(fixture.root, "quality"));
      for (const [file, content] of [
        ["product/contract.yaml", product],
        ["product/sources.yaml", sources],
        ["product/proposal.yaml", proposal],
        ["product/impact.yaml", impact],
        ["product/plan.yaml", plan],
        ["quality/scenarios.yaml", scenarios],
      ] as const)
        await writeFile(path.join(fixture.root, file), yaml(content));
      await fixture.writeRequest({
        ...fixture.request,
        outcome: { ...fixture.request.outcome, acceptanceIds: ["ACC-SAVED"] },
      });
      const prepared = await prepareOutcome(fixture.input);
      expect(prepared.contradictions).toEqual(
        expect.arrayContaining([
          "existing proposal binds different PRD bytes or path",
          "existing proposal source manifest is stale",
          "existing proposal and product input disagree",
          "existing proposal and scenario input disagree",
          "existing blocking contradiction: CON-STORAGE: Storage declarations conflict.",
          "existing impact binds another product contract",
          "existing outcome plan binds another product contract",
          "existing stable ID is reused: ACC-SAVED",
          "outcome acceptance set differs: OUT-SAVED-COUNTER",
          "closed outcome needs a fresh follow-up ID: OUT-SAVED-COUNTER",
          "existing PRD source is stale: SRC-PRD",
          "existing request source is stale: SRC-REQUEST",
          "existing source identities are duplicated",
          "source reference is unresolved: ACC-SAVED/SRC-MISSING",
          "product source reference is unresolved: SRC-MISSING",
          "existing scenario acceptance is unresolved: SCN-SAVED/ACC-UNRESOLVED",
          "existing scenario invariant is unresolved: SCN-SAVED/INV-MISSING",
          "selected scenario crosses outcome acceptance scope: SCN-SAVED",
          "selected scenario oracle owner differs from request: SCN-SAVED",
        ]),
      );
      expect(prepared.questions.map((question) => question.id)).toEqual(
        expect.arrayContaining([
          "existing:Q-STORAGE",
          "decision:DEC-STORAGE",
          "product-unknown:1",
        ]),
      );
      expect(
        prepared.drafts.find((draft) => draft.kind === "impact")?.content,
      ).toMatchObject({ riskClass: "medium", approval: null });
      await writeFile(
        path.join(fixture.root, "quality/scenarios.yaml"),
        yaml({
          ...scenarios,
          scenarios: [{ ...scenario, oracleOwner: "repository" }],
        }),
      );
      expect(
        (await prepareOutcome(fixture.input)).questions.map(
          (question) => question.id,
        ),
      ).toContain("oracle:SCN-SAVED");
      await writeFile(
        path.join(fixture.root, "product/sources.yaml"),
        yaml({
          ...sources,
          sources: sources.sources.map((entry) => ({
            ...entry,
            uri: `old/${entry.uri}`,
          })),
        }),
      );
      const collisions = await prepareOutcome(fixture.input);
      const draftSources = collisions.drafts.find(
        (draft) => draft.kind === "sources",
      )?.content.sources as { id: string }[];
      expect(
        draftSources.filter(
          (entry) =>
            entry.id.startsWith("SRC-PRD-") ||
            entry.id.startsWith("SRC-REQUEST-"),
        ),
      ).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });
});
