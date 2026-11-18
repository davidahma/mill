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

async function invoke(args: string[]) {
  const directory = await temporaryDirectory("mill-operations-cli-");
  const stdout: string[] = [];
  try {
    const code = await runCli(["--json", "--cwd", directory.path, ...args], {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: () => undefined },
    });
    return {
      code,
      root: directory.path,
      output: JSON.parse(stdout.join("")) as Record<string, unknown>,
      emissions: stdout.length,
    };
  } finally {
    await directory.cleanup();
  }
}

describe("operator CLI boundaries", () => {
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
