import path from "node:path";
import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  executeMaintainerReview,
  executePreparationSession,
} from "../src/planning/review-session.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

function response(exitCode: number, stdout: string, stderr = "") {
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    callback(
      exitCode
        ? Object.assign(new Error("Script failed"), { code: exitCode })
        : null,
      stdout,
      stderr,
    );
    return {} as ReturnType<typeof execFile>;
  });
}

describe("packaged preparation operations", () => {
  it("uses package-owned scripts and fixed argv without a shell", async () => {
    response(0, '{"readyToPush":false}\n');
    await executePreparationSession("/operator/repository", {
      mode: "continue",
      session: "/external/session",
      request: "/external/request.json",
      approve: `sha256:${"a".repeat(64)}`,
      attended: true,
    });
    const call = vi.mocked(execFile).mock.calls.at(-1);
    expect(call?.[0]).toBe(process.execPath);
    expect(call?.[1]).toEqual([
      path.resolve(import.meta.dirname, "../scripts/review-session.mjs"),
      "continue",
      "--session",
      "/external/session",
      "--request",
      "/external/request.json",
      "--approve",
      `sha256:${"a".repeat(64)}`,
      "--attended",
    ]);
    expect(call?.[2]).toMatchObject({
      cwd: "/operator/repository",
      encoding: "utf8",
    });
    expect(call?.[2]).not.toHaveProperty("shell");
  });
  it("preserves nonzero completed review output instead of losing blocker evidence", async () => {
    response(
      1,
      '{"purpose":"candidate","readyToPush":false,"reasonCodes":["blocking-review"]}\n',
    );
    expect(
      await executeMaintainerReview("/operator/repository", {
        mode: "run",
        base: "a".repeat(40),
        head: "b".repeat(40),
        receipt: "/external/receipt.json",
        validation: ["npm", "run", "check"],
        purpose: "candidate",
      }),
    ).toMatchObject({
      exitCode: 1,
      output: { readyToPush: false, reasonCodes: ["blocking-review"] },
    });
    expect(vi.mocked(execFile).mock.calls.at(-1)?.[1]).toContain(
      '["npm","run","check"]',
    );
  });
  it("propagates a failed operation reason and refuses malformed output", async () => {
    response(1, "", "Session blocked: incomplete-attempt\n");
    await expect(
      executePreparationSession("/operator/repository", {
        mode: "status",
        session: "/external/session",
      }),
    ).rejects.toThrow("incomplete-attempt");
    response(0, "[]\n");
    await expect(
      executePreparationSession("/operator/repository", {
        mode: "status",
        session: "/external/session",
      }),
    ).rejects.toThrow("Malformed");
  });
  it("rejects unsupported flags and modes before spawning a process", async () => {
    const count = vi.mocked(execFile).mock.calls.length;
    await expect(
      executePreparationSession("/operator/repository", {
        mode: "purge" as "status",
        session: "/external/session",
      }),
    ).rejects.toThrow("mode");
    await expect(
      executePreparationSession("/operator/repository", {
        mode: "status",
        session: "/external/session",
        approve: "sha256:bad",
        attended: true,
      }),
    ).rejects.toThrow("approval");
    expect(vi.mocked(execFile).mock.calls).toHaveLength(count);
  });
});
