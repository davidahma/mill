import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { canonicalJson } from "../src/contracts/canonical.js";
import { millConfigSchema } from "../src/contracts/schemas.js";
import { operatorHandoff } from "../src/planning/handoff.js";
import {
  planVerificationRecovery,
  qualifyBaseline,
  recoverVerification,
  requestExternalVerification,
  reviewRun,
  runStatus,
  runTimeline,
  startLocalRun,
  verifyRun,
} from "../src/runtime/lifecycle.js";
import { completeLocalRun } from "../src/runtime/local-completion.js";
import * as repository from "../src/runtime/repository.js";
import { commonGitDirectory } from "../src/runtime/repository.js";
import { StateStore } from "../src/runtime/state.js";
import { MILL_PACKAGE, MILL_VERSION } from "../src/version.js";
import { startFounderDelivery } from "../src/workflows/founder.js";
import { rewriteFixtureAuthority, runtimeFixture } from "./runtime-fixture.js";

const exec = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());

it("replays receipt wait and OCI preflight failure into attended recovery of the unchanged candidate", async () => {
  const fixture = await runtimeFixture();
  vi.stubEnv("MILL_STATE_HOME", fixture.stateHome);
  vi.stubEnv("MILL_CODEX_PATH", fixture.codexPath);
  vi.stubEnv("MILL_DOCKER_PATH", fixture.dockerPath);
  const git = async (args: string[]) =>
    exec(
      process.env.MILL_GIT_PATH ?? "/usr/bin/git",
      [
        "-c",
        "user.name=Mill Test",
        "-c",
        "user.email=mill-test@example.invalid",
        ...args,
      ],
      { cwd: fixture.root },
    );
  try {
    const key = generateKeyPairSync("ed25519");
    const { task, continuity } = await rewriteFixtureAuthority(
      fixture,
      (continuity) => {
        const scenario = continuity.scenarios.scenarios[0];
        if (scenario === undefined)
          throw new Error("Expected scenario fixture");
        scenario.oracleOwner = "external";
        scenario.executionRef = "cpu";
      },
    );
    const acceptance = task.acceptance[0];
    if (acceptance === undefined)
      throw new Error("Expected acceptance fixture");
    acceptance.evidence = { mode: "external", verifierId: "cpu" };
    await writeFile(path.join(fixture.root, fixture.taskPath), stringify(task));
    await writeFile(
      path.join(fixture.root, "product/plan.yaml"),
      stringify({
        schemaVersion: "1",
        productContractDigest: continuity.scenarios.productContractDigest,
        outcomes: [
          {
            id: "OUT-POSITIVE-VALUE",
            title: "Keep the exported value positive",
            acceptance: [acceptance.statement],
            acceptanceIds: [acceptance.id],
            dependsOn: [],
            status: "ready",
            taskRef: fixture.taskPath,
          },
        ],
      }),
    );
    const configPath = path.join(fixture.root, "mill.yaml");
    const config = millConfigSchema.parse(
      parse(await readFile(configPath, "utf8")),
    );
    config.externalVerifiers = {
      cpu: {
        publicKeyPem: key.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
        profileDigest: `sha256:${"a".repeat(64)}`,
        maxAgeSeconds: 120,
      },
    };
    await writeFile(configPath, stringify(config));
    await writeFile(
      path.join(fixture.root, "mill.lock"),
      stringify({
        schemaVersion: "1",
        mill: { package: MILL_PACKAGE, version: MILL_VERSION },
      }),
    );
    await git(["add", "."]);
    await git([
      "commit",
      "--no-gpg-sign",
      "-m",
      "test: configure a signed external verifier",
    ]);

    const taskInput = { root: fixture.root, taskPath: fixture.taskPath };
    const baseline = await qualifyBaseline(taskInput);
    expect(baseline.evidence.passed).toBe(true);
    const { run } = await startLocalRun({
      ...taskInput,
      approvalDigest: baseline.approvalDigest ?? "",
    });
    const input = { ...taskInput, runId: run.id };
    const store = await StateStore.open(
      config.repositoryId,
      await commonGitDirectory(fixture.root),
    );
    const databasePath = store.databasePath;
    store.close();
    function setDeadline(value: string) {
      const database = new DatabaseSync(databasePath);
      try {
        database
          .prepare("UPDATE runs SET deadline_at = ? WHERE id = ?")
          .run(value, run.id);
      } finally {
        database.close();
      }
    }
    expect((await runStatus(input)).continuation).toMatchObject({
      next: { action: "await_external_evidence" },
      externalEvidence: { status: "required", verifierIds: ["cpu"] },
    });
    expect(await operatorHandoff(input)).toMatchObject({
      next: { action: "await_external_evidence" },
      externalEvidence: { status: "required", verifierIds: ["cpu"] },
    });
    expect(
      await startFounderDelivery({
        root: fixture.root,
        prdPath: "product/PRD.md",
        attended: true,
        draftPr: false,
      }),
    ).toMatchObject({
      stage: "awaiting_external_evidence",
      run: { id: run.id },
      externalEvidence: { status: "required", verifierIds: ["cpu"] },
    });
    const originalRequest = { ...input, verifierId: "cpu" };
    const elapsed = new Date(Date.now() - 1000).toISOString();
    setDeadline(elapsed);
    await expect(
      requestExternalVerification(originalRequest),
    ).rejects.toMatchObject({
      code: "RUN_DEADLINE_EXCEEDED",
    });
    expect(await operatorHandoff(input)).toMatchObject({
      next: { action: "attended_disposition" },
      externalEvidence: {
        status: "unavailable",
        code: "RUN_DEADLINE_EXCEEDED",
      },
    });
    expect(
      await startFounderDelivery({
        root: fixture.root,
        prdPath: "product/PRD.md",
        attended: true,
        draftPr: false,
      }),
    ).toMatchObject({ stage: "verification_unavailable" });
    setDeadline(run.deadlineAt);
    const lockPath = path.join(fixture.root, "mill.lock");
    const originalLock = await readFile(lockPath, "utf8");
    await writeFile(lockPath, originalLock.replace(MILL_VERSION, "0.8.0"));
    await expect(
      requestExternalVerification(originalRequest),
    ).rejects.toMatchObject({
      code: "MILL_VERSION_MISMATCH",
    });
    expect((await runStatus(input)).continuation).toMatchObject({
      next: { action: "attended_disposition" },
      externalEvidence: {
        status: "unavailable",
        code: "VERIFICATION_CONTROLLER_UNAVAILABLE",
      },
    });
    await writeFile(lockPath, originalLock);
    await expect(verifyRun(input)).rejects.toMatchObject({
      code: "EXTERNAL_VERIFICATION_REQUIRED",
    });

    const request = await requestExternalVerification({
      ...input,
      verifierId: "cpu",
    });
    const content = '{"assertion":"fixture"}';
    const expiry = Date.now() + 60_000;
    const payload = {
      request,
      producedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(expiry).toISOString(),
      runtimeManifest: { evidence: "synthetic_replay" },
      claims: request.claims.map((claim) => ({
        ...claim,
        status: "passed",
        report: "report.json",
      })),
      reports: [
        {
          name: "report.json",
          content,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        },
      ],
    };
    const receiptPath = path.join(fixture.stateHome, "receipt.json");
    await writeFile(
      receiptPath,
      JSON.stringify({
        payload,
        signature: sign(
          null,
          Buffer.from(canonicalJson(payload)),
          key.privateKey,
        ).toString("base64"),
      }),
    );
    const docker = await readFile(fixture.dockerPath, "utf8");
    await writeFile(
      fixture.dockerPath,
      docker.replace(
        "const args=process.argv.slice(2);",
        'const args=process.argv.slice(2);if(args[0]==="image")process.exit(1);',
      ),
    );
    const verification = { ...input, externalReceiptPaths: [receiptPath] };
    await expect(verifyRun(verification)).rejects.toMatchObject({
      code: "VERIFIER_IMAGE_UNAVAILABLE",
    });
    expect(
      (await runTimeline(input))?.events.map((event) => event.type),
    ).toEqual(
      expect.arrayContaining([
        "verification.external_import_blocked",
        "verification.attempt_started",
        "run.blocked",
      ]),
    );
    // Advance the deadline in the fixture journal without sleeping for a wall-clock timeout.
    setDeadline(elapsed);
    await writeFile(fixture.dockerPath, docker);
    const recovery = {
      ...input,
      expiresAt: new Date(Date.now() + 50_000).toISOString(),
    };
    const { approvalDigest } = await planVerificationRecovery(recovery);
    await expect(
      recoverVerification({ ...recovery, approvalDigest, attended: true }),
    ).resolves.toMatchObject({
      status: "committed",
      candidateCommit: run.candidateCommit,
    });
    expect((await runStatus(input)).continuation).toMatchObject({
      next: { action: "await_external_evidence" },
      externalEvidence: { status: "required", expiresAt: recovery.expiresAt },
    });
    await expect(requestExternalVerification(originalRequest)).resolves.toEqual(
      request,
    );
    const expiredRecoveryClock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse(recovery.expiresAt));
    try {
      await expect(
        requestExternalVerification(originalRequest),
      ).rejects.toMatchObject({
        code: "VERIFICATION_RECOVERY_UNAVAILABLE",
      });
      expect((await runStatus(input)).continuation).toMatchObject({
        next: { action: "attended_disposition" },
        externalEvidence: { status: "unavailable" },
      });
    } finally {
      expiredRecoveryClock.mockRestore();
    }
    expect((await verifyRun(verification)).run.status).toBe("verified");
    const expired = await operatorHandoff({ ...input, now: expiry + 1 });
    if (!expired.recorded) throw new Error("Expected expired evidence handoff");
    expect(expired.blockers).toContain("EXTERNAL_EVIDENCE_EXPIRED");
    expect(expired).toMatchObject({
      externalEvidence: { status: "expired", verifierIds: ["cpu"] },
      next: { action: "external_evidence_expired" },
    });
    expect((await reviewRun(input)).run.status).toBe("reviewed");
    const recoveredStore = await StateStore.open(
      config.repositoryId,
      await commonGitDirectory(fixture.root),
    );
    try {
      const original = recoveredStore.getRun(input.runId);
      const previousBase = (await git(["rev-parse", "HEAD^"])).stdout.trim();
      const capture = repository.captureReviewScope;
      const clock = vi.spyOn(Date, "now");
      const scopeProbe = vi
        .spyOn(repository, "captureReviewScope")
        .mockImplementation(async (...args) => {
          const scope = await capture(...args);
          clock.mockReturnValue(Date.parse(recovery.expiresAt));
          return scope;
        });
      try {
        await expect(
          reviewRun({
            ...input,
            refresh: true,
            attended: true,
            baseCommit: previousBase,
          }),
        ).rejects.toMatchObject({ code: "VERIFICATION_RECOVERY_UNAVAILABLE" });
        expect(scopeProbe).toHaveBeenCalledOnce();
        expect(recoveredStore.getRun(input.runId)).toEqual(original);
      } finally {
        scopeProbe.mockRestore();
        clock.mockRestore();
      }
    } finally {
      recoveredStore.close();
    }
    await expect(completeLocalRun(input)).rejects.toMatchObject({
      code: "LOCAL_COMPLETION_EXPIRED",
    });
    const disposition = {
      action: "attended_disposition",
      code: "LOCAL_COMPLETION_EXPIRED",
    };
    expect(await runStatus(input)).toMatchObject({
      run: { status: "reviewed" },
      continuation: { next: disposition },
    });
    expect(await operatorHandoff(input)).toMatchObject({ next: disposition });
    expect(
      await startFounderDelivery({
        root: fixture.root,
        prdPath: "product/PRD.md",
        attended: true,
        draftPr: false,
      }),
    ).toMatchObject({ stage: "local_completion_unavailable" });
  } finally {
    await fixture.cleanup();
  }
});
