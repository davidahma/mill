import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify as yaml } from "yaml";

import { operatorHandoff } from "../src/planning/handoff.js";
import { classifyReview } from "../src/runtime/review-policy.js";
import { canonicalDigest, type JsonValue } from "../src/contracts/canonical.js";
import {
  millConfigSchema,
  reviewResultSchema,
} from "../src/contracts/schemas.js";
import * as processTools from "../src/runtime/process.js";
import * as repository from "../src/runtime/repository.js";
import { StateStore } from "../src/runtime/state.js";
import { temporaryDirectory } from "./helpers.js";

async function recordedHandoff(input: Parameters<typeof operatorHandoff>[0]) {
  const result = await operatorHandoff(input);
  if (!result.recorded) throw new Error("Expected a recorded handoff");
  return result;
}

const repositoryId = "11111111-1111-4111-8111-111111111111";
const digest = `sha256:${"a".repeat(64)}`;
const commit = "b".repeat(40);
const tree = "c".repeat(40);
const base = "d".repeat(40);
const previousStateHome = process.env.MILL_STATE_HOME;
afterEach(() => {
  vi.restoreAllMocks();
  if (previousStateHome === undefined) delete process.env.MILL_STATE_HOME;
  else process.env.MILL_STATE_HOME = previousStateHome;
});

function review(severity?: "P0" | "P1" | "P2" | "P3") {
  return reviewResultSchema.parse({
    schemaVersion: "1",
    candidateCommit: commit,
    summary: "Synthetic review",
    scope: {
      baseCommit: base,
      candidateCommit: commit,
      candidateTree: tree,
      changedPaths: ["src/value.ts"],
      digest,
    },
    findings:
      severity === undefined
        ? []
        : [
            {
              id: "F-1",
              severity,
              class: "correctness",
              title: "A defect",
              body: "Synthetic defect evidence",
              file: "src/value.ts",
              line: 1,
            },
          ],
  });
}

