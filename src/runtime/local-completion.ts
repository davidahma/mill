import { enforceExactVersion } from "../config/lock.js";
import { canonicalDigest } from "../contracts/canonical.js";
import { localCompletionPlanSchema } from "../contracts/schemas.js";
import { ExitCode, MillError } from "../errors.js";
import { assertEffectAllowsNewWork } from "./effect-boundary.js";
import { loadRuntimeInputs, type RuntimeInputs } from "./inputs.js";
import { assertRunBindings } from "./lifecycle.js";
import {
  assertLocalCompletionEvidence,
  localCompletionForRun,
} from "./local-completion-evidence.js";
import { hasPendingOciResources } from "./oci-resources.js";
import { commonGitDirectory } from "./repository.js";
import { acquireWriterLease, publicRunRecord, StateStore } from "./state.js";
import { taskAuthorityDeadline } from "./verification-authority.js";

const reject = (code: string, message: string): never => {
  throw new MillError(code, message, ExitCode.configuration);
};

async function prepare(
  root: string,
  inputs: RuntimeInputs,
  store: StateStore,
  runId: string,
) {
  const run = store.getRun(runId);
  assertEffectAllowsNewWork(run);
  if (
    inputs.config.trustCeiling !== "build" ||
    inputs.config.propose !== undefined
  )
    reject(
      "LOCAL_COMPLETION_UNAVAILABLE",
      "Local completion requires a frozen build-only policy.",
    );
  if (
    run.status !== "reviewed" ||
    run.cancelRequested ||
    run.deliveryJson !== undefined ||
    run.remoteFeedbackJson !== undefined ||
    [
      run.activeProcessId,
      run.activePid,
      run.activeProcessGroup,
      run.activeProcessIdentity,
    ].some((value) => value !== undefined) ||
    store.unresolvedMutatingWorkerInvocations(run.id).length > 0 ||
    (await hasPendingOciResources(store.directory))
  )
    reject(
      "LOCAL_COMPLETION_UNAVAILABLE",
      "An uncancelled, reviewed candidate with no unsettled work or delivery is required.",
    );
  const candidate = await assertRunBindings(root, run, inputs);
  const evidence = await assertLocalCompletionEvidence(run, inputs, candidate);
  const expiresAt = Math.min(
    Date.parse(run.deadlineAt),
    ...(evidence.validation.externalReceipts ?? []).map((item) =>
      Date.parse(item.expiresAt),
    ),
    taskAuthorityDeadline(inputs),
  );
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
    reject(
      "LOCAL_COMPLETION_EXPIRED",
      "Local completion requires current run and verification authority.",
    );
  const plan = localCompletionPlanSchema.parse({
    schemaVersion: "1",
    kind: "local_completion",
    repositoryId: run.repositoryId,
    runId: run.id,
    taskDigest: run.taskDigest,
    configDigest: run.configDigest,
    candidateCommit: candidate.commit,
    candidateTree: candidate.tree,
    validationDigest: evidence.validationDigest,
    reviewDigest: evidence.reviewDigest,
    expiresAt: new Date(expiresAt).toISOString(),
  });
  return { plan, approvalDigest: canonicalDigest(plan) };
}

function readCompletion(store: StateStore, runId: string) {
  const snapshot = store.runEventSnapshot(runId);
  const run = snapshot.run;
  if (run === undefined) return undefined;
  const receipt = localCompletionForRun(run, snapshot.events);
  return receipt === undefined
    ? undefined
    : { run: publicRunRecord(run), ...receipt };
}

/** Plan and apply are separate. A repeated exact approval reads the settled receipt. */
export async function completeLocalRun(input: {
  root: string;
  taskPath: string;
  runId: string;
  approvalDigest?: string;
  attended?: boolean;
}) {
  if (input.approvalDigest !== undefined && input.attended !== true)
    reject(
      "ATTENDANCE_REQUIRED",
      "Applying local completion requires attended approval of the exact plan.",
    );
  await enforceExactVersion(input.root);
  const readbackInputs = await loadRuntimeInputs(
    input.root,
    input.taskPath,
    "readback",
  );
  const commonDirectory = await commonGitDirectory(input.root);
  const readOnly = await StateStore.openReadOnly(
    readbackInputs.config.repositoryId,
    commonDirectory,
  );
  if (readOnly === undefined)
    return reject("RUN_NOT_FOUND", "An existing reviewed run is required.");
  try {
    const completed = readCompletion(readOnly, input.runId);
    if (completed !== undefined) {
      if (
        completed.plan.taskDigest !== readbackInputs.taskDigest ||
        completed.plan.configDigest !== readbackInputs.configDigest ||
        (input.approvalDigest !== undefined &&
          completed.approvalDigest !== input.approvalDigest)
      )
        reject(
          "LOCAL_COMPLETION_MISMATCH",
          "The recorded completion belongs to another approved plan.",
        );
      return completed;
    }
    if (input.approvalDigest === undefined)
      return await prepare(
        input.root,
        await loadRuntimeInputs(input.root, input.taskPath),
        readOnly,
        input.runId,
      );
  } finally {
    readOnly.close();
  }

  const inputs = await loadRuntimeInputs(input.root, input.taskPath);
  const store = await StateStore.open(
    inputs.config.repositoryId,
    commonDirectory,
  );
  let lease: Awaited<ReturnType<typeof acquireWriterLease>> | undefined;
  try {
    lease = await acquireWriterLease(store);
    const concurrentCompletion = readCompletion(store, input.runId);
    if (concurrentCompletion?.approvalDigest === input.approvalDigest)
      return concurrentCompletion;
    const { plan, approvalDigest } = await prepare(
      input.root,
      inputs,
      store,
      input.runId,
    );
    if (input.approvalDigest !== approvalDigest)
      reject(
        "LOCAL_COMPLETION_MISMATCH",
        "Approval is stale or belongs to another local completion plan.",
      );
    store.completeLocal(input.runId, plan, approvalDigest);
    return (
      readCompletion(store, input.runId) ??
      reject(
        "LOCAL_COMPLETION_EVIDENCE_INVALID",
        "The completion receipt could not be read back.",
      )
    );
  } finally {
    try {
      await lease?.release();
    } finally {
      store.close();
    }
  }
}
