import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { buildContextManifest } from "../runtime/context.js";
import { StateStore } from "../runtime/state.js";
import { summarizeUsage } from "../runtime/usage.js";
import { commonGitDirectory } from "../runtime/repository.js";
import { loadRuntimeInputs } from "../runtime/inputs.js";
import { readCandidateIdentity } from "../runtime/repository.js";
import { findTrustedExecutable } from "../doctor.js";
import { runProcess } from "../runtime/process.js";
import { ExitCode, MillError } from "../errors.js";
import { safeReadText } from "../security/safe-path.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const minutes = z.number().nonnegative().nullable();
const version = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/u,
  );
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

export const changeEvidenceSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  changeId: identifier,
  measurements: z
    .array(
      z.strictObject({
        id: identifier,
        kind: z.enum(["preparation", "run", "native"]),
        evidenceDigest: digest,
        candidateCommit: sha,
        runId: z.uuid().optional(),
        sessionId: identifier.optional(),
        source: z.enum(["measured", "unavailable"]),
        inputTokens: count.nullable(),
        outputTokens: count.nullable(),
        cacheInputTokens: count.nullable(),
      }),
    )
    .max(1000),
  effort: z.strictObject({
    preparationMinutes: minutes,
    reviewMinutes: minutes,
    repairMinutes: minutes,
  }),
  hostedRequests: count.nullable(),
});

export const consumptionManifestSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  ownerRepository: repository,
  consumerRepository: repository,
  version,
  sourceRevision: sha,
  platform: z.string().regex(/^(?:linux|darwin|windows)\/(?:amd64|arm64)$/u),
  artifact: z.strictObject({
    manifestDigest: digest,
    imageConfigDigest: digest,
    archiveSha256: digest,
  }),
  rollback: z.strictObject({ version, artifactDigest: digest }),
  transitions: z.strictObject({
    sourceReviewed: z.enum(["recorded", "pending"]),
    artifactQualified: z.enum(["recorded", "pending"]),
    pinAdopted: z.enum(["recorded", "pending"]),
    customerQualified: z.enum(["recorded", "pending", "not_run"]),
  }),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new MillError(
      code,
      "The operator evidence does not satisfy its contract.",
      ExitCode.data,
    );
  return result.data;
}

export function summarizeChangeEvidence(value: unknown) {
  const input = parse(changeEvidenceSchema, value, "CHANGE_EVIDENCE_INVALID");
  const ids = new Set<string>();
  const receipts = new Set<string>();
  const cumulativeIdentities = new Set<string>();
  for (const item of input.measurements) {
    const bindings = [
      ...(item.runId === undefined ? [] : [`run:${item.runId}`]),
      ...(item.sessionId === undefined ? [] : [`session:${item.sessionId}`]),
    ];
    if (
      ids.has(item.id) ||
      receipts.has(item.evidenceDigest) ||
      bindings.some((binding) => cumulativeIdentities.has(binding))
    )
      throw new MillError(
        "CHANGE_EVIDENCE_DUPLICATE",
        "One measurement or receipt was counted more than once.",
        ExitCode.data,
      );
    ids.add(item.id);
    receipts.add(item.evidenceDigest);
    for (const binding of bindings) cumulativeIdentities.add(binding);
    const measured = item.inputTokens !== null && item.outputTokens !== null;
    if (
      (item.source === "measured") !== measured ||
      (item.source === "unavailable" &&
        (item.inputTokens !== null ||
          item.outputTokens !== null ||
          item.cacheInputTokens !== null)) ||
      (item.cacheInputTokens !== null &&
        item.cacheInputTokens > (item.inputTokens ?? 0))
    ) {
      throw new MillError(
        "CHANGE_EVIDENCE_MEASUREMENT_INVALID",
        "Measured usage needs complete counts; unavailable usage cannot be zero-filled.",
        ExitCode.data,
      );
    }
  }
  const measured = input.measurements.filter(
    (item) => item.source === "measured",
  );
  const complete =
    measured.length === input.measurements.length && measured.length > 0;
  const inputTokens = measured.reduce(
    (total, item) => total + (item.inputTokens ?? 0),
    0,
  );
  const outputTokens = measured.reduce(
    (total, item) => total + (item.outputTokens ?? 0),
    0,
  );
  if (!Number.isSafeInteger(inputTokens + outputTokens))
    throw new MillError(
      "CHANGE_EVIDENCE_MEASUREMENT_INVALID",
      "Aggregate usage exceeds exact integer precision.",
      ExitCode.data,
    );
  const cacheComplete =
    complete && measured.every((item) => item.cacheInputTokens !== null);
  return {
    schemaVersion: "1" as const,
    changeId: input.changeId,
    authority: "maintainer_declared" as const,
    authenticated: false,
    references: input.measurements.map((item) => ({
      id: item.id,
      kind: item.kind,
      evidenceDigest: item.evidenceDigest,
      candidateCommit: item.candidateCommit,
      runId: item.runId ?? null,
      sessionId: item.sessionId ?? null,
      source: item.source,
    })),
    usage: {
      source:
        measured.length === 0
          ? "unavailable"
          : complete
            ? "measured"
            : "partial",
      inputTokens: complete ? inputTokens : null,
      outputTokens: complete ? outputTokens : null,
      cacheInputTokens: cacheComplete
        ? measured.reduce(
            (total, item) => total + (item.cacheInputTokens ?? 0),
            0,
          )
        : null,
      totalTokens: complete ? inputTokens + outputTokens : null,
      measuredTotalTokens:
        measured.length === 0 ? null : inputTokens + outputTokens,
      cost: "unavailable" as const,
    },
    effort: input.effort,
    hostedRequests: input.hostedRequests,
    hostedUsage: "unavailable" as const,
  };
}

