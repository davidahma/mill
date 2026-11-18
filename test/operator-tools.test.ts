import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessConsumption,
  loadOperatorManifest,
  summarizeChangeEvidence,
  taskReadiness,
} from "../src/planning/operator.js";
import { runtimeFixture } from "./runtime-fixture.js";
import { loadRuntimeInputs } from "../src/runtime/inputs.js";
import {
  commonGitDirectory,
  readCandidateIdentity,
} from "../src/runtime/repository.js";
import { StateStore } from "../src/runtime/state.js";
import { temporaryDirectory } from "./helpers.js";

const digest = `sha256:${"a".repeat(64)}`;
const candidate = "b".repeat(40);
const measurement = {
  id: "candidate-review",
  kind: "native",
  evidenceDigest: digest,
  candidateCommit: candidate,
  source: "measured",
  inputTokens: 100,
  outputTokens: 10,
  cacheInputTokens: 80,
};
const change = {
  schemaVersion: "1",
  changeId: "CHANGE-TEST",
  measurements: [measurement],
  effort: {
    preparationMinutes: null,
    reviewMinutes: null,
    repairMinutes: null,
  },
  hostedRequests: 1,
};

const originalState = process.env.MILL_STATE_HOME;
const originalDocker = process.env.MILL_DOCKER_PATH;
afterEach(() => {
  if (originalState === undefined) delete process.env.MILL_STATE_HOME;
  else process.env.MILL_STATE_HOME = originalState;
  if (originalDocker === undefined) delete process.env.MILL_DOCKER_PATH;
  else process.env.MILL_DOCKER_PATH = originalDocker;
});