async function handoffFixture(candidate = true, bindConfig = false) {
  const directory = await temporaryDirectory("mill-handoff-");
  process.env.MILL_STATE_HOME = path.join(directory.path, "state");
  vi.spyOn(repository, "commonGitDirectory").mockResolvedValue(directory.path);
  const config = {
    schemaVersion: "1",
    repositoryId,
    trustCeiling: "inspect",
    commands: {},
  };
  await writeFile(path.join(directory.path, "mill.yaml"), yaml(config));
  const store = await StateStore.open(repositoryId, directory.path);
  const created = store.createRun({
    repositoryId,
    taskId: "one-task",
    taskDigest: digest,
    configDigest: bindConfig
      ? canonicalDigest(millConfigSchema.parse(config) as unknown as JsonValue)
      : digest,
    baseCommit: base,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  if (candidate) {
    store.transition(created.id, "ready", "run.ready");
    store.transition(created.id, "running", "builder.started");
    store.commitCandidate(created.id, commit, tree);
    store.completeValidation(
      created.id,
      JSON.stringify({
        schemaVersion: "1",
        candidateCommit: commit,
        verifierImage: `node@${digest}`,
        network: "none",
        commands: [
          {
            commandId: "validate",
            required: true,
            status: "passed",
            exitCode: 0,
            durationMs: 1,
            outputDigest: digest,
          },
        ],
        passed: true,
      }),
      true,
    );
    const database = new DatabaseSync(store.databasePath);
    database
      .prepare("UPDATE runs SET review_json = ? WHERE id = ?")
      .run(JSON.stringify(review()), created.id);
    database.close();
    store.transition(created.id, "reviewed", "review.passed");
  }
  const patch = (
    column: "validation_json" | "review_json" | "remote_feedback_json",
    value: unknown,
  ) => {
    const database = new DatabaseSync(store.databasePath);
    database
      .prepare(`UPDATE runs SET ${column} = ? WHERE id = ?`)
      .run(JSON.stringify(value), created.id);
    database.close();
  };
  const delivery = () => ({
    schemaVersion: "1",
    runId: created.id,
    deliveryKey: digest,
    proposalDigest: digest,
    approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: "awaiting_ci",
    target: {
      forge: "github",
      host: "github.com",
      owner: "example",
      repository: "app",
      repositoryNodeId: "R_app",
      cloneUrl: "https://github.com/example/app.git",
      remoteName: "origin",
      baseBranch: "main",
      actorLogin: "owner",
      actorId: 1,
    },
    branchName: "mill/one-task",
    candidateCommit: commit,
    candidateTree: tree,
    requiredChecks: ["validate"],
    reviewPolicy: {
      mode: "github_required",
      requiredReviewerLogins: ["reviewer"],
    },
    allowedMergerLogins: ["owner"],
    allowedMergeMethods: ["merge"],
    effects: [],
    remoteHeadCommit: commit,
    pullRequest: {
      number: 1,
      nodeId: "PR_1",
      url: "https://github.com/example/app/pull/1",
    },
    observation: {
      headSha: commit,
      branchSha: commit,
      checks: [
        {
          name: "validate",
          status: "completed",
          conclusion: "success",
          headSha: commit,
        },
      ],
      checkDecision: { status: "passed" },
      reviews: [
        { actorLogin: "reviewer", state: "APPROVED", commitId: commit },
      ],
      feedback: [],
    },
    merge: null,
    lastErrorCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return {
    root: directory.path,
    store,
    runId: created.id,
    patch,
    delivery,
    input: { root: directory.path, runId: created.id },
    cleanup: async () => {
      store.close();
      await directory.cleanup();
    },
  };
}

describe("independent operator handoff review", () => {
  it("reports delivery receipt expiry without suppressing provider readback", async () => {
    const fixture = await handoffFixture(true, true);
    try {
      const evidence = JSON.parse(
        fixture.store.getRun(fixture.runId).validationJson ?? "{}",
      ) as Record<string, unknown>;
      const expiredAt = new Date(Date.now() - 1000).toISOString();
      fixture.patch("validation_json", {
        ...evidence,
        externalReceipts: [
          { verifierId: "cpu", receiptDigest: digest, expiresAt: expiredAt },
        ],
      });
      fixture.store.transition(
        fixture.runId,
        "proposing",
        "delivery.awaiting_approval",
      );
      const proposing = await recordedHandoff(fixture.input);
      expect(proposing.externalEvidence?.status).toBe("expired");
      expect(proposing.next.action).toBe("external_evidence_expired");
      fixture.store.setDelivery(
        fixture.runId,
        JSON.stringify(fixture.delivery()),
        "delivery.observed",
      );
      fixture.store.transition(
        fixture.runId,
        "awaiting_ci",
        "delivery.awaiting_ci",
      );
      expect((await recordedHandoff(fixture.input)).next.action).toBe(
        "observe_draft_pr",
      );
      fixture.store.transition(
        fixture.runId,
        "awaiting_human",
        "delivery.awaiting_human",
      );
      const awaiting = await recordedHandoff(fixture.input);
      expect(awaiting.externalEvidence?.status).toBe("expired");
      expect(awaiting.blockers).toContain("EXTERNAL_EVIDENCE_EXPIRED");
      expect(awaiting.next.action).toBe("finalize_merge");
      expect(awaiting.next.reason).toContain("already performed merge");
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports every blocker and does not permit delivery from an inconsistent reviewed snapshot", async () => {
    const fixture = await handoffFixture();
    try {
      fixture.patch("validation_json", {
        schemaVersion: "1",
        candidateCommit: commit,
        verifierImage: `node@${digest}`,
        network: "none",
        commands: [],
        passed: false,
      });
      fixture.patch("review_json", review("P1"));
      fixture.store.setDelivery(
        fixture.runId,
        JSON.stringify({
          ...fixture.delivery(),
          observation: {
            ...fixture.delivery().observation,
            headSha: base,
            checkDecision: { status: "failed" },
            reviews: [],
          },
        }),
        "delivery.observed",
      );
      fixture.patch("remote_feedback_json", review("P0"));
      const handoff = await recordedHandoff(fixture.input);
      expect(handoff.blockers).toEqual(
        expect.arrayContaining([
          "VALIDATION_NOT_PASSED",
          "LOCAL_REVIEW_FINDINGS",
          "REMOTE_SNAPSHOT_STALE",
          "REQUIRED_CHECKS_NOT_PASSED",
          "REMOTE_REVIEW_NOT_COMPLETED",
          "REMOTE_REVIEW_FINDINGS",
        ]),
      );
      expect(handoff.next.action).toBe("attended_disposition");
    } finally {
      await fixture.cleanup();
    }
  });

  it("prioritizes unresolved worker effects over terminal owner route and lifecycle status", async () => {
    const fixture = await handoffFixture();
    try {
      fixture.store.transition(fixture.runId, "failed", "run.failed");
      const invocation = randomUUID();
      fixture.store.admitWorkerInvocation({
        runId: fixture.runId,
        invocationId: invocation,
        phase: "build",
        envelopeDigest: digest,
        envelopeJson: "{}",
      });
      fixture.store.markWorkerLaunchStarted(invocation);
      await writeFile(
        path.join(fixture.root, "owner.yaml"),
        yaml({
          schemaVersion: "1",
          candidateCommit: commit,
          candidateTree: tree,
          actor: "owner",
          route: "native_owner",
          reason: "Separate terminal route",
          evidenceDigest: digest,
        }),
      );
      const handoff = await recordedHandoff({
        ...fixture.input,
        ownerDispositionPath: "owner.yaml",
      });
      expect(handoff.blockers).toContain("RECONCILIATION_REQUIRED");
      expect(handoff.next.action).toBe("reconcile");
      expect(handoff.ownerDisposition).toMatchObject({
        recorded: true,
        route: "native_owner",
        authenticated: false,
      });
      expect(handoff.progress).toMatchObject({
        completed: true,
        silenceProvesStall: false,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["native_owner", "not_accepted"])(
    "keeps exact terminal %s disposition separate from Mill closure and acceptance",
    async (route) => {
      const fixture = await handoffFixture();
      try {
        fixture.store.transition(fixture.runId, "failed", "run.failed");
        const ownerPath = "owner.yaml";
        const disposition = {
          schemaVersion: "1",
          candidateCommit: commit,
          candidateTree: tree,
          actor: "owner",
          route,
          reason: "Separately recorded synthetic route",
          evidenceDigest: digest,
        };
        await writeFile(path.join(fixture.root, ownerPath), yaml(disposition));
        const handoff = await recordedHandoff({
          ...fixture.input,
          ownerDispositionPath: ownerPath,
        });
        expect(handoff.ownerDisposition).toMatchObject({
          recorded: true,
          authenticated: false,
          route,
          candidateCommit: commit,
          evidenceDigest: digest,
        });
        expect(handoff.millClosed).toBe(false);
        expect(handoff.ownerAcceptance).toBe("not_recorded");
        expect(handoff.next.action).toBe("none");
        for (const changed of [
          { candidateCommit: base },
          { candidateTree: base },
          { status: "closed" },
        ]) {
          await writeFile(
            path.join(fixture.root, ownerPath),
            yaml({ ...disposition, ...changed }),
          );
          await expect(
            operatorHandoff({
              ...fixture.input,
              ownerDispositionPath: ownerPath,
            }),
          ).rejects.toMatchObject({ code: "OWNER_DISPOSITION_INVALID" });
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("rejects owner disposition on a nonterminal candidate", async () => {
    const fixture = await handoffFixture();
    try {
      await writeFile(
        path.join(fixture.root, "owner.yaml"),
        yaml({
          schemaVersion: "1",
          candidateCommit: commit,
          candidateTree: tree,
          actor: "owner",
          route: "native_owner",
          reason: "Requires terminal checkpoint",
          evidenceDigest: digest,
        }),
      );
      await expect(
        operatorHandoff({
          ...fixture.input,
          ownerDispositionPath: "owner.yaml",
        }),
      ).rejects.toMatchObject({ code: "OWNER_DISPOSITION_INVALID" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("binds remote feedback to the exact candidate and preserves legacy blocking policy", async () => {
    const fixture = await handoffFixture();
    try {
      fixture.patch("remote_feedback_json", {
        ...review(),
        candidateCommit: base,
      });
      expect((await recordedHandoff(fixture.input)).blockers).toContain(
        "REMOTE_FEEDBACK_STALE",
      );
      fixture.patch("remote_feedback_json", review("P2"));
      expect((await recordedHandoff(fixture.input)).blockers).toContain(
        "REMOTE_REVIEW_FINDINGS",
      );
      fixture.patch(
        "remote_feedback_json",
        classifyReview(review("P2"), digest, "p0_p1"),
      );
      expect((await recordedHandoff(fixture.input)).blockers).toContain(
        "REMOTE_FEEDBACK_INVALID",
      );
      fixture.patch("review_json", classifyReview(review(), digest, "p0_p1"));
      const advisory = await recordedHandoff(fixture.input);
      expect(advisory.remote.actionableFindings).toBe(0);
      expect(advisory.blockers).not.toContain("REMOTE_REVIEW_FINDINGS");
    } finally {
      await fixture.cleanup();
    }
  });

  it("labels successful remote observations as recorded snapshots without live approval", async () => {
    const fixture = await handoffFixture();
    try {
      fixture.store.transition(
        fixture.runId,
        "proposing",
        "delivery.awaiting_approval",
      );
      fixture.store.setDelivery(
        fixture.runId,
        JSON.stringify(fixture.delivery()),
        "delivery.observed",
      );
      fixture.store.transition(
        fixture.runId,
        "awaiting_ci",
        "delivery.awaiting_ci",
      );
      const handoff = await recordedHandoff(fixture.input);
      expect(handoff.authority).toBe("read_only");
      expect(handoff.remote).toMatchObject({
        evidence: "recorded_snapshot",
        checks: "passed",
        hostedReview: "completed",
        liveApproval: false,
      });
      expect(handoff.next.action).toBe("observe_draft_pr");
    } finally {
      await fixture.cleanup();
    }
  });

  it("marks unprovable progress identity unknown and requires reconciliation without inferring a stall", async () => {
    const fixture = await handoffFixture(false);
    try {
      fixture.store.transition(fixture.runId, "ready", "run.ready");
      fixture.store.transition(fixture.runId, "running", "builder.started");
      fixture.store.setActiveProcess(fixture.runId, {
        id: randomUUID(),
        pid: 12345,
        processGroup: 12345,
        identity: digest,
      });
      vi.spyOn(processTools, "processIdentityStatus").mockReturnValue(
        "unknown",
      );
      const handoff = await recordedHandoff({
        ...fixture.input,
        now: Date.now() + 60_000,
      });
      expect(handoff.progress).toMatchObject({
        evidence: "unknown",
        silenceProvesStall: false,
        completed: false,
      });
      expect(handoff.next.action).toBe("reconcile");
      expect(handoff.blockers).toContain("RECONCILIATION_REQUIRED");
    } finally {
      await fixture.cleanup();
    }
  });

  it("reads current state without creating events, changing the database or exposing private receipt bytes", async () => {
    const fixture = await handoffFixture();
    try {
      fixture.store.close();
      const before = await readFile(fixture.store.databasePath);
      const beforeStat = await stat(fixture.store.databasePath);
      const first = await recordedHandoff({
        ...fixture.input,
        now: Date.now(),
      });
      const second = await recordedHandoff({
        ...fixture.input,
        now: Date.now(),
      });
      expect(first.snapshotDigest).toBe(second.snapshotDigest);
      expect(await readFile(fixture.store.databasePath)).toEqual(before);
      expect((await stat(fixture.store.databasePath)).mtimeMs).toBe(
        beforeStat.mtimeMs,
      );
      expect(JSON.stringify(first)).not.toMatch(
        /worktreePath|validationJson|reviewJson|remoteFeedbackJson|deliveryJson|activeProcessIdentity/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns absent state without creating a store", async () => {
    const fixture = await handoffFixture(false);
    try {
      const otherRoot = path.join(fixture.root, "empty");
      await mkdir(otherRoot);
      await writeFile(
        path.join(otherRoot, "mill.yaml"),
        yaml({
          schemaVersion: "1",
          repositoryId: "22222222-2222-4222-8222-222222222222",
          trustCeiling: "inspect",
          commands: {},
        }),
      );
      const before = await readdir(path.join(fixture.root, "state"));
      expect(await operatorHandoff({ root: otherRoot })).toMatchObject({
        recorded: false,
        authority: "read_only",
      });
      expect(await readdir(path.join(fixture.root, "state"))).toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains every uncertain effect and routes malformed evidence through reconciliation", async () => {
    const fixture = await handoffFixture();
    try {
      const invocation = randomUUID();
      fixture.store.admitWorkerInvocation({
        runId: fixture.runId,
        invocationId: invocation,
        phase: "build",
        envelopeDigest: digest,
        envelopeJson: "{}",
      });
      fixture.store.markWorkerLaunchStarted(invocation);
      fixture.store.setDelivery(fixture.runId, "{}", "delivery.observed");
      const ociDirectory = path.join(fixture.store.directory, "oci-resources");
      await mkdir(ociDirectory);
      await writeFile(
        path.join(ociDirectory, "unexpected"),
        "preserve malformed ownership evidence",
      );
      fixture.patch("remote_feedback_json", {});
      fixture.patch("review_json", {});
      const handoff = await recordedHandoff(fixture.input);
      expect(handoff.blockers).toEqual(
        expect.arrayContaining([
          "REMOTE_EVIDENCE_INVALID",
          "LOCAL_REVIEW_EVIDENCE_INVALID",
          "REMOTE_FEEDBACK_INVALID",
          "WORKER_INVOCATION_RECONCILIATION_REQUIRED",
          "OCI_RECONCILIATION_REQUIRED",
          "GITHUB_RECONCILIATION_REQUIRED",
        ]),
      );
      expect(handoff.next.action).toBe("reconcile");
      expect(
        await readFile(path.join(ociDirectory, "unexpected"), "utf8"),
      ).toBe("preserve malformed ownership evidence");
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["match", "mismatch"] as const)(
    "reports %s process identity without probing or controlling another process",
    async (identity) => {
      const fixture = await handoffFixture(false);
      try {
        fixture.store.transition(fixture.runId, "ready", "run.ready");
        fixture.store.transition(fixture.runId, "running", "builder.started");
        fixture.store.setActiveProcess(fixture.runId, {
          id: randomUUID(),
          pid: 12345,
          processGroup: 12345,
          identity: digest,
        });
        const observed = vi
          .spyOn(processTools, "processIdentityStatus")
          .mockReturnValue(identity);
        const handoff = await recordedHandoff({ ...fixture.input, now: 0 });
        expect(observed.mock.calls[0]?.[0]).toMatchObject({ pid: 12345 });
        expect(observed.mock.calls[0]?.[0].id).toEqual(expect.any(String));
        expect(handoff.next.action).toBe(
          identity === "match" ? "wait" : "resume",
        );
        expect(handoff.progress).toMatchObject({
          evidence:
            identity === "match"
              ? "process_observed"
              : "no_active_process_observed",
          silenceMilliseconds: null,
          silenceProvesStall: false,
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("requires current-head hosted completion and preserves recorded snapshots as nonauthoritative", async () => {
    const fixture = await handoffFixture();
    try {
      const delivery = fixture.delivery();
      fixture.store.setDelivery(
        fixture.runId,
        JSON.stringify({ ...delivery, observation: null }),
        "delivery.observed",
      );
      expect((await recordedHandoff(fixture.input)).blockers).toContain(
        "REMOTE_OBSERVATION_MISSING",
      );
      fixture.store.setDelivery(
        fixture.runId,
        JSON.stringify({
          ...delivery,
          observation: {
            ...delivery.observation,
            checkDecision: null,
            reviews: [null],
          },
        }),
        "delivery.observed",
      );
      const invalid = await recordedHandoff(fixture.input);
      expect(invalid.remote).toMatchObject({
        checks: "unknown",
        hostedReview: "not_completed",
        liveApproval: false,
      });
      expect(invalid.blockers).toEqual(
        expect.arrayContaining([
          "REQUIRED_CHECKS_NOT_PASSED",
          "REMOTE_REVIEW_NOT_COMPLETED",
        ]),
      );
      fixture.store.setDelivery(
        fixture.runId,
        JSON.stringify({
          ...delivery,
          reviewPolicy: {
            mode: "github_codex_required",
            requiredReviewerLogins: ["reviewer"],
          },
          observation: {
            ...delivery.observation,
            reviews: [
              { actorLogin: "reviewer", state: "APPROVED", commitId: commit },
              {
                actorLogin: "reviewer",
                state: "CODEX_COMPLETED",
                commitId: base,
              },
            ],
          },
        }),
        "delivery.observed",
      );
      expect((await recordedHandoff(fixture.input)).remote.hostedReview).toBe(
        "not_completed",
      );
      fixture.store.setDelivery(
        fixture.runId,
        JSON.stringify({
          ...delivery,
          reviewPolicy: {
            mode: "github_codex_required",
            requiredReviewerLogins: ["reviewer"],
          },
          observation: {
            ...delivery.observation,
            reviews: [
              {
                actorLogin: "reviewer",
                state: "CODEX_COMPLETED",
                commitId: commit,
              },
            ],
          },
        }),
        "delivery.observed",
      );
      expect((await recordedHandoff(fixture.input)).remote).toMatchObject({
        hostedReview: "completed",
        liveApproval: false,
      });
      fixture.patch("remote_feedback_json", {
        ...review(),
        scope: { ...review().scope, candidateTree: base },
      });
      expect((await recordedHandoff(fixture.input)).blockers).toContain(
        "REMOTE_FEEDBACK_STALE",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns absent run state and rejects malformed owner declarations with a stable error", async () => {
    const fixture = await handoffFixture();
    try {
      fixture.store.transition(fixture.runId, "failed", "run.failed");
      await writeFile(
        path.join(fixture.root, "owner.yaml"),
        "schemaVersion: [\n",
      );
      await expect(
        operatorHandoff({
          ...fixture.input,
          ownerDispositionPath: "owner.yaml",
        }),
      ).rejects.toMatchObject({ code: "OWNER_DISPOSITION_INVALID" });
      const otherId = "22222222-2222-4222-8222-222222222222";
      const emptyStore = await StateStore.open(otherId, fixture.root);
      emptyStore.close();
      await writeFile(
        path.join(fixture.root, "mill.yaml"),
        yaml({
          schemaVersion: "1",
          repositoryId: otherId,
          trustCeiling: "inspect",
          commands: {},
        }),
      );
      expect(await operatorHandoff({ root: fixture.root })).toMatchObject({
        recorded: false,
        authority: "read_only",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("uses resulting-main evidence for a closed Mill lifecycle without inventing owner acceptance", async () => {
    const fixture = await handoffFixture();
    try {
      const delivered = fixture.delivery();
      fixture.store.setDelivery(
        fixture.runId,
        JSON.stringify(delivered),
        "delivery.observed",
      );
      fixture.store.transition(
        fixture.runId,
        "proposing",
        "delivery.awaiting_approval",
      );
      fixture.store.transition(
        fixture.runId,
        "awaiting_ci",
        "delivery.awaiting_ci",
      );
      fixture.store.transition(
        fixture.runId,
        "awaiting_human",
        "delivery.awaiting_human",
      );
      const mergeCommit = "e".repeat(40);
      const merged = {
        ...delivered,
        state: "closed",
        merge: {
          commit: mergeCommit,
          tree,
          method: "merge",
          mergedByLogin: "owner",
          mergedAt: new Date().toISOString(),
          defaultBranchHead: mergeCommit,
        },
        observation: {
          mergeChecks: [
            {
              name: "validate",
              status: "completed",
              conclusion: "success",
              headSha: mergeCommit,
            },
          ],
          reviews: delivered.observation.reviews,
          feedback: [],
          observedAt: new Date().toISOString(),
        },
      };
      fixture.store.setDelivery(
        fixture.runId,
        JSON.stringify(merged),
        "delivery.merge_verified",
      );
      fixture.store.transition(fixture.runId, "merged", "delivery.merged");
      fixture.store.transition(
        fixture.runId,
        "post_merge_verified",
        "delivery.post_merge_verified",
      );
      fixture.store.transition(fixture.runId, "closed", "run.closed");
      const handoff = await recordedHandoff(fixture.input);
      expect(handoff.integrity.status).toBe("consistent");
      expect(handoff.millClosed).toBe(true);
      expect(handoff.ownerAcceptance).toBe("not_recorded");
      expect(handoff.blockers).toEqual([]);
      expect(handoff.remote).toMatchObject({
        checks: "passed",
        evidence: "recorded_snapshot",
        liveApproval: false,
      });
      expect(handoff.next.action).toBe("none");
      fixture.store.setDelivery(
        fixture.runId,
        JSON.stringify({
          ...merged,
          observation: {
            ...merged.observation,
            mergeChecks: [
              {
                name: "validate",
                status: "completed",
                conclusion: "success",
                headSha: base,
              },
            ],
          },
        }),
        "delivery.observed",
      );
      const wrongHead = await recordedHandoff(fixture.input);
      expect(wrongHead.blockers).toEqual(
        expect.arrayContaining([
          "REMOTE_SNAPSHOT_STALE",
          "REQUIRED_CHECKS_NOT_PASSED",
        ]),
      );
      expect(wrongHead.remote.checks).toBe("unknown");
    } finally {
      await fixture.cleanup();
    }
  });
});
