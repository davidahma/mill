import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli-program.js";
import {
  executeMaintainerReview,
  executePreparationSession,
} from "../src/planning/review-session.js";
import {
  loadOperatorManifest,
  taskReadiness,
} from "../src/planning/operator.js";
import { prepareOutcome } from "../src/planning/preparation.js";
import { operatorHandoff } from "../src/planning/handoff.js";
import { maintainedOutcomeHandoff } from "../src/runtime/maintained-outcome.js";
import { temporaryDirectory } from "./helpers.js";

vi.mock("../src/planning/review-session.js", () => ({
  executeMaintainerReview: vi.fn(),
  executePreparationSession: vi.fn(),
}));
vi.mock("../src/planning/operator.js", () => ({
  loadOperatorManifest: vi.fn(),
  taskReadiness: vi.fn(),
}));
vi.mock("../src/planning/preparation.js", () => ({ prepareOutcome: vi.fn() }));
vi.mock("../src/planning/handoff.js", () => ({ operatorHandoff: vi.fn() }));
vi.mock("../src/runtime/maintained-outcome.js", () => ({
  maintainedOutcomeHandoff: vi.fn(),
}));

const policyCommit = "a".repeat(40);
const subjectCommit = "b".repeat(40);
const artifactDigest = `sha256:${"c".repeat(64)}`;
const maintenanceArguments = [
  "--maintained-outcome",
  "policy.json",
  "--policy-commit",
  policyCommit,
  "--subject",
  subjectCommit,
  "--artifact-digest",
  artifactDigest,
];
const staleOutcome = {
  schemaVersion: "1",
  outcomeId: "OUT-WHEEL",
  claim: "The published wheel installs offline.",
  owner: "maintainer",
  policyPath: "policy.json",
  policyCommit,
  policyDigest: artifactDigest,
  subjectCommit,
  artifactDigest,
  request: null,
  evidenceScope: "supplied-artifact-digest-and-selected-records",
  status: "stale",
  reason: "POLICY_CHANGED",
  changedInputs: ["policy"],
  unavailableInputs: [],
  verification: null,
  ownerAcceptance: "not_recorded",
  next: {
    action: "select-policy",
    owner: "maintainer",
    scope: "Inspect the policy revision.",
  },
  authorizationGranted: false,
} satisfies Awaited<ReturnType<typeof maintainedOutcomeHandoff>>;

async function invokeRaw(args: string[]) {
  const directory = await temporaryDirectory("mill-operations-cli-");
  const stdout: string[] = [];
  try {
    const code = await runCli(["--cwd", directory.path, ...args], {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: () => undefined },
    });
    return {
      code,
      root: directory.path,
      text: stdout.join(""),
      emissions: stdout.length,
    };
  } finally {
    await directory.cleanup();
  }
}

async function invoke(args: string[]) {
  const result = await invokeRaw(["--json", ...args]);
  return {
    ...result,
    output: JSON.parse(result.text) as Record<string, unknown>,
  };
}