describe("operator evidence and readiness", () => {
  it.each(["run", "preparation"] as const)(
    "rejects repeated cumulative %s identity even when receipts differ",
    (kind) => {
      const binding =
        kind === "run"
          ? { runId: "11111111-1111-4111-8111-111111111111" }
          : { sessionId: "review-session" };
      expect(() =>
        summarizeChangeEvidence({
          ...change,
          measurements: [
            { ...measurement, ...binding, kind },
            {
              ...measurement,
              ...binding,
              kind,
              id: "second-receipt",
              evidenceDigest: `sha256:${"c".repeat(64)}`,
              candidateCommit: "d".repeat(40),
            },
          ],
        }),
      ).toThrow(expect.objectContaining({ code: "CHANGE_EVIDENCE_DUPLICATE" }));
    },
  );
  it("rejects aggregate integer overflow and malformed measurement contracts", () => {
    expect(() =>
      summarizeChangeEvidence({
        ...change,
        measurements: [
          {
            ...measurement,
            inputTokens: Number.MAX_SAFE_INTEGER,
            outputTokens: 1,
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: "CHANGE_EVIDENCE_MEASUREMENT_INVALID" }),
    );
    for (const value of [
      null,
      { ...change, extra: true },
      { ...change, hostedRequests: -1 },
      { ...change, measurements: [{ ...measurement, inputTokens: 0.5 }] },
      { ...change, measurements: [{ ...measurement, source: "unavailable" }] },
    ])
      expect(() => summarizeChangeEvidence(value)).toThrow();
    expect(
      summarizeChangeEvidence({ ...change, measurements: [] }),
    ).toMatchObject({
      usage: {
        source: "unavailable",
        totalTokens: null,
        measuredTotalTokens: null,
        cacheInputTokens: null,
      },
    });
  });
  it.each([
    "legacy-measured",
    "legacy-unavailable",
    "current-measured",
    "empty",
    "overflow",
    "mismatch",
  ] as const)(
    "reads exact prior %s spend without creating or estimating a run",
    async (mode) => {
      const fixture = await runtimeFixture({ maxModelTokens: 200 });
      process.env.MILL_STATE_HOME = fixture.stateHome;
      try {
        const inputs = await loadRuntimeInputs(fixture.root, fixture.taskPath);
        const store = await StateStore.open(
          inputs.config.repositoryId,
          await commonGitDirectory(fixture.root),
        );
        const run = store.createRun({
          repositoryId: inputs.config.repositoryId,
          taskId: inputs.task.id,
          taskDigest: mode === "mismatch" ? digest : inputs.taskDigest,
          configDigest: inputs.configDigest,
          baseCommit: (await readCandidateIdentity(fixture.root)).commit,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        });
        if (mode === "current-measured")
          store.recordEvent(run.id, "worker.admitted", { phase: "build" });
        if (!["empty", "mismatch"].includes(mode))
          store.recordEvent(
            run.id,
            mode === "current-measured"
              ? "provider.usage_recorded"
              : "builder.completed",
            {
              phase: "build",
              outcome: "completed",
              usageSource:
                mode === "legacy-unavailable" ? "unavailable" : "measured",
              inputTokens:
                mode === "legacy-unavailable"
                  ? null
                  : mode === "overflow"
                    ? Number.MAX_SAFE_INTEGER
                    : 100,
              outputTokens: mode === "legacy-unavailable" ? null : 10,
              cacheInputTokens: mode === "legacy-unavailable" ? null : 80,
            },
          );
        const before = store.events(run.id);
        store.close();
        const request = {
          root: fixture.root,
          taskPath: fixture.taskPath,
          runId: run.id,
        };
        if (mode === "mismatch")
          await expect(taskReadiness(request)).rejects.toMatchObject({
            code: "READINESS_RUN_MISMATCH",
          });
        else if (mode === "overflow")
          await expect(taskReadiness(request)).rejects.toMatchObject({
            code: "READINESS_USAGE_INVALID",
          });
        else
          expect(
            (await taskReadiness(request)).spend.remainingModelTokens,
          ).toBe(
            mode === "empty" ? 200 : mode === "legacy-unavailable" ? null : 90,
          );
        const after = await StateStore.openReadOnly(
          inputs.config.repositoryId,
          await commonGitDirectory(fixture.root),
        );
        expect(after?.events(run.id)).toEqual(before);
        expect(after?.runs()).toHaveLength(1);
        after?.close();
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it("loads bounded manifests and rejects escaping, symlinked, missing and malformed inputs", async () => {
    const directory = await temporaryDirectory("mill-operator-manifests-");
    try {
      const file = path.join(directory.path, "change.json");
      await writeFile(file, JSON.stringify(change));
      expect(
        await loadOperatorManifest(directory.path, "change.json", "change"),
      ).toMatchObject({ changeId: "CHANGE-TEST", authenticated: false });
      await symlink(file, path.join(directory.path, "linked.json"));
      await expect(
        loadOperatorManifest(directory.path, "linked.json", "change"),
      ).rejects.toMatchObject({ code: "UNSAFE_FILE_TYPE" });
      await expect(
        loadOperatorManifest(directory.path, "../outside.yaml", "change"),
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
      await expect(
        loadOperatorManifest(directory.path, "missing.yaml", "change"),
      ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
      await writeFile(file, "schemaVersion: [");
      await expect(
        loadOperatorManifest(directory.path, "change.json", "change"),
      ).rejects.toMatchObject({ code: "OPERATOR_MANIFEST_INVALID" });
      await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
      await expect(
        loadOperatorManifest(directory.path, "change.json", "change"),
      ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    } finally {
      await directory.cleanup();
    }
  });
  it("probes only an explicitly attended image inspection and reports unavailable tools", async () => {
    const fixture = await runtimeFixture();
    try {
      const probe = path.join(fixture.stateHome, "docker-probe");
      const calls = path.join(fixture.stateHome, "docker-calls");
      await writeFile(
        probe,
        `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+"\\n");process.exit(0);`,
        { mode: 0o755 },
      );
      await chmod(probe, 0o755);
      process.env.MILL_DOCKER_PATH = probe;
      expect(
        (
          await taskReadiness({
            root: fixture.root,
            taskPath: fixture.taskPath,
          })
        ).verifier.status,
      ).toBe("not_probed");
      await expect(readFile(calls)).rejects.toMatchObject({ code: "ENOENT" });
      const report = await taskReadiness({
        root: fixture.root,
        taskPath: fixture.taskPath,
        probeVerifier: true,
        attended: true,
      });
      expect(report.verifier).toMatchObject({
        status: "present",
        implicitPull: false,
      });
      expect(JSON.parse((await readFile(calls, "utf8")).trim())).toEqual([
        "image",
        "inspect",
        report.verifier.image,
      ]);
      process.env.MILL_DOCKER_PATH = path.join(
        fixture.stateHome,
        "missing-docker",
      );
      expect(
        (
          await taskReadiness({
            root: fixture.root,
            taskPath: fixture.taskPath,
            probeVerifier: true,
            attended: true,
          })
        ).verifier.status,
      ).toBe("unavailable");
      await writeFile(probe, `#!${process.execPath}\nprocess.exit(7);`, {
        mode: 0o755,
      });
      process.env.MILL_DOCKER_PATH = probe;
      expect(
        (
          await taskReadiness({
            root: fixture.root,
            taskPath: fixture.taskPath,
            probeVerifier: true,
            attended: true,
          })
        ).verifier.status,
      ).toBe("unavailable");
    } finally {
      await fixture.cleanup();
    }
  });
  it("does not double count cached input or infer missing costs and effort", () => {
    expect(summarizeChangeEvidence(change)).toMatchObject({
      changeId: "CHANGE-TEST",
      usage: {
        source: "measured",
        inputTokens: 100,
        outputTokens: 10,
        cacheInputTokens: 80,
        totalTokens: 110,
        cost: "unavailable",
      },
      effort: change.effort,
      hostedRequests: 1,
      hostedUsage: "unavailable",
      authenticated: false,
    });
  });
  it("rejects duplicate evidence and inconsistent measured coverage", () => {
    expect(() =>
      summarizeChangeEvidence({
        ...change,
        measurements: [measurement, { ...measurement, id: "same-spend" }],
      }),
    ).toThrow();
    expect(() =>
      summarizeChangeEvidence({
        ...change,
        measurements: [{ ...measurement, inputTokens: null }],
      }),
    ).toThrow();
    expect(() =>
      summarizeChangeEvidence({
        ...change,
        measurements: [{ ...measurement, cacheInputTokens: 101 }],
      }),
    ).toThrow();
  });
  it("retains unavailable measurements rather than treating them as zero", () => {
    expect(
      summarizeChangeEvidence({
        ...change,
        measurements: [
          measurement,
          {
            ...measurement,
            id: "failed-call",
            evidenceDigest: `sha256:${"c".repeat(64)}`,
            source: "unavailable",
            inputTokens: null,
            outputTokens: null,
            cacheInputTokens: null,
          },
        ],
      }),
    ).toMatchObject({
      usage: {
        source: "partial",
        totalTokens: null,
        measuredTotalTokens: 110,
        cost: "unavailable",
      },
    });
  });
  it("validates exact release identities without claiming customer qualification", async () => {
    const manifest = {
      schemaVersion: "1",
      ownerRepository: "Clyra-AI/public-runtime",
      consumerRepository: "Clyra-AI/private-product",
      version: "0.1.0-preview.1",
      sourceRevision: candidate,
      platform: "linux/amd64",
      artifact: {
        manifestDigest: digest,
        imageConfigDigest: digest,
        archiveSha256: digest,
      },
      rollback: { version: "0.1.0-preview.0", artifactDigest: digest },
      transitions: {
        sourceReviewed: "recorded",
        artifactQualified: "recorded",
        pinAdopted: "pending",
        customerQualified: "not_run",
      },
    };
    expect(assessConsumption(manifest)).toMatchObject({
      formatValid: true,
      authenticated: false,
      authority: "consumer_declared",
      transitions: manifest.transitions,
      customerCompatibility: "not_established",
    });
    expect(() =>
      assessConsumption({ ...manifest, version: "latest" }),
    ).toThrow();
    for (const invalidVersion of ["1.2.3-..", "1.2.3-01", "1.2.3+build.1"])
      expect(() =>
        assessConsumption({ ...manifest, version: invalidVersion }),
      ).toThrow(
        expect.objectContaining({ code: "CONSUMPTION_MANIFEST_INVALID" }),
      );
    expect(() =>
      assessConsumption({
        ...manifest,
        artifact: { ...manifest.artifact, archiveSha256: "bad" },
      }),
    ).toThrow();
    expect(() =>
      assessConsumption({
        ...manifest,
        ownerRepository: manifest.consumerRepository,
      }),
    ).toThrow();
    expect(() =>
      assessConsumption({
        ...manifest,
        rollback: { ...manifest.rollback, version: manifest.version },
      }),
    ).toThrow(
      expect.objectContaining({ code: "CONSUMPTION_ROLLBACK_CONFLICT" }),
    );
    const directory = await temporaryDirectory("mill-consumption-manifest-");
    try {
      await writeFile(
        path.join(directory.path, "consumption.json"),
        JSON.stringify(manifest),
      );
      await expect(
        loadOperatorManifest(directory.path, "consumption.json", "consumption"),
      ).resolves.toMatchObject({
        formatValid: true,
        authenticated: false,
        customerCompatibility: "not_established",
      });
    } finally {
      await directory.cleanup();
    }
  });
  it("discloses task context without pulling images, spending models or authorizing delivery", async () => {
    const fixture = await runtimeFixture({
      propose: true,
      githubReviewMode: "github_codex_required",
    });
    try {
      const report = await taskReadiness({
        root: fixture.root,
        taskPath: fixture.taskPath,
      });
      expect(report).toMatchObject({
        authority: "read_only_preflight",
        qualified: false,
        verifier: { status: "not_probed" },
        delivery: { hostedReviewAvailability: "unknown" },
        context: {
          workerReads: "unavailable",
          filesystemAcl: false,
          tokenEstimate: "unavailable",
        },
      });
      expect(report.context.totalBytes).toBeGreaterThan(0);
      expect(report.commands.length).toBeGreaterThan(0);
      await expect(
        taskReadiness({
          root: fixture.root,
          taskPath: fixture.taskPath,
          probeVerifier: true,
        }),
      ).rejects.toMatchObject({ code: "ATTENDANCE_REQUIRED" });
      await expect(
        taskReadiness({ root: fixture.root, taskPath: "../escape.yaml" }),
      ).rejects.toThrow();
      await mkdir(path.join(fixture.root, "private"));
      await writeFile(
        path.join(fixture.root, "private", "never-read.txt"),
        "not selected",
      );
      expect(JSON.stringify(report)).not.toContain("never-read");
    } finally {
      await fixture.cleanup();
    }
  });
});
