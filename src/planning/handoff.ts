import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  deliveryRecordSchema,
  reviewResultSchema,
} from "../contracts/schemas.js";
import { canonicalDigest, type JsonValue } from "../contracts/canonical.js";
import { ExitCode, MillError } from "../errors.js";
import { safeReadText } from "../security/safe-path.js";
import { continuationPacket } from "../runtime/continuation.js";
import { externalEffectBoundary } from "../runtime/effect-boundary.js";
import { loadMillConfig } from "../runtime/inputs.js";
import { hasPendingOciResources } from "../runtime/oci-resources.js";
import { operatorEvidence } from "../runtime/operator-evidence.js";
import { assertRunBindings } from "../runtime/lifecycle.js";
import { projectRunOutcome } from "../runtime/outcome.js";
import { processIdentityStatus } from "../runtime/process.js";
import { commonGitDirectory } from "../runtime/repository.js";
import {
  StateStore,
  isTerminalRun,
  publicRunRecord,
} from "../runtime/state.js";
import { projectRunTimeline } from "../runtime/timeline.js";
import { summarizeUsage } from "../runtime/usage.js";
import { blockingReviewFindings } from "../runtime/review-policy.js";
import { checkDecision } from "../runtime/delivery.js";
import type { GitHubCheck } from "../runtime/github.js";

const dispositionSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  candidateCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  candidateTree: z.string().regex(/^[a-f0-9]{40}$/u),
  actor: z.string().regex(/^[A-Za-z0-9-]+$/u),
  route: z.enum(["native_owner", "not_accepted"]),
  reason: z.string().min(1).max(1000),
  evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
const recordedReviewsSchema = z.array(
  z.object({
    actorLogin: z.string(),
    state: z.string(),
    commitId: z.string().nullable(),
  }),
);
const recordedChecksSchema = z.array(
  z.object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    appId: z.number().int().optional(),
    headSha: z.string().optional(),
    workflowPath: z.string().optional(),
    event: z.string().optional(),
  }),
);

function recordedChecks(value: unknown): GitHubCheck[] | undefined {
  const parsed = recordedChecksSchema.safeParse(value);
  return parsed.success
    ? parsed.data.map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        ...(check.appId === undefined ? {} : { appId: check.appId }),
        ...(check.headSha === undefined ? {} : { headSha: check.headSha }),
        ...(check.workflowPath === undefined
          ? {}
          : { workflowPath: check.workflowPath }),
        ...(check.event === undefined ? {} : { event: check.event }),
      }))
    : undefined;
}

