export type PromotionReadinessCode =
  | "EXTERNAL_EVIDENCE_EXPIRED"
  | "VALIDATION_MISSING"
  | "VALIDATION_FAILED"
  | "VALIDATION_CANDIDATE_MISMATCH"
  | "REVIEW_MISSING"
  | "REVIEW_CANDIDATE_MISMATCH"
  | "REVIEW_SCOPE_MISMATCH"
  | "BLOCKING_REVIEW_FINDINGS";

export interface PromotionReadiness {
  ready: boolean;
  candidateCommit: string;
  reasonCodes: PromotionReadinessCode[];
}

export function externalEvidenceDeadlineMs(
  receipts?: readonly { expiresAt: string }[],
): number;

export function evaluatePromotionReadiness(input: {
  candidateCommit: string;
  validation?: {
    passed: boolean;
    candidateCommit: string;
    externalReceipts?: readonly { expiresAt: string }[] | undefined;
  };
  review?: {
    candidateCommit: string;
    scopeDigest?: string;
    blockingFindingIds: readonly string[];
  };
  expectedScopeDigest?: string;
}): PromotionReadiness;
