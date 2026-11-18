import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { canonicalDigest, type JsonValue } from "../contracts/canonical.js";
import {
  changeRequestSchema,
  impactManifestSchema,
  invariantSchema,
  outcomePlanSchema,
  productContractSchema,
  scenarioSetSchema,
  sourceManifestSchema,
  specificationProposalSchema,
} from "../contracts/schemas.js";
import { ExitCode, MillError } from "../errors.js";
import { textDigest } from "../runtime/inputs.js";
import { safeReadText } from "../security/safe-path.js";

const inputPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      !/[\\:*?[\]]/u.test(value) &&
      !value.includes(String.fromCharCode(0)) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..") &&
      !value.split("/").some((part) => /^\.env(?:\.|$)|^\.npmrc$/u.test(part)),
    "expected a nonsensitive repository-relative file path",
  );

/** Narrative request fields never confer execution or approval authority. */
export const preparationRequestSchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    id: changeRequestSchema.shape.id,
    outcome: productContractSchema.shape.outcomes.element,
    oracleOwner: z.enum(["repository", "human", "external", "unknown"]),
    acceptancePreparer: z.string().trim().min(1).optional(),
    primaryUser: z.string().trim().min(1).optional(),
    jobToBeDone: z.string().trim().min(1).optional(),
    nonGoals: productContractSchema.shape.nonGoals.optional(),
    acceptance: productContractSchema.shape.acceptance.optional(),
    invariants: z.array(invariantSchema).optional(),
    inputs: z
      .strictObject({
        sources: inputPathSchema.optional(),
        proposal: inputPathSchema.optional(),
        product: inputPathSchema.optional(),
        scenarios: inputPathSchema.optional(),
        impact: inputPathSchema.optional(),
        plan: inputPathSchema.optional(),
        policy: inputPathSchema.optional(),
      })
      .optional(),
  })
  .superRefine((request, context) => {
    const ids = [
      request.outcome.id,
      ...(request.acceptance ?? []).map((item) => item.id),
      ...(request.invariants ?? []).map((item) => item.id),
    ];
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "stable IDs must be unique",
      });
    }
  });

export type PreparationRequest = z.infer<typeof preparationRequestSchema>;
type InputKind =
  | "sources"
  | "proposal"
  | "product"
  | "scenarios"
  | "impact"
  | "plan"
  | "policy";
type DraftKind = "sources" | "product" | "scenarios" | "impact";
const inputDefaults: Record<InputKind, string> = {
  sources: "product/sources.yaml",
  proposal: "product/proposal.yaml",
  product: "product/contract.yaml",
  scenarios: "quality/scenarios.yaml",
  impact: "product/impact.yaml",
  plan: "product/plan.yaml",
  policy: "mill.yaml",
};
const inputSchemas: Partial<Record<InputKind, z.ZodType>> = {
  sources: sourceManifestSchema,
  proposal: specificationProposalSchema,
  product: productContractSchema,
  scenarios: scenarioSetSchema,
  impact: impactManifestSchema,
  plan: outcomePlanSchema,
};
const digest = (value: unknown) => canonicalDigest(value as JsonValue);
const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

export interface PreparationQuestion {
  id: string;
  prompt: string;
  blocking: true;
}

export interface PreparationDraft {
  kind: DraftKind;
  path: string;
  authority: "draft_only";
  schemaValid: boolean;
  content: Record<string, unknown>;
  unresolved: string[];
}

function parseInput(source: string, inputPath: string): unknown {
  return path.extname(inputPath).toLowerCase() === ".json"
    ? JSON.parse(source)
    : parseYaml(source);
}