/** One consistent state/event snapshot; derived diagnostics grant no mutation authority. */
export async function operatorHandoff(input: {
  root: string;
  runId?: string;
  taskPath?: string;
  ownerDispositionPath?: string;
  now?: number;
}) {
  const config = await loadMillConfig(input.root);
  const store = await StateStore.openReadOnly(
    config.repositoryId,
    await commonGitDirectory(input.root),
  );
  if (store === undefined)
    return {
      schemaVersion: "1",
      recorded: false as const,
      authority: "read_only",
    };
  try {
    const snapshot = store.runEventSnapshot(input.runId);
    const run = snapshot.run;
    if (run === undefined)
      return {
        schemaVersion: "1",
        recorded: false as const,
        authority: "read_only",
      };
    const usage = summarizeUsage(snapshot.events);
    const publicRun = publicRunRecord(run);
    const timeline = projectRunTimeline({
      run: publicRun,
      events: snapshot.events,
    });
    const outcome = projectRunOutcome({
      run,
      timeline,
      events: snapshot.events,
      usage,
    });
    let boundary: ReturnType<typeof externalEffectBoundary>;
    try {
      boundary = externalEffectBoundary(run);
    } catch {
      boundary = { journalUnresolved: true, unresolved: true, merged: false };
    }
    const active =
      run.activeProcessId !== undefined &&
      run.activePid !== undefined &&
      run.activeProcessGroup !== undefined &&
      run.activeProcessIdentity !== undefined
        ? {
            id: run.activeProcessId,
            pid: run.activePid,
            processGroup: run.activeProcessGroup,
            identity: run.activeProcessIdentity,
          }
        : undefined;
    const activeRecorded = [
      run.activeProcessId,
      run.activePid,
      run.activeProcessGroup,
      run.activeProcessIdentity,
    ].some((value) => value !== undefined);
    const observation =
      active === undefined
        ? activeRecorded
          ? "unknown"
          : "not_observed"
        : processIdentityStatus(active);
    const pendingWorkers =
      store.unresolvedMutatingWorkerInvocations(run.id).length > 0;
    let pendingOci: boolean;
    try {
      pendingOci = await hasPendingOciResources(store.directory);
    } catch {
      pendingOci = true;
    }
    const reconciliationRequired =
      boundary.unresolved ||
      pendingWorkers ||
      pendingOci ||
      observation === "unknown";
    const continuation = continuationPacket({
      run: publicRun,
      usage,
      interrupted: observation === "mismatch",
      reconciliationRequired,
      mergeFinalizationRequired: boundary.merged,
      activeWorker: observation === "match" || observation === "unknown",
      evidence: await operatorEvidence({
        root: input.root,
        config,
        store,
        run,
        events: snapshot.events,
        assertBindings: (inputs) => assertRunBindings(input.root, run, inputs),
        ...(input.taskPath === undefined ? {} : { taskPath: input.taskPath }),
        ...(input.now === undefined ? {} : { now: input.now }),
      }),
    });
    const blockers = new Set(
      outcome.integrity.reasons.map((reason) => reason.code),
    );
    if (run.blockCode !== undefined) blockers.add(run.blockCode);
    if (continuation.externalEvidence?.status === "expired")
      blockers.add("EXTERNAL_EVIDENCE_EXPIRED");
    if (continuation.externalEvidence?.code !== undefined)
      blockers.add(continuation.externalEvidence.code);
    if (continuation.next.code !== undefined)
      blockers.add(continuation.next.code);
    if (reconciliationRequired) blockers.add("RECONCILIATION_REQUIRED");
    if (boundary.unresolved) blockers.add("GITHUB_RECONCILIATION_REQUIRED");
    if (pendingWorkers)
      blockers.add("WORKER_INVOCATION_RECONCILIATION_REQUIRED");
    if (pendingOci) blockers.add("OCI_RECONCILIATION_REQUIRED");
    if (observation === "unknown") blockers.add("PROCESS_IDENTITY_UNKNOWN");
    if (
      outcome.validation.status === "failed" ||
      outcome.validation.status === "blocked"
    )
      blockers.add("VALIDATION_NOT_PASSED");
    let localReviewPolicy: "p0_p1" | undefined;
    if (run.reviewJson !== undefined) {
      try {
        const review = reviewResultSchema.parse(JSON.parse(run.reviewJson));
        localReviewPolicy = review.gate?.policy;
        if (blockingReviewFindings(review, run.configDigest).length > 0)
          blockers.add("LOCAL_REVIEW_FINDINGS");
      } catch {
        blockers.add("LOCAL_REVIEW_EVIDENCE_INVALID");
      }
    }
    let remote: {
      evidence: "not_recorded" | "recorded_snapshot";
      checks: string;
      hostedReview: string;
      actionableFindings: number | null;
      liveApproval: false;
    } = {
      evidence: "not_recorded",
      checks: "unknown",
      hostedReview: "unknown",
      actionableFindings: null,
      liveApproval: false,
    };
    if (run.deliveryJson !== undefined) {
      const parsed = (() => {
        try {
          return deliveryRecordSchema.safeParse(JSON.parse(run.deliveryJson));
        } catch {
          return undefined;
        }
      })();
      const delivery = parsed?.success === true ? parsed.data : undefined;
      if (delivery === undefined) blockers.add("REMOTE_EVIDENCE_INVALID");
      else {
        const data = delivery.observation;
        if (data !== null) {
          const decision = data.checkDecision;
          let checks =
            typeof decision === "object" &&
            decision !== null &&
            "status" in decision &&
            typeof decision.status === "string"
              ? decision.status
              : "unknown";
          if (delivery.merge !== null) {
            const mergeChecks = recordedChecks(data.mergeChecks);
            const required =
              delivery.postMergeRequiredChecks ?? delivery.requiredChecks;
            const matches =
              delivery.merge.tree === run.candidateTree &&
              mergeChecks?.every(
                (check) =>
                  !required.includes(check.name) ||
                  check.headSha === undefined ||
                  check.headSha === delivery.merge?.commit,
              ) === true;
            if (!matches) blockers.add("REMOTE_SNAPSHOT_STALE");
            checks =
              mergeChecks === undefined || !matches
                ? "unknown"
                : checkDecision(
                    required,
                    mergeChecks,
                    delivery.checkProducers,
                    "push",
                    delivery.merge.commit,
                  ).status;
          } else if (data.headSha !== run.candidateCommit)
            blockers.add("REMOTE_SNAPSHOT_STALE");
          if (checks !== "passed") blockers.add("REQUIRED_CHECKS_NOT_PASSED");
          const reviews = recordedReviewsSchema.safeParse(data.reviews);
          const completed =
            delivery.reviewPolicy.mode === "local_only" ||
            (reviews.success &&
              delivery.reviewPolicy.requiredReviewerLogins.every((actor) => {
                const latest = reviews.data
                  .filter(
                    (review) =>
                      review.actorLogin === actor &&
                      typeof review.state === "string" &&
                      (delivery.reviewPolicy.mode === "github_codex_required"
                        ? review.state.startsWith("CODEX_")
                        : !review.state.startsWith("CODEX_")),
                  )
                  .at(-1);
                return (
                  latest !== undefined &&
                  latest.commitId === run.candidateCommit &&
                  latest.state ===
                    (delivery.reviewPolicy.mode === "github_codex_required"
                      ? "CODEX_COMPLETED"
                      : "APPROVED")
                );
              }));
          if (!completed) blockers.add("REMOTE_REVIEW_NOT_COMPLETED");
          remote = {
            evidence: "recorded_snapshot",
            checks,
            hostedReview: completed ? "completed" : "not_completed",
            actionableFindings: null,
            liveApproval: false,
          };
        } else if (
          [
            "awaiting_ci",
            "awaiting_human",
            "merged",
            "post_merge_verified",
            "closed",
          ].includes(delivery.state)
        ) {
          blockers.add("REMOTE_OBSERVATION_MISSING");
        }
      }
    }
    if (run.remoteFeedbackJson !== undefined) {
      try {
        const feedback = reviewResultSchema.parse(
          JSON.parse(run.remoteFeedbackJson),
        );
        if (
          feedback.candidateCommit !== run.candidateCommit ||
          (feedback.scope !== undefined &&
            (feedback.scope.candidateCommit !== run.candidateCommit ||
              feedback.scope.candidateTree !== run.candidateTree))
        )
          blockers.add("REMOTE_FEEDBACK_STALE");
        else {
          const count = blockingReviewFindings(feedback, run.configDigest, {
            policy: localReviewPolicy,
          }).length;
          remote.actionableFindings = count;
          if (count > 0) blockers.add("REMOTE_REVIEW_FINDINGS");
        }
      } catch {
        blockers.add("REMOTE_FEEDBACK_INVALID");
      }
    }
    let ownerDisposition:
      | { recorded: false }
      | {
          recorded: true;
          authenticated: false;
          route: "native_owner" | "not_accepted";
          candidateCommit: string;
          evidenceDigest: string;
        } = { recorded: false };
    if (input.ownerDispositionPath !== undefined) {
      let source: unknown;
      const text = await safeReadText(
        input.root,
        input.ownerDispositionPath,
        64 * 1024,
      );
      try {
        source = parseYaml(text);
      } catch {
        throw new MillError(
          "OWNER_DISPOSITION_INVALID",
          "Separate owner disposition is not valid YAML or JSON.",
          ExitCode.data,
        );
      }
      const disposition = dispositionSchema.safeParse(source);
      if (
        !disposition.success ||
        disposition.data.candidateCommit !== run.candidateCommit ||
        disposition.data.candidateTree !== run.candidateTree ||
        !isTerminalRun(run.status)
      )
        throw new MillError(
          "OWNER_DISPOSITION_INVALID",
          "Separate owner disposition needs the exact terminal candidate and tree.",
          ExitCode.data,
        );
      ownerDisposition = {
        recorded: true,
        authenticated: false,
        route: disposition.data.route,
        candidateCommit: disposition.data.candidateCommit,
        evidenceDigest: disposition.data.evidenceDigest,
      };
    }
    const next =
      blockers.size > 0 &&
      ![
        "none",
        "wait",
        "reconcile",
        "observe_draft_pr",
        "finalize_merge",
        "external_evidence_expired",
      ].includes(continuation.next.action) &&
      continuation.externalEvidence?.status !== "unavailable" &&
      continuation.next.code === undefined
        ? {
            action: "attended_disposition" as const,
            reason:
              "Recorded blockers prevent advancing this candidate; inspect retained evidence and resolve them through the attended lifecycle.",
            attended: true as const,
          }
        : continuation.next;
    const last = timeline.events.at(-1);
    const now = input.now ?? Date.now();
    const elapsed =
      last === undefined ? NaN : now - Date.parse(last.occurredAt);
    return {
      schemaVersion: "1",
      recorded: true as const,
      authority: "read_only",
      snapshotDigest: canonicalDigest({
        run: outcome.run,
        events: timeline.events,
      } as unknown as JsonValue),
      run: outcome.run,
      integrity: outcome.integrity,
      validation: outcome.validation.status,
      review: outcome.review.status,
      remote,
      blockers: [...blockers].sort(),
      next,
      ...(continuation.externalEvidence === undefined
        ? {}
        : { externalEvidence: continuation.externalEvidence }),
      ...(outcome.localCompletion === undefined
        ? {}
        : { localCompletion: outcome.localCompletion }),
      progress: {
        lastEvent: last?.type ?? null,
        lastEventAt: last?.occurredAt ?? null,
        silenceMilliseconds:
          Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
        evidence:
          observation === "match"
            ? "process_observed"
            : observation === "unknown"
              ? "unknown"
              : "no_active_process_observed",
        completed: isTerminalRun(run.status),
        silenceProvesStall: false,
      },
      usage,
      ownerDisposition,
      millClosed: run.status === "closed",
      ownerAcceptance: "not_recorded",
    };
  } finally {
    store.close();
  }
}
