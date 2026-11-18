import { controllerArtifactDigest } from "../config/controller-artifact.js";
import { enforceExactVersion, readLockStatus } from "../config/lock.js";
import { canonicalDigest } from "../contracts/canonical.js";
import { ExitCode, MillError } from "../errors.js";
import { safeReadText } from "../security/safe-path.js";
import { MILL_VERSION } from "../version.js";
import { readCommittedFile } from "./repository.js";
import { assertExternalEvidenceFresh } from "./external-verification.js";
import type { RuntimeInputs } from "./inputs.js";
import type { RunRecord, StateStore } from "./state.js";
import { recoveryError } from "./verification-recovery.js";

export function persistedRunDeadline(run: RunRecord, now = Date.now()): number {
  const deadline = Date.parse(run.deadlineAt);
  if (!Number.isSafeInteger(deadline) || deadline <= now) {
    throw new MillError(
      "RUN_DEADLINE_EXCEEDED",
      "The approved run deadline has elapsed; a fresh qualification and run are required.",
      ExitCode.temporary,
      { deadlineAt: run.deadlineAt },
    );
  }
  return deadline;
}

export function taskAuthorityDeadline(inputs: RuntimeInputs): number {
  return Math.min(
    Infinity,
    ...(inputs.continuity?.impact.exceptions ?? []).map((item) =>
      Date.parse(item.expiresAt),
    ),
    ...(inputs.task.schemaVersion === "2" ? inputs.task.attestations : []).map(
      (item) => Date.parse(item.expiresAt),
    ),
    ...(inputs.adaptation === undefined
      ? []
      : [Date.parse(inputs.adaptation.manifest.fixtures.expiresAt)]),
  );
}

export function currentVerificationDeadline(
  run: RunRecord,
  recoveryExpiresAt: string | undefined,
  now = Date.now(),
): number {
  if (recoveryExpiresAt === undefined) return persistedRunDeadline(run, now);
  const expiry = Date.parse(recoveryExpiresAt);
  if (!Number.isSafeInteger(expiry) || expiry <= now)
    recoveryError("The fixed recovery allowance expired.");
  return expiry;
}

export interface ReviewWindow {
  verificationDeadlineMs: number;
  taskAuthorityDeadlineMs: number;
  receiptDeadlineMs: number;
}

export function reviewWindowDeadline(window: ReviewWindow): number {
  return Math.min(
    window.verificationDeadlineMs,
    window.taskAuthorityDeadlineMs,
    window.receiptDeadlineMs,
  );
}

export function assertReviewWindow(
  input: ReviewWindow & {
    run: RunRecord;
    recoveryExpiresAt: string | undefined;
  },
): void {
  assertExternalEvidenceFresh(input.receiptDeadlineMs);
  const now = Date.now();
  if (
    currentVerificationDeadline(input.run, input.recoveryExpiresAt, now) !==
    input.verificationDeadlineMs
  )
    throw new MillError(
      "REVIEW_REFRESH_UNAVAILABLE",
      "Verification authority changed during review preparation or execution.",
      ExitCode.configuration,
    );
  if (now >= input.taskAuthorityDeadlineMs)
    throw new MillError(
      "CONTINUITY_AUTHORITY_BLOCKED",
      "Task, impact, or adaptation authority expired during review preparation or execution.",
      ExitCode.configuration,
    );
}

export async function recoveryLock(
  root: string,
  candidateCommit: string,
): Promise<{ pinnedVersion: string; lockDigest: string }> {
  const lock = await readLockStatus(root);
  if (!lock.found || lock.requiredVersion === undefined)
    recoveryError("Recovery requires the original committed mill.lock.");
  let committed: string;
  try {
    committed = await readCommittedFile(
      root,
      candidateCommit,
      "mill.lock",
      256 * 1024,
    );
  } catch {
    recoveryError("The immutable candidate lock cannot be read.");
  }
  const source = await safeReadText(root, "mill.lock", 256 * 1024);
  if (source !== committed)
    recoveryError(
      "The invoking checkout's pin differs from the immutable candidate lock.",
    );
  return {
    pinnedVersion: lock.requiredVersion,
    lockDigest: canonicalDigest(committed),
  };
}

export async function verificationDeadline(
  root: string,
  store: StateStore,
  run: RunRecord,
  now?: number,
): Promise<number> {
  const receipt = store.verificationRecovery(run.id);
  if (receipt === undefined) {
    await enforceExactVersion(root);
    return currentVerificationDeadline(run, undefined, now);
  }
  const lock = await recoveryLock(root, receipt.candidateCommit);
  if (
    receipt.controllerVersion !== MILL_VERSION ||
    (receipt.controllerDigest !== undefined &&
      receipt.controllerDigest !== (await controllerArtifactDigest())) ||
    receipt.lockDigest !== lock.lockDigest ||
    receipt.pinnedVersion !== lock.pinnedVersion
  )
    recoveryError("Recovery controller or original pin changed.");
  return currentVerificationDeadline(run, receipt.expiresAt, now);
}
