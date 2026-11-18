/** Readback retains its own time budget after the authority to start an effect expires. */
export function externalEvidenceDeadlineMs(receipts) {
  return (receipts ?? []).reduce((deadline, receipt) => {
    const expiresAt = Date.parse(receipt.expiresAt);
    return Math.min(
      deadline,
      Number.isFinite(expiresAt) ? expiresAt : -Infinity,
    );
  }, Infinity);
}

/** Evaluate local evidence before a candidate crosses a promotion boundary. */
export function evaluatePromotionReadiness(input) {
  const reasonCodes = [];
  if (input.validation === undefined) reasonCodes.push("VALIDATION_MISSING");
  else {
    if (
      Date.now() >=
      externalEvidenceDeadlineMs(input.validation.externalReceipts)
    )
      reasonCodes.push("EXTERNAL_EVIDENCE_EXPIRED");
    if (!input.validation.passed) reasonCodes.push("VALIDATION_FAILED");
    if (input.validation.candidateCommit !== input.candidateCommit)
      reasonCodes.push("VALIDATION_CANDIDATE_MISMATCH");
  }
  if (input.review === undefined) reasonCodes.push("REVIEW_MISSING");
  else {
    if (input.review.candidateCommit !== input.candidateCommit)
      reasonCodes.push("REVIEW_CANDIDATE_MISMATCH");
    if (
      input.expectedScopeDigest !== undefined &&
      input.review.scopeDigest !== input.expectedScopeDigest
    )
      reasonCodes.push("REVIEW_SCOPE_MISMATCH");
    if (input.review.blockingFindingIds.length > 0)
      reasonCodes.push("BLOCKING_REVIEW_FINDINGS");
  }
  return {
    ready: reasonCodes.length === 0,
    candidateCommit: input.candidateCommit,
    reasonCodes,
  };
}
