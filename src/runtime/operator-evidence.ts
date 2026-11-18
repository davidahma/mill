import { canonicalDigest, type JsonValue } from "../contracts/canonical.js";
import { validationEvidenceSchema } from "../contracts/schemas.js";
import { MillError } from "../errors.js";
import { requiredExternalVerifierIds } from "./external-verification.js";
import {
  loadRuntimeInputs,
  type MillConfig,
  type RuntimeInputs,
} from "./inputs.js";
import {
  assertLocalCompletionEvidence,
  type LocalCompletionCandidate,
} from "./local-completion-evidence.js";
import type { RunRecord, StateStore } from "./state.js";
import {
  taskAuthorityDeadline,
  verificationDeadline,
} from "./verification-authority.js";

type ExternalEvidenceBlocker =
  | "RUN_DEADLINE_EXCEEDED"
  | "VERIFICATION_CONTROLLER_UNAVAILABLE"
  | "VERIFICATION_TASK_REQUIRED"
  | "VERIFICATION_TASK_AUTHORITY_UNAVAILABLE";

export type LocalCompletionBlocker =
  | "LOCAL_COMPLETION_EXPIRED"
  | "LOCAL_COMPLETION_TASK_REQUIRED"
  | "LOCAL_COMPLETION_TASK_AUTHORITY_UNAVAILABLE"
  | "LOCAL_COMPLETION_EVIDENCE_INVALID";

export interface OperatorEvidence {
  buildOnly: boolean;
  localCompletionBlocker?: LocalCompletionBlocker;
  external?: {
    status: "required" | "current" | "expired" | "unavailable";
    verifierIds: string[];
    expiresAt?: string;
    code?: ExternalEvidenceBlocker;
  };
  authorityChanged?: true;
}