export function assessConsumption(value: unknown) {
  const input = parse(
    consumptionManifestSchema,
    value,
    "CONSUMPTION_MANIFEST_INVALID",
  );
  if (
    input.ownerRepository.toLowerCase() ===
    input.consumerRepository.toLowerCase()
  )
    throw new MillError(
      "CONSUMPTION_OWNER_CONFLICT",
      "Runtime ownership and private consumption must be separate repositories.",
      ExitCode.data,
    );
  if (input.rollback.version === input.version)
    throw new MillError(
      "CONSUMPTION_ROLLBACK_CONFLICT",
      "The preceding rollback release must have a different immutable version.",
      ExitCode.data,
    );
  return {
    ...input,
    formatValid: true,
    authenticated: false,
    authority: "consumer_declared" as const,
    customerCompatibility: "not_established" as const,
  };
}

export async function loadOperatorManifest(
  root: string,
  file: string,
  kind: "change" | "consumption",
) {
  let value: unknown;
  try {
    value = parseYaml(await safeReadText(root, file, 2 * 1024 * 1024));
  } catch (error) {
    if (error instanceof MillError) throw error;
    throw new MillError(
      "OPERATOR_MANIFEST_INVALID",
      "The operator manifest is not valid YAML or JSON.",
      ExitCode.data,
    );
  }
  return kind === "change"
    ? summarizeChangeEvidence(value)
    : assessConsumption(value);
}

function exactPriorTokens(
  usage: ReturnType<typeof summarizeUsage> | null,
): number | null {
  if (usage === null) return null;
  const tokens = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheInputTokens,
  ];
  const sum =
    usage.inputTokens === null || usage.outputTokens === null
      ? null
      : usage.inputTokens + usage.outputTokens;
  if (
    tokens.some(
      (value) => value !== null && (!Number.isSafeInteger(value) || value < 0),
    ) ||
    (sum !== null && !Number.isSafeInteger(sum))
  ) {
    throw new MillError(
      "READINESS_USAGE_INVALID",
      "Prior usage exceeds exact integer precision.",
      ExitCode.data,
    );
  }
  if (usage.source === "measured") return sum;
  // Legacy settlements may have usage without worker.admitted events. Only an
  // exact run with no admission or settlement at all proves zero spend.
  const phases = usage.phases;
  if (phases === undefined) return null;
  const calls = Object.values(phases).reduce(
    (total, phase) => total + phase.calls,
    0,
  );
  return usage.admittedCalls === 0 && calls === 0 ? 0 : null;
}

