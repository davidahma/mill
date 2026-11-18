import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { operatorHandoff } from "../src/planning/handoff.js";
import {
  qualifyBaseline,
  reviewRun,
  runOutcome,
  runStatus,
  startLocalRun,
  verifyRun,
} from "../src/runtime/lifecycle.js";
import { completeLocalRun } from "../src/runtime/local-completion.js";
import { runtimeFixture } from "./runtime-fixture.js";

const exec = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());

function activate(fixture: Awaited<ReturnType<typeof runtimeFixture>>) {
  vi.stubEnv("MILL_STATE_HOME", fixture.stateHome);
  vi.stubEnv("MILL_CODEX_PATH", fixture.codexPath);
  vi.stubEnv("MILL_DOCKER_PATH", fixture.dockerPath);
}

async function git(root: string, args: string[]) {
  const result = await exec(
    process.env.MILL_GIT_PATH ?? "/usr/bin/git",
    [
      "-c",
      "user.name=Mill Test",
      "-c",
      "user.email=mill-test@example.invalid",
      ...args,
    ],
    { cwd: root },
  );
  return result.stdout.trim();
}

async function build(input: { root: string; taskPath: string }) {
  const baseline = await qualifyBaseline(input);
  expect(baseline.evidence.passed).toBe(true);
  const run = (
    await startLocalRun({
      ...input,
      approvalDigest: baseline.approvalDigest ?? "",
    })
  ).run;
  const candidate = { ...input, runId: run.id };
  expect((await verifyRun(candidate)).evidence.passed).toBe(true);
  expect((await reviewRun(candidate)).run.status).toBe("reviewed");
  return { ...candidate, run };
}

it("retains attended local completion for two dependent reviewed tasks in the same repository", async () => {
  const fixture = await runtimeFixture();
  activate(fixture);
  try {
    const first = await build({
      root: fixture.root,
      taskPath: fixture.taskPath,
    });
    const { run, ...firstInput } = first;
    expect((await runStatus(firstInput)).continuation?.next.action).toBe(
      "plan_local_completion",
    );
    const firstPlan = await completeLocalRun(firstInput);
    expect(firstPlan.plan.candidateCommit).toBe(run.candidateCommit);
    await expect(
      completeLocalRun({
        ...firstInput,
        approvalDigest: firstPlan.approvalDigest,
      }),
    ).rejects.toMatchObject({ code: "ATTENDANCE_REQUIRED" });
    await expect(
      completeLocalRun({
        ...firstInput,
        approvalDigest: `sha256:${"0".repeat(64)}`,
        attended: true,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_COMPLETION_MISMATCH" });
    expect((await runStatus(firstInput)).run?.status).toBe("reviewed");
    const approved = {
      ...firstInput,
      approvalDigest: firstPlan.approvalDigest,
      attended: true,
    };
    const settled = await completeLocalRun(approved);
    expect(settled).toMatchObject({ run: { status: "local_completed" } });
    await expect(completeLocalRun(approved)).resolves.toEqual(settled);
    expect(await runOutcome(firstInput)).toMatchObject({
      localCompletion: firstPlan,
      delivery: { status: "not_recorded" },
      integrity: { status: "consistent" },
    });
    expect(await operatorHandoff(firstInput)).toMatchObject({
      millClosed: false,
      progress: { completed: true },
      next: { action: "none" },
    });
    const duplicate = await qualifyBaseline(firstInput);
    await expect(
      startLocalRun({
        ...firstInput,
        approvalDigest: duplicate.approvalDigest ?? "",
      }),
    ).rejects.toMatchObject({ code: "OUTCOME_ALREADY_LOCALLY_COMPLETED" });

    if (run.candidateCommit === undefined)
      throw new Error("First candidate was not retained");
    await git(fixture.root, ["merge", "--ff-only", run.candidateCommit]);
    const taskPath = "product/tasks/next.yaml";
    const source = await readFile(
      path.join(fixture.root, fixture.taskPath),
      "utf8",
    );
    await writeFile(
      path.join(fixture.root, taskPath),
      source.replace("id: positive-value\n", "id: next-positive-value\n"),
    );
    await git(fixture.root, ["add", taskPath]);
    await git(fixture.root, [
      "commit",
      "--no-gpg-sign",
      "-m",
      "test: approve dependent task",
    ]);
    const codex = await readFile(fixture.codexPath, "utf8");
    await writeFile(
      fixture.codexPath,
      codex.replace("?current+1:2", "?current+1:3"),
    );
    const second = await build({ root: fixture.root, taskPath });
    const secondInput = { root: second.root, taskPath, runId: second.runId };
    const secondPlan = await completeLocalRun(secondInput);
    expect(secondPlan.plan.candidateCommit).not.toBe(
      firstPlan.plan.candidateCommit,
    );
    await completeLocalRun({
      ...secondInput,
      approvalDigest: secondPlan.approvalDigest,
      attended: true,
    });
    await expect(completeLocalRun(approved)).resolves.toEqual(settled);
    expect(await runOutcome(secondInput)).toMatchObject({
      run: { status: "local_completed" },
      localCompletion: secondPlan,
      delivery: { status: "not_recorded" },
    });
  } finally {
    await fixture.cleanup();
  }
});

it("keeps a proposal-enabled task on its delivery path", async () => {
  const fixture = await runtimeFixture({ propose: true });
  activate(fixture);
  try {
    const reviewed = await build({
      root: fixture.root,
      taskPath: fixture.taskPath,
    });
    expect((await runStatus(reviewed)).continuation?.next.action).toBe(
      "plan_draft_pr",
    );
    await expect(completeLocalRun(reviewed)).rejects.toMatchObject({
      code: "LOCAL_COMPLETION_UNAVAILABLE",
    });
    expect((await runStatus(reviewed)).run?.status).toBe("reviewed");
  } finally {
    await fixture.cleanup();
  }
});

it("declines local completion guidance and planning after review moves off the approved base", async () => {
  const fixture = await runtimeFixture();
  activate(fixture);
  try {
    const ancestor = await git(fixture.root, ["rev-parse", "HEAD"]);
    await git(fixture.root, [
      "commit",
      "--allow-empty",
      "-m",
      "test: approve a new baseline",
    ]);
    const { run: originallyReviewed, ...input } = await build({
      root: fixture.root,
      taskPath: fixture.taskPath,
    });
    expect(ancestor).not.toBe(originallyReviewed.baseCommit);
    expect((await runStatus(input)).continuation?.next.action).toBe(
      "plan_local_completion",
    );
    const refreshed = await reviewRun({
      ...input,
      refresh: true,
      attended: true,
      baseCommit: ancestor,
    });
    expect(refreshed.run.status).toBe("reviewed");
    expect(refreshed.review.scope?.baseCommit).toBe(ancestor);
    await expect(completeLocalRun(input)).rejects.toMatchObject({
      code: "LOCAL_COMPLETION_EVIDENCE_INVALID",
    });
    const next = {
      action: "attended_disposition",
      code: "LOCAL_COMPLETION_EVIDENCE_INVALID",
    };
    expect((await runStatus(input)).continuation?.next).toMatchObject(next);
    expect(await operatorHandoff(input)).toMatchObject({ next });
  } finally {
    await fixture.cleanup();
  }
});
