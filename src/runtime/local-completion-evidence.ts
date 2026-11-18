import { canonicalDigest } from "../contracts/canonical.js";
import {
  localCompletionReceiptSchema,
  reviewResultSchema,
  validationEvidenceSchema,
} from "../contracts/schemas.js";
import { ExitCode, MillError } from "../errors.js";
import type { RunRecord } from "./state.js";
import type { RuntimeInputs } from "./inputs.js";
import { captureReviewScope, type CandidateIdentity } from "./repository.js";
import { blockingReviewFindings } from "./review-policy.js";

export type LocalCompletionCandidate = CandidateIdentity & { worktree: string };

function reject(code: string, message: string): never {
  throw new MillError(code, message, ExitCode.configuration);
}

/** A local completion requires review over the original approved base. */
export async function assertLocalCompletionEvidence(
  run: RunRecord,
  inputs: RuntimeInputs,
  candidate: LocalCompletionCandidate,
) {
  if (run.validationJson === undefined || run.reviewJson === undefined)
    return reject(
      "LOCAL_COMPLETION_EVIDENCE_INVALID",
      "Native validation and review evidence are required.",
    );

  const evidence = validationEvidenceSchema.parse(
    JSON.parse(run.validationJson),
  );
  const review = reviewResultSchema.parse(JSON.parse(run.reviewJson));
  const scope = await captureReviewScope(
    candidate.worktree,
    run.baseCommit,
    candidate.commit,
    {
      ...(inputs.config.review?.checklists === undefined
        ? {}
        : { checklists: inputs.config.review.checklists }),
      riskClass: inputs.task.riskClass,
    },
  );
  if (
    !evidence.passed ||
    evidence.candidateCommit !== candidate.commit ||
    review.candidateCommit !== candidate.commit ||
    review.scope?.digest !== scope.digest ||
    blockingReviewFindings(review, run.configDigest, {
      policy: inputs.config.review?.blocking,
    }).length !== 0
  )
    reject(
      "LOCAL_COMPLETION_EVIDENCE_INVALID",
      "Passing validation and a nonblocking review must match the exact candidate.",
    );
  return {
    validation: evidence,
    validationDigest: canonicalDigest(run.validationJson),
    reviewDigest: canonicalDigest(run.reviewJson),
  };
}

/** Validate a historical receipt against the retained run, irrespective of current expiry. */
export function localCompletionForRun(
  run: RunRecord,
  events: readonly Record<string, unknown>[],
) {
  const matches = events.filter(
    (event) => event.type === "run.local_completed",
  );
  if (matches.length === 0 && run.status !== "local_completed")
    return undefined;
  const event = matches[0];
  const data = event?.data;
  const parsed = localCompletionReceiptSchema.safeParse(
    typeof data === "object" && data !== null && "receipt" in data
      ? data.receipt
      : undefined,
  );
  if (parsed.success) {
    const receipt = parsed.data;
    const { plan } = receipt;
    if (
      matches.length === 1 &&
      run.status === "local_completed" &&
      run.deliveryJson === undefined &&
      run.remoteFeedbackJson === undefined &&
      run.validationJson !== undefined &&
      run.reviewJson !== undefined &&
      plan.runId === run.id &&
      plan.repositoryId === run.repositoryId &&
      plan.taskDigest === run.taskDigest &&
      plan.configDigest === run.configDigest &&
      plan.candidateCommit === run.candidateCommit &&
      plan.candidateTree === run.candidateTree &&
      canonicalDigest(run.validationJson) === plan.validationDigest &&
      canonicalDigest(run.reviewJson) === plan.reviewDigest &&
      canonicalDigest(plan) === receipt.approvalDigest &&
      Date.parse(receipt.completedAt) < Date.parse(plan.expiresAt)
    )
      return receipt;
  }
  throw new MillError(
    "LOCAL_COMPLETION_EVIDENCE_INVALID",
    "The durable local completion receipt is missing, ambiguous or bound to different evidence.",
    ExitCode.data,
  );
}