/** Static task disclosure; only the explicit attended option executes host image inspection. */
export async function taskReadiness(input: {
  root: string;
  taskPath: string;
  probeVerifier?: boolean;
  attended?: boolean;
  runId?: string;
}) {
  if (input.probeVerifier === true && input.attended !== true)
    throw new MillError(
      "ATTENDANCE_REQUIRED",
      "Verifier probing requires explicit attendance; it never pulls an image.",
      ExitCode.configuration,
    );
  const inputs = await loadRuntimeInputs(input.root, input.taskPath);
  const identity = await readCandidateIdentity(input.root);
  const { manifest } = await buildContextManifest(
    input.root,
    identity.commit,
    inputs.task,
    inputs.config,
    inputs.taskDigest,
  );
  const files = await Promise.all(
    manifest.included.map(async (file) => ({
      ...file,
      bytes: Buffer.byteLength(
        await safeReadText(input.root, file.path, 2 * 1024 * 1024),
        "utf8",
      ),
      mandatory: Object.values(inputs.task.authority).some(
        (authority) => authority?.path === file.path,
      ),
    })),
  );
  let verifierStatus:
    "not_configured" | "not_probed" | "present" | "unavailable" =
    inputs.config.verifier === undefined ? "not_configured" : "not_probed";
  if (input.probeVerifier === true && inputs.config.verifier !== undefined) {
    const docker = await findTrustedExecutable("docker", input.root);
    if (docker === undefined) verifierStatus = "unavailable";
    else {
      const probe = await runProcess({
        executable: docker,
        args: ["image", "inspect", inputs.config.verifier.image],
        cwd: input.root,
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          LANG: "C",
          LC_ALL: "C",
        },
        deadlineMs: Date.now() + 10_000,
        maxOutputBytes: 256 * 1024,
      });
      verifierStatus =
        probe.exitCode === 0 && !probe.timedOut && !probe.outputExceeded
          ? "present"
          : "unavailable";
    }
  }
  let priorUsage: ReturnType<typeof summarizeUsage> | null = null;
  if (input.runId !== undefined) {
    const store = await StateStore.openReadOnly(
      inputs.config.repositoryId,
      await commonGitDirectory(input.root),
    );
    try {
      const snapshot = store?.runEventSnapshot(input.runId);
      if (
        snapshot?.run?.taskDigest !== inputs.taskDigest ||
        snapshot.run.configDigest !== inputs.configDigest
      )
        throw new MillError(
          "READINESS_RUN_MISMATCH",
          "Prior spend must belong to this exact task and configuration.",
          ExitCode.data,
        );
      priorUsage = summarizeUsage(snapshot.events);
    } finally {
      store?.close();
    }
  }
  const priorTokens = exactPriorTokens(priorUsage);
  return {
    schemaVersion: "1" as const,
    authority: "read_only_preflight" as const,
    qualified: false,
    taskId: inputs.task.id,
    baseCommit: identity.commit,
    taskDigest: inputs.taskDigest,
    configDigest: inputs.configDigest,
    commands: inputs.task.commandIds.map((id) => ({
      id,
      required: inputs.config.commands[id]?.required ?? false,
      controlPaths: inputs.config.commands[id]?.controlPaths ?? [],
      execution: inputs.config.commands[id]?.execution ?? "unknown",
    })),
    verifier: {
      image: inputs.config.verifier?.image ?? null,
      status: verifierStatus,
      network: inputs.config.verifier?.network ?? null,
      baselineRequired: true,
      implicitPull: false,
    },
    delivery: {
      trustCeiling: inputs.config.trustCeiling,
      reviewPolicy:
        inputs.config.propose?.reviewPolicy.mode ?? "not_configured",
      hostedReviewAvailability: "unknown" as const,
      requiredChecks: inputs.config.propose?.requiredChecks ?? [],
      policyFrozenAtAdmission: true,
    },
    context: {
      files,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      maxBytes: inputs.task.budget.maxContextBytes ?? 8 * 1024 * 1024,
      selectedPlaybooks: manifest.playbooks ?? null,
      duplicatePathsRemoved:
        inputs.task.contextPaths.length -
        new Set(inputs.task.contextPaths).size,
      workerReads: "unavailable" as const,
      filesystemAcl: false,
      tokenEstimate: "unavailable" as const,
    },
    spend: {
      maxModelTokens: inputs.task.budget.maxModelTokens ?? null,
      priorUsage,
      remainingModelTokens:
        inputs.task.budget.maxModelTokens === undefined || priorTokens === null
          ? null
          : Math.max(0, inputs.task.budget.maxModelTokens - priorTokens),
      hardInflightCap: false,
    },
  };
}