/** Static inspection and scaffolding for one supplied outcome; no Git, command, state or worker calls. */
export async function prepareOutcome(input: {
  root: string;
  prdPath: string;
  requestPath: string;
}) {
  for (const value of [input.prdPath, input.requestPath]) {
    if (!inputPathSchema.safeParse(value).success) {
      throw new MillError(
        "PREPARATION_PATH_INVALID",
        "Preparation inputs must be nonsensitive repository-relative files.",
        ExitCode.data,
      );
    }
  }
  const [prd, requestText] = await Promise.all([
    safeReadText(input.root, input.prdPath),
    safeReadText(input.root, input.requestPath),
  ]);
  let request: PreparationRequest;
  try {
    request = preparationRequestSchema.parse(
      parseInput(requestText, input.requestPath),
    );
  } catch {
    throw new MillError(
      "INVALID_PREPARATION_REQUEST",
      "Preparation needs one valid bounded request without approval, ready status or execution authority.",
      ExitCode.data,
    );
  }
  const contradictions: string[] = [];
  const questions: PreparationQuestion[] = [];
  const ask = (id: string, prompt: string) =>
    questions.push({ id, prompt, blocking: true });
  const inventory = await Promise.all(
    (Object.keys(inputDefaults) as InputKind[]).map(async (kind) => {
      const selectedPath = request.inputs?.[kind] ?? inputDefaults[kind];
      let text: string;
      try {
        text = await safeReadText(input.root, selectedPath);
      } catch (error) {
        if (!(error instanceof MillError && error.code === "FILE_NOT_FOUND"))
          throw error;
        if (request.inputs?.[kind] !== undefined)
          contradictions.push(
            `selected ${kind} input is missing: ${selectedPath}`,
          );
        return {
          kind,
          path: selectedPath,
          status: "missing" as const,
          bytes: 0,
          digest: null,
          value: undefined,
        };
      }
      let value: unknown;
      try {
        value =
          kind === "policy"
            ? undefined
            : inputSchemas[kind]?.parse(parseInput(text, selectedPath));
      } catch {
        contradictions.push(
          `existing ${kind} input does not satisfy its schema: ${selectedPath}`,
        );
        return {
          kind,
          path: selectedPath,
          status: "invalid" as const,
          bytes: Buffer.byteLength(text),
          digest: textDigest(text),
          value: undefined,
        };
      }
      return {
        kind,
        path: selectedPath,
        status: "present" as const,
        bytes: Buffer.byteLength(text),
        digest: textDigest(text),
        value,
      };
    }),
  );
  const get = (kind: InputKind) =>
    inventory.find((entry) => entry.kind === kind)?.value;
  const proposal = get("proposal") as
    z.infer<typeof specificationProposalSchema> | undefined;
  const productInput = get("product") as
    z.infer<typeof productContractSchema> | undefined;
  const product = productInput ?? proposal?.productContract;
  const scenariosInput = get("scenarios") as
    z.infer<typeof scenarioSetSchema> | undefined;
  const scenarios = scenariosInput ?? proposal?.scenarioSet;
  const sources = get("sources") as
    z.infer<typeof sourceManifestSchema> | undefined;
  const impact = get("impact") as
    z.infer<typeof impactManifestSchema> | undefined;
  const plan = get("plan") as z.infer<typeof outcomePlanSchema> | undefined;
  const prdDigest = textDigest(prd);
  const requestDigest = textDigest(requestText);
  if (proposal !== undefined) {
    if (
      proposal.prd.path !== input.prdPath ||
      proposal.prd.digest !== prdDigest
    )
      contradictions.push(
        "existing proposal binds different PRD bytes or path",
      );
    if (
      sources !== undefined &&
      proposal.sourceManifestDigest !== digest(sources)
    )
      contradictions.push("existing proposal source manifest is stale");
    if (
      productInput !== undefined &&
      digest(proposal.productContract) !== digest(productInput)
    )
      contradictions.push("existing proposal and product input disagree");
    if (
      scenariosInput !== undefined &&
      digest(proposal.scenarioSet) !== digest(scenariosInput)
    )
      contradictions.push("existing proposal and scenario input disagree");
    contradictions.push(
      ...proposal.contradictions
        .filter((item) => item.blocking)
        .map(
          (item) =>
            `existing blocking contradiction: ${item.id}: ${item.statement}`,
        ),
    );
    for (const question of proposal.questions.filter((item) => item.blocking))
      ask(`existing:${question.id}`, question.prompt);
  }
  if (product !== undefined) {
    if (
      scenarios !== undefined &&
      scenarios.productContractDigest !== digest(product)
    )
      contradictions.push(
        "existing scenario set binds another product contract",
      );
    if (
      impact !== undefined &&
      impact.productContractDigest !== digest(product)
    )
      contradictions.push("existing impact binds another product contract");
    if (plan !== undefined && plan.productContractDigest !== digest(product))
      contradictions.push(
        "existing outcome plan binds another product contract",
      );
    const allIds = [
      ...product.outcomes,
      ...product.acceptance,
      ...product.invariants,
      ...product.decisions,
      ...(scenarios?.scenarios ?? []),
    ].map((item) => item.id);
    for (const id of sortedUnique(
      allIds.filter((id, index) => allIds.indexOf(id) !== index),
    ))
      contradictions.push(`existing stable ID is reused: ${id}`);
    const existingOutcome = product.outcomes.find(
      (item) => item.id === request.outcome.id,
    );
    if (
      existingOutcome !== undefined &&
      existingOutcome.statement !== request.outcome.statement
    )
      contradictions.push(
        `outcome ID has different semantics: ${request.outcome.id}`,
      );
    if (
      existingOutcome?.acceptanceIds !== undefined &&
      request.outcome.acceptanceIds !== undefined &&
      digest([...existingOutcome.acceptanceIds].sort()) !==
        digest([...request.outcome.acceptanceIds].sort())
    )
      contradictions.push(
        `outcome acceptance set differs: ${request.outcome.id}`,
      );
  }
  if (
    plan?.outcomes.some(
      (item) => item.id === request.outcome.id && item.status === "closed",
    )
  )
    contradictions.push(
      `closed outcome needs a fresh follow-up ID: ${request.outcome.id}`,
    );
  const mergeItems = <T extends { id: string }>(
    existing: readonly T[],
    supplied: readonly T[],
  ) => {
    const result = [...existing];
    for (const item of supplied) {
      const previous = existing.find((candidate) => candidate.id === item.id);
      if (previous === undefined) result.push(item);
      else if (digest(previous) !== digest(item))
        contradictions.push(`stable ID has different semantics: ${item.id}`);
    }
    return result;
  };
  const acceptance = mergeItems(
    product?.acceptance ?? [],
    request.acceptance ?? [],
  );
  const invariants = mergeItems(
    product?.invariants ?? [],
    request.invariants ?? [],
  );
  const existingOutcome = product?.outcomes.find(
    (item) => item.id === request.outcome.id,
  );
  const acceptanceIds =
    request.outcome.acceptanceIds ??
    existingOutcome?.acceptanceIds ??
    (request.acceptance ?? []).map((item) => item.id);
  for (const id of acceptanceIds)
    if (!acceptance.some((item) => item.id === id))
      contradictions.push(`acceptance is unresolved: ${id}`);
  if (acceptanceIds.length === 0)
    ask(
      "acceptance",
      "Which stable acceptance IDs and observable behavior define this one outcome? Supply acceptance items or select existing IDs.",
    );
  if (request.primaryUser === undefined && product === undefined)
    ask(
      "primary-user",
      "Who uses this outcome and bears its operational consequences?",
    );
  if (request.jobToBeDone === undefined && product === undefined)
    ask("job-to-be-done", "What user job does this bounded outcome serve?");
  if (invariants.length === 0)
    ask(
      "invariants",
      "Which existing behavior must remain true, and how will independent evidence check it?",
    );
  if (request.oracleOwner === "unknown")
    ask(
      "oracle-owner",
      "Does the acceptance oracle belong to the repository, a human, or an external system?",
    );
  if (request.acceptancePreparer === undefined)
    ask(
      "acceptance-preparer",
      "Who independently prepares and approves acceptance before the builder is admitted?",
    );
  else
    ask(
      "acceptance-independence",
      `Confirm that ${request.acceptancePreparer} owns acceptance independently of the builder and review the exact oracle through the normal approval path.`,
    );
  for (const decision of product?.decisions ?? [])
    if (decision.status !== "approved")
      ask(`decision:${decision.id}`, decision.question);
  for (const [index, unknown] of (product?.unknowns ?? []).entries())
    ask(`product-unknown:${index + 1}`, unknown);
  ask(
    "bounded-scope",
    "Review allowed implementation paths, preservation impact, native commands, execution budget and stop conditions before compiling any task.",
  );
  ask(
    "separate-approval",
    "Review and commit exact product, scenario and impact authority separately; this preparation grants no approval or model spend.",
  );

  const prdSource = sources?.sources.find((item) => item.uri === input.prdPath);
  const requestSource = sources?.sources.find(
    (item) => item.uri === input.requestPath,
  );
  const freshSourceId = (preferred: string, inputDigest: string) =>
    sources?.sources.some((item) => item.id === preferred)
      ? `${preferred}-${inputDigest.slice(7).toUpperCase()}`
      : preferred;
  const sourceId = prdSource?.id ?? freshSourceId("SRC-PRD", prdDigest);
  const requestSourceId =
    requestSource?.id ?? freshSourceId("SRC-REQUEST", requestDigest);
  if (
    prdSource !== undefined &&
    prdSource.revision !== prdDigest &&
    prdSource.digest !== prdDigest
  )
    contradictions.push(`existing PRD source is stale: ${prdSource.id}`);
  if (
    requestSource !== undefined &&
    requestSource.revision !== requestDigest &&
    requestSource.digest !== requestDigest
  )
    contradictions.push(
      `existing request source is stale: ${requestSource.id}`,
    );
  const knownSourceIds = new Set([
    ...(sources?.sources.map((item) => item.id) ?? []),
    sourceId,
    requestSourceId,
  ]);
  for (const item of [...acceptance, ...invariants])
    for (const id of item.sourceRefs)
      if (!knownSourceIds.has(id))
        contradictions.push(`source reference is unresolved: ${item.id}/${id}`);
  for (const id of product?.sourceRefs ?? [])
    if (!knownSourceIds.has(id))
      contradictions.push(`product source reference is unresolved: ${id}`);
  if (
    sources !== undefined &&
    new Set(sources.sources.map((item) => item.id)).size !==
      sources.sources.length
  )
    contradictions.push("existing source identities are duplicated");
  if (
    sources === undefined ||
    prdSource === undefined ||
    requestSource === undefined
  )
    ask(
      "source-observation",
      "Record the actual observation date and provenance for the PRD and request source entries.",
    );
  const draftSources = {
    ...(sources ?? {
      schemaVersion: "1",
      trigger: "bootstrap",
      providers: [
        {
          id: "operator-input",
          name: "Operator supplied local files",
          queries: [],
          networkDisclosure: "No network access or research performed.",
        },
      ],
    }),
    sources: [
      ...(sources?.sources ?? []),
      ...(prdSource === undefined
        ? [
            {
              id: sourceId,
              class: "user_evidence",
              uri: input.prdPath,
              revision: prdDigest,
              digest: prdDigest,
              observedAt: null,
              freshness: "unknown",
              authority: "evidence",
              claims: [
                "Narrative product input; semantic requirements need owner review.",
              ],
            },
          ]
        : []),
      ...(requestSource === undefined
        ? [
            {
              id: requestSourceId,
              class: "user_evidence",
              uri: input.requestPath,
              revision: requestDigest,
              digest: requestDigest,
              observedAt: null,
              freshness: "unknown",
              authority: "evidence",
              claims: [request.outcome.statement],
            },
          ]
        : []),
    ],
  };
  const draftProduct = {
    ...(product ?? {
      schemaVersion: "1",
      id: request.id,
      title: request.outcome.statement,
      primaryUser: request.primaryUser ?? null,
      jobToBeDone: request.jobToBeDone ?? null,
      outcomes: [],
      nonGoals: request.nonGoals ?? [],
      assumptions: [],
      unknowns: [],
      sourceRefs: [sourceId],
      decisions: [],
    }),
    outcomes: [
      ...(product?.outcomes ?? []),
      ...(existingOutcome === undefined
        ? [
            {
              ...request.outcome,
              ...(acceptanceIds.length > 0 ? { acceptanceIds } : {}),
            },
          ]
        : []),
    ],
    acceptance,
    invariants,
  };
  const productDigest = digest(draftProduct);
  const selectedScenarios =
    scenarios?.scenarios.filter((scenario) =>
      scenario.acceptanceRefs.some((id) => acceptanceIds.includes(id)),
    ) ?? [];
  const knownAcceptanceIds = new Set(acceptance.map((item) => item.id));
  const knownInvariantIds = new Set(invariants.map((item) => item.id));
  for (const scenario of scenarios?.scenarios ?? []) {
    for (const id of scenario.acceptanceRefs)
      if (!knownAcceptanceIds.has(id))
        contradictions.push(
          `existing scenario acceptance is unresolved: ${scenario.id}/${id}`,
        );
    for (const id of scenario.invariantRefs)
      if (!knownInvariantIds.has(id))
        contradictions.push(
          `existing scenario invariant is unresolved: ${scenario.id}/${id}`,
        );
  }
  for (const scenario of selectedScenarios) {
    if (scenario.acceptanceRefs.some((id) => !acceptanceIds.includes(id)))
      contradictions.push(
        `selected scenario crosses outcome acceptance scope: ${scenario.id}`,
      );
    if (scenario.oracleOwner !== request.oracleOwner)
      contradictions.push(
        `selected scenario oracle owner differs from request: ${scenario.id}`,
      );
    if (
      scenario.oracleOwner === "repository" &&
      scenario.executionRef === undefined
    )
      ask(
        `oracle:${scenario.id}`,
        `Select the actual declared repository command for ${scenario.id}; no command is inferred from its text.`,
      );
  }
  for (const id of acceptanceIds)
    if (
      !selectedScenarios.some((scenario) =>
        scenario.acceptanceRefs.includes(id),
      )
    )
      ask(
        `scenario:${id}`,
        `Prepare an independent delivered-surface scenario for ${id}, including given/when/then, preservation references and its actual oracle.`,
      );
  const draftScenarios = {
    schemaVersion: "1",
    productContractDigest: productDigest,
    scenarios: selectedScenarios,
  };
  const draftImpact = {
    schemaVersion: "1",
    id: request.id,
    productContractDigest: productDigest,
    outcomeId: request.outcome.id,
    riskClass:
      impact?.outcomeId === request.outcome.id ? impact.riskClass : null,
    acceptanceIds,
    affectedInvariantIds: [],
    uncertainInvariantIds: [],
    surfaces: [],
    scenarioIds: selectedScenarios.map((scenario) => scenario.id),
    commandIds: sortedUnique(
      selectedScenarios.flatMap((scenario) =>
        scenario.executionRef === undefined ? [] : [scenario.executionRef],
      ),
    ),
    materialDecisions: [],
    unresolved: [
      "Owner must assess change surfaces, invariant closure, risk and independent acceptance.",
    ],
    exceptions: [],
    approval: null,
  };
  const drafts: PreparationDraft[] = (
    [
      ["sources", draftSources, sourceManifestSchema],
      ["product", draftProduct, productContractSchema],
      ["scenarios", draftScenarios, scenarioSetSchema],
      ["impact", draftImpact, impactManifestSchema],
    ] as const
  ).map(([kind, content, schema]) => ({
    kind,
    path: request.inputs?.[kind] ?? inputDefaults[kind],
    authority: "draft_only",
    schemaValid: schema.safeParse(content).success,
    content,
    unresolved: questions.map((question) => question.id),
  }));
  const contextPaths = [
    {
      path: input.prdPath,
      selection: "mandatory" as const,
      bytes: Buffer.byteLength(prd),
      digest: prdDigest,
    },
    {
      path: input.requestPath,
      selection: "mandatory" as const,
      bytes: Buffer.byteLength(requestText),
      digest: requestDigest,
    },
    ...inventory
      .filter((item) => item.status !== "missing")
      .map((item) => ({
        path: item.path,
        selection: "selected" as const,
        bytes: item.bytes,
        digest: item.digest,
      })),
  ];
  const repeatedMaterial = sortedUnique(
    contextPaths.map((entry) => entry.digest),
  ).flatMap((digestValue) => {
    const entries = contextPaths.filter(
      (entry) => entry.digest === digestValue,
    );
    return entries.length > 1
      ? [
          {
            digest: digestValue,
            paths: entries.map((entry) => entry.path),
            occurrences: entries.length,
            repeatedBytes: (entries[0]?.bytes ?? 0) * (entries.length - 1),
          },
        ]
      : [];
  });
  return {
    schemaVersion: "1",
    authority: "draft_only",
    executionReady: false,
    requestId: request.id,
    outcomeId: request.outcome.id,
    prd: { path: input.prdPath, digest: prdDigest },
    request: { path: input.requestPath, digest: requestDigest },
    inventory: inventory.map(
      ({ kind, path: selectedPath, status, bytes, digest: inputDigest }) => ({
        kind,
        path: selectedPath,
        status,
        bytes,
        digest: inputDigest,
      }),
    ),
    contradictions: sortedUnique(contradictions),
    questions: questions.sort((left, right) => left.id.localeCompare(right.id)),
    missingDecisions: sortedUnique(questions.map((question) => question.id)),
    acceptanceOwnership: {
      oracleOwner: request.oracleOwner,
      preparer: request.acceptancePreparer ?? null,
      independentlyApproved: false,
    },
    drafts,
    contextDisclosure: {
      paths: contextPaths,
      totalReadBytes: contextPaths.reduce((sum, entry) => sum + entry.bytes, 0),
      repeatedMaterial,
      workerReads: "unknown",
      isReadAcl: false,
      isTokenCap: false,
      modelCalls: 0,
      limitations: [
        "Bytes describe this static preparation read only.",
        "Worker prompt framing, generated context, tokenization and subsequent reads are unknown.",
        "Priority context paths do not restrict worker filesystem reads or cap model tokens.",
      ],
    },
    nextAction:
      "Resolve the listed questions and contradictions, independently review acceptance, then review and commit exact authority through the normal planning path.",
  };
}