describe("operator CLI boundaries", () => {
  it("returns a read-only maintained outcome observation and skips run state", async () => {
    const runCalls = vi.mocked(operatorHandoff).mock.calls.length;
    vi.mocked(maintainedOutcomeHandoff).mockResolvedValueOnce(staleOutcome);
    const result = await invoke([
      "handoff",
      ...maintenanceArguments,
      "--evidence",
      "verification.json",
      "--acceptance",
      "acceptance.json",
    ]);
    expect(result.code).toBe(0);
    expect(result.emissions).toBe(1);
    expect(result.output).toMatchObject({
      ok: true,
      command: "handoff",
      data: staleOutcome,
    });
    expect(maintainedOutcomeHandoff).toHaveBeenLastCalledWith({
      root: result.root,
      policyPath: "policy.json",
      policyCommit,
      subjectCommit,
      artifactDigest,
      evidencePath: "verification.json",
      acceptancePath: "acceptance.json",
    });
    expect(vi.mocked(operatorHandoff).mock.calls).toHaveLength(runCalls);
  });

  it("leads human output with evidence status and the owner's next decision", async () => {
    const verificationDigest = `sha256:${"d".repeat(64)}`;
    const verifiedCommit = "e".repeat(40);
    vi.mocked(maintainedOutcomeHandoff).mockResolvedValueOnce({
      ...staleOutcome,
      reason: "INPUTS_CHANGED",
      changedInputs: ["artifact", "runtime"],
      verification: {
        digest: verificationDigest,
        subjectCommit: verifiedCommit,
        producedAt: "2026-10-12T12:00:00.000Z",
        result: "passed",
      },
      next: {
        action: "verify",
        owner: "maintainer",
        scope: "Request independent verification of the supplied artifact.",
      },
    });
    const result = await invokeRaw(["handoff", ...maintenanceArguments]);
    expect(result.code).toBe(0);
    expect(result.emissions).toBe(1);
    expect(result.text).toMatch(/^STALE: OUT-WHEEL\n/u);
    expect(result.text).toContain("INPUTS_CHANGED");
    expect(result.text).toContain(`Policy: policy.json at ${policyCommit}`);
    expect(result.text).toContain(`Subject: ${subjectCommit}`);
    expect(result.text).toContain(`Supplied artifact: ${artifactDigest}`);
    expect(result.text).toContain("Changed inputs: artifact, runtime");
    expect(result.text).toContain(
      `Verification: ${verificationDigest} on ${verifiedCommit}`,
    );
    expect(result.text).toContain(
      "Next decision for maintainer: Request independent verification of the supplied artifact.",
    );
    expect(result.text).not.toContain("completed without blockers");
  });

  it("states the failed claim and names the owner who can decide on follow-up", async () => {
    vi.mocked(maintainedOutcomeHandoff).mockResolvedValueOnce({
      ...staleOutcome,
      status: "failed",
      reason: "VERIFICATION_FAILED",
      changedInputs: [],
      verification: {
        digest: artifactDigest,
        subjectCommit,
        producedAt: "2026-10-12T12:00:00.000Z",
        result: "failed",
      },
      next: {
        action: "review-failure",
        owner: "maintainer",
        scope: "Review the failure before authorizing follow-up.",
      },
    });
    const result = await invokeRaw(["handoff", ...maintenanceArguments]);
    expect(result.code).toBe(0);
    expect(result.text).toMatch(/^FAILED: OUT-WHEEL\n/u);
    expect(result.text).toContain(
      "Claim: The published wheel installs offline.",
    );
    expect(result.text).toContain(
      "Next decision for maintainer: Review the failure before authorizing follow-up.",
    );
  });

  it("names the maintained inputs that could not be inspected", async () => {
    vi.mocked(maintainedOutcomeHandoff).mockResolvedValueOnce({
      ...staleOutcome,
      status: "unverified",
      reason: "INPUTS_UNAVAILABLE",
      changedInputs: [],
      unavailableInputs: ["runtime", "check"],
      next: {
        action: "resolve-inputs",
        owner: "maintainer",
        scope: "Supply the committed runtime and check.",
      },
    });
    const result = await invokeRaw(["handoff", ...maintenanceArguments]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("Unavailable inputs: runtime, check");
  });

  it.each([
    {
      args: ["--evidence", "proof.json"],
      code: "MAINTAINED_OUTCOME_OPTIONS_REQUIRED",
    },
    {
      args: ["--policy-commit", policyCommit],
      code: "MAINTAINED_OUTCOME_OPTIONS_REQUIRED",
    },
    {
      args: [...maintenanceArguments, "--acceptance", "owner.json"],
      code: "MAINTAINED_OUTCOME_EVIDENCE_REQUIRED",
    },
    ...["--run", "--task", "--owner-disposition"].map((option) => ({
      args: [...maintenanceArguments, option, "legacy"],
      code: "HANDOFF_MODE_CONFLICT",
    })),
  ])(
    "rejects invalid handoff mode $code before reading evidence",
    async ({ args, code }) => {
      const runCalls = vi.mocked(operatorHandoff).mock.calls.length;
      const maintenanceCalls = vi.mocked(maintainedOutcomeHandoff).mock.calls
        .length;
      const result = await invoke(["handoff", ...args]);
      expect(result.code).toBe(64);
      expect(result.emissions).toBe(1);
      expect(result.output).toMatchObject({
        ok: false,
        command: "handoff",
        reasons: [{ code }],
      });
      expect(vi.mocked(operatorHandoff).mock.calls).toHaveLength(runCalls);
      expect(vi.mocked(maintainedOutcomeHandoff).mock.calls).toHaveLength(
        maintenanceCalls,
      );
    },
  );

  it("returns a nonzero exit code with one blocker envelope after a completed failing review", async () => {
    vi.mocked(executeMaintainerReview).mockResolvedValueOnce({
      exitCode: 1,
      output: { readyToPush: false, reasonCodes: ["blocking-review"] },
    });
    const result = await invoke([
      "maintainer-review",
      "run",
      "--base",
      "a".repeat(40),
      "--head",
      "b".repeat(40),
      "--receipt",
      "/external/review.json",
      "--validation",
      '["npm","run","check"]',
      "--purpose",
      "acceptance",
    ]);
    expect(result.code).toBe(78);
    expect(result.emissions).toBe(1);
    expect(result.output).toMatchObject({
      ok: false,
      command: "maintainer-review run",
      data: { readyToPush: false },
    });
    expect(executeMaintainerReview).toHaveBeenLastCalledWith(
      result.root,
      expect.objectContaining({
        purpose: "acceptance",
        validation: ["npm", "run", "check"],
      }),
    );
  });
  it("rejects malformed validation JSON before executing a reviewer", async () => {
    const calls = vi.mocked(executeMaintainerReview).mock.calls.length;
    expect(
      (
        await invoke([
          "maintainer-review",
          "run",
          "--base",
          "a".repeat(40),
          "--head",
          "b".repeat(40),
          "--receipt",
          "/external/review.json",
          "--validation",
          "not json",
        ])
      ).code,
    ).toBe(64);
    expect(vi.mocked(executeMaintainerReview).mock.calls).toHaveLength(calls);
  });
  it.each([
    "create",
    "status",
    "replan",
    "hosted",
    "reconcile",
    "continue",
    "handoff",
  ] as const)(
    "routes retained session %s with its distinct request and approval options",
    async (mode) => {
      vi.mocked(executePreparationSession).mockResolvedValueOnce({
        exitCode: 0,
        output: { readyToPush: false },
      });
      const args = [
        "preparation-session",
        mode,
        "--session",
        "/external/session",
      ];
      if (["create", "replan", "hosted", "continue"].includes(mode))
        args.push("--request", "/external/request.json");
      if (["continue", "reconcile"].includes(mode))
        args.push("--approve", `sha256:${"a".repeat(64)}`, "--attended");
      const result = await invoke(args);
      expect(result.code).toBe(0);
      expect(result.output).toMatchObject({
        command: `preparation-session ${mode}`,
        data: { readyToPush: false },
      });
      expect(executePreparationSession).toHaveBeenLastCalledWith(
        result.root,
        expect.objectContaining({ mode, session: "/external/session" }),
      );
    },
  );
  it("routes receipt checking without a new review", async () => {
    vi.mocked(executeMaintainerReview).mockResolvedValueOnce({
      exitCode: 0,
      output: { readyToPush: true },
    });
    expect(
      (
        await invoke([
          "maintainer-review",
          "check",
          "--base",
          "a".repeat(40),
          "--head",
          "b".repeat(40),
          "--receipt",
          "/external/review.json",
        ])
      ).code,
    ).toBe(0);
    expect(executeMaintainerReview).toHaveBeenLastCalledWith(
      expect.any(String),
      {
        mode: "check",
        base: "a".repeat(40),
        head: "b".repeat(40),
        receipt: "/external/review.json",
      },
    );
  });
  it("keeps proposal, static readiness and declared artifact evidence distinct from authority", async () => {
    vi.mocked(prepareOutcome).mockResolvedValueOnce({
      authority: "draft_only",
      executionReady: false,
    } as Awaited<ReturnType<typeof prepareOutcome>>);
    expect(
      (
        await invoke([
          "init",
          "prepare",
          "--prd",
          "PRD.md",
          "--request",
          "request.yaml",
        ])
      ).output,
    ).toMatchObject({
      data: { authority: "draft_only", executionReady: false },
    });
    vi.mocked(taskReadiness).mockResolvedValueOnce({
      qualified: false,
    } as Awaited<ReturnType<typeof taskReadiness>>);
    await invoke([
      "readiness",
      "--task",
      "task.yaml",
      "--run",
      "run-id",
      "--probe-verifier",
      "--attended",
    ]);
    expect(taskReadiness).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "run-id",
        probeVerifier: true,
        attended: true,
      }),
    );
    vi.mocked(loadOperatorManifest).mockResolvedValueOnce({
      authenticated: false,
    } as Awaited<ReturnType<typeof loadOperatorManifest>>);
    await invoke(["change-evidence", "--file", "change.json"]);
    expect(loadOperatorManifest).toHaveBeenLastCalledWith(
      expect.any(String),
      "change.json",
      "change",
    );
    vi.mocked(loadOperatorManifest).mockResolvedValueOnce({
      authenticated: false,
    } as Awaited<ReturnType<typeof loadOperatorManifest>>);
    await invoke(["consumption", "inspect", "--file", "pin.json"]);
    expect(loadOperatorManifest).toHaveBeenLastCalledWith(
      expect.any(String),
      "pin.json",
      "consumption",
    );
    vi.mocked(operatorHandoff).mockResolvedValueOnce({
      schemaVersion: "1",
      recorded: false,
      authority: "read_only",
    });
    await invoke([
      "handoff",
      "--run",
      "run-id",
      "--owner-disposition",
      "owner.json",
    ]);
    expect(operatorHandoff).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "run-id",
        ownerDispositionPath: "owner.json",
      }),
    );
  });
});