/** Status guidance is a read-only projection of the admitted selection and persisted result. */
export async function operatorEvidence(input: {
  root: string;
  config: MillConfig;
  store: StateStore;
  run: RunRecord;
  events: readonly Record<string, unknown>[];
  assertBindings: (inputs: RuntimeInputs) => Promise<LocalCompletionCandidate>;
  taskPath?: string;
  now?: number;
}): Promise<OperatorEvidence> {
  const { run, config, events } = input;
  if (
    ![
      "committed",
      "verified",
      "reviewed",
      "proposing",
      "awaiting_ci",
      "awaiting_human",
    ].includes(run.status)
  )
    return { buildOnly: false };
  const configMatches =
    run.configDigest === canonicalDigest(config as unknown as JsonValue);
  if (!configMatches) return { buildOnly: false, authorityChanged: true };
  const buildOnly =
    config.trustCeiling === "build" && config.propose === undefined;
  const evidence: OperatorEvidence = { buildOnly };
  const creation = events.find((event) => event.type === "run.created")?.data;
  const authority =
    typeof creation === "object" && creation !== null ? creation : {};
  const storedTaskPath =
    "taskPathHint" in authority && typeof authority.taskPathHint === "string"
      ? authority.taskPathHint
      : "externalTaskPath" in authority &&
          typeof authority.externalTaskPath === "string"
        ? authority.externalTaskPath
        : undefined;
  const taskPath = input.taskPath ?? storedTaskPath;
  const loadBoundTask = async (path: string) => {
    try {
      const inputs = await loadRuntimeInputs(input.root, path);
      return { inputs, candidate: await input.assertBindings(inputs) };
    } catch {
      return undefined;
    }
  };
  if (run.status === "reviewed" && buildOnly) {
    const originalDeadline = Date.parse(run.deadlineAt);
    if (
      !Number.isFinite(originalDeadline) ||
      originalDeadline <= (input.now ?? Date.now())
    ) {
      evidence.localCompletionBlocker = "LOCAL_COMPLETION_EXPIRED";
    } else if (taskPath === undefined) {
      evidence.localCompletionBlocker = "LOCAL_COMPLETION_TASK_REQUIRED";
    } else {
      const bound = await loadBoundTask(taskPath);
      if (bound === undefined) {
        evidence.localCompletionBlocker =
          "LOCAL_COMPLETION_TASK_AUTHORITY_UNAVAILABLE";
      } else if (
        run.deliveryJson !== undefined ||
        run.remoteFeedbackJson !== undefined
      ) {
        evidence.localCompletionBlocker = "LOCAL_COMPLETION_EVIDENCE_INVALID";
      } else {
        try {
          await assertLocalCompletionEvidence(
            run,
            bound.inputs,
            bound.candidate,
          );
          if (
            Math.min(originalDeadline, taskAuthorityDeadline(bound.inputs)) <=
            (input.now ?? Date.now())
          )
            evidence.localCompletionBlocker = "LOCAL_COMPLETION_EXPIRED";
        } catch {
          evidence.localCompletionBlocker = "LOCAL_COMPLETION_EVIDENCE_INVALID";
        }
      }
    }
  }
  if (run.status === "committed") {
    const selected =
      "externalVerifierIds" in authority &&
      Array.isArray(authority.externalVerifierIds)
        ? authority.externalVerifierIds.filter(
            (id): id is string =>
              typeof id === "string" &&
              Object.hasOwn(config.externalVerifiers ?? {}, id),
          )
        : [];
    const waiting = async (
      taskPath: string | undefined,
    ): Promise<OperatorEvidence> => {
      const unavailable = (
        code: ExternalEvidenceBlocker,
      ): OperatorEvidence => ({
        buildOnly,
        external: {
          status: "unavailable",
          verifierIds: [...new Set(selected)].sort(),
          code,
        },
      });
      if (taskPath === undefined)
        return unavailable("VERIFICATION_TASK_REQUIRED");
      const bound = await loadBoundTask(taskPath);
      if (bound === undefined)
        return unavailable("VERIFICATION_TASK_AUTHORITY_UNAVAILABLE");
      const { inputs } = bound;
      const verifierIds = [...requiredExternalVerifierIds(inputs)].sort();
      if (verifierIds.length === 0) return { buildOnly };
      try {
        const deadline = Math.min(
          await verificationDeadline(input.root, input.store, run, input.now),
          taskAuthorityDeadline(inputs),
        );
        if (deadline <= (input.now ?? Date.now()))
          return unavailable("VERIFICATION_TASK_AUTHORITY_UNAVAILABLE");
        return {
          ...evidence,
          external: {
            status: "required",
            verifierIds,
            expiresAt: new Date(deadline).toISOString(),
          },
        };
      } catch (error) {
        return unavailable(
          error instanceof MillError && error.code === "RUN_DEADLINE_EXCEEDED"
            ? "RUN_DEADLINE_EXCEEDED"
            : "VERIFICATION_CONTROLLER_UNAVAILABLE",
        );
      }
    };
    if (
      ("externalTaskPath" in authority && storedTaskPath !== undefined) ||
      selected.length > 0 ||
      (input.taskPath !== undefined &&
        config.externalVerifiers !== undefined) ||
      events.some(
        (event) => event.type === "verification.external_import_blocked",
      )
    )
      return waiting(taskPath);
  }
  if (run.validationJson !== undefined) {
    try {
      const validation = validationEvidenceSchema.parse(
        JSON.parse(run.validationJson),
      );
      const receipts = validation.externalReceipts ?? [];
      if (receipts.length > 0) {
        const expiry = Math.min(
          ...receipts.map((receipt) => Date.parse(receipt.expiresAt)),
        );
        return {
          ...evidence,
          external: {
            status: expiry <= (input.now ?? Date.now()) ? "expired" : "current",
            verifierIds: receipts.map((item) => item.verifierId).sort(),
            expiresAt: new Date(expiry).toISOString(),
          },
        };
      }
    } catch {
      return { ...evidence, authorityChanged: true };
    }
  }
  return evidence;
}
