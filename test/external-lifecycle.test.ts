import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  canonicalDigest,
  canonicalJson,
  type JsonValue,
} from "../src/contracts/canonical.js";
import { StateStore } from "../src/runtime/state.js";
import { millConfigSchema } from "../src/contracts/schemas.js";
import { runtimeFixture, rewriteFixtureAuthority } from "./runtime-fixture.js";
import {
  qualifyBaseline,
  startLocalRun,
  requestExternalVerification,
  verifyRun,
  reviewRun,
  runStatus,
} from "../src/runtime/lifecycle.js";
function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("Expected nonempty test fixture");
  return item;
}

const exec = promisify(execFile);
const original = {
  state: process.env.MILL_STATE_HOME,
  codex: process.env.MILL_CODEX_PATH,
  docker: process.env.MILL_DOCKER_PATH,
};
afterEach(() => {
  for (const [name, value] of [
    ["MILL_STATE_HOME", original.state],
    ["MILL_CODEX_PATH", original.codex],
    ["MILL_DOCKER_PATH", original.docker],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});
describe("external verification in the committed-candidate lifecycle", () => {
  for (const selector of ["invariant", "scenario"] as const)
    it(`validates ${selector}-selected producers before baseline and builder spend`, async () => {
      const f = await runtimeFixture();
      process.env.MILL_STATE_HOME = f.stateHome;
      process.env.MILL_CODEX_PATH = f.codexPath;
      process.env.MILL_DOCKER_PATH = f.dockerPath;
      try {
        await rewriteFixtureAuthority(f, (c) => {
          if (selector === "invariant")
            first(c.product.invariants).verification = {
              mode: "external",
              ref: "gpu",
            };
          else {
            first(c.scenarios.scenarios).oracleOwner = "external";
            first(c.scenarios.scenarios).executionRef = "gpu";
          }
        });
        if (selector === "scenario") {
          const config = millConfigSchema.parse(
            parse(await readFile(path.join(f.root, "mill.yaml"), "utf8")),
          );
          config.externalVerifiers = {
            gpu: {
              publicKeyPem: generateKeyPairSync("x25519")
                .publicKey.export({ type: "spki", format: "pem" })
                .toString(),
              profileDigest: `sha256:${"a".repeat(64)}`,
              maxAgeSeconds: 3600,
            },
          };
          await writeFile(path.join(f.root, "mill.yaml"), stringify(config));
        }
        await expect(
          qualifyBaseline({ root: f.root, taskPath: f.taskPath }),
        ).rejects.toMatchObject({
          code:
            selector === "invariant"
              ? "EXTERNAL_VERIFIER_MISSING"
              : "INVALID_RUNTIME_CONTRACT",
        });
      } finally {
        await f.cleanup();
      }
    });
  for (const status of ["passed", "failed"] as const)
    it(`keeps pending imports committed and records signed ${status} semantic results`, async () => {
      const f = await runtimeFixture();
      process.env.MILL_STATE_HOME = f.stateHome;
      process.env.MILL_CODEX_PATH = f.codexPath;
      process.env.MILL_DOCKER_PATH = f.dockerPath;
      try {
        const key = generateKeyPairSync("ed25519");
        const { task } = await rewriteFixtureAuthority(f, (c) => {
          first(c.product.invariants).verification = {
            mode: "external",
            ref: "gpu",
          };
          first(c.scenarios.scenarios).oracleOwner = "external";
          first(c.scenarios.scenarios).executionRef = "gpu";
        });
        first(task.acceptance).evidence = {
          mode: "external",
          verifierId: "gpu",
        };
        await writeFile(path.join(f.root, f.taskPath), stringify(task));
        const config = millConfigSchema.parse(
          parse(await readFile(path.join(f.root, "mill.yaml"), "utf8")),
        );
        config.externalVerifiers = {
          gpu: {
            publicKeyPem: key.publicKey
              .export({ type: "spki", format: "pem" })
              .toString(),
            profileDigest: `sha256:${"a".repeat(64)}`,
            maxAgeSeconds: 3600,
          },
        };
        await writeFile(path.join(f.root, "mill.yaml"), stringify(config));
        await exec(process.env.MILL_GIT_PATH ?? "/usr/bin/git", ["add", "."], {
          cwd: f.root,
        });
        await exec(
          process.env.MILL_GIT_PATH ?? "/usr/bin/git",
          [
            "-c",
            "user.name=Mill External Evidence Test",
            "-c",
            "user.email=mill-external@example.invalid",
            "commit",
            "-m",
            "test: external acceptance",
          ],
          { cwd: f.root },
        );
        const baseline = await qualifyBaseline({
          root: f.root,
          taskPath: f.taskPath,
        });
        expect(baseline.approvalDigest).not.toBeNull();
        const started = await startLocalRun({
          root: f.root,
          taskPath: f.taskPath,
          approvalDigest: baseline.approvalDigest ?? "missing",
        });
        const input = {
          root: f.root,
          taskPath: f.taskPath,
          runId: started.run.id,
        };
        await expect(verifyRun(input)).rejects.toMatchObject({
          code: "EXTERNAL_VERIFICATION_REQUIRED",
        });
        expect(
          (await runStatus({ root: f.root, runId: started.run.id })).run
            ?.status,
        ).toBe("committed");
        const request = await requestExternalVerification({
          ...input,
          verifierId: "gpu",
        });
        expect(request.claims.map((c) => c.kind)).toEqual([
          "acceptance",
          "invariant",
          "scenario",
        ]);
        const content = JSON.stringify({
          evidenceClass: "synthetic_test",
          status,
        });
        const payload = {
          request,
          producedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          runtimeManifest: { device: "fake-fixture", engine: "fake-test-only" },
          claims: request.claims.map((c) => ({
            ...c,
            status,
            report: "result.json",
          })),
          reports: [
            {
              name: "result.json",
              digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
              content,
            },
          ],
        };
        const receipt = {
          payload,
          signature: sign(
            null,
            Buffer.from(canonicalJson(payload as unknown as JsonValue)),
            key.privateKey,
          ).toString("base64"),
        };
        const file = path.join(f.stateHome, "receipt.json");
        await writeFile(
          file,
          JSON.stringify({ ...receipt, signature: "A".repeat(86) + "==" }),
        );
        await expect(
          verifyRun({ ...input, externalReceiptPaths: [file] }),
        ).rejects.toMatchObject({ code: "EXTERNAL_EVIDENCE_INVALID" });
        await writeFile(file, JSON.stringify(receipt));
        if (status === "passed") {
          const clearActiveProcess = Reflect.get(
            StateStore.prototype,
            "clearActiveProcess",
          );
          const clock = vi.spyOn(Date, "now");
          const exit = vi
            .spyOn(StateStore.prototype, "clearActiveProcess")
            .mockImplementation(function (this: StateStore, runId, processId) {
              clearActiveProcess.call(this, runId, processId);
              clock.mockReturnValue(Date.parse(payload.expiresAt));
            });
          try {
            await expect(
              verifyRun({ ...input, externalReceiptPaths: [file] }),
            ).rejects.toMatchObject({ code: "EXTERNAL_EVIDENCE_EXPIRED" });
            expect(exit).toHaveBeenCalled();
            expect((await runStatus(input)).run?.status).toBe("committed");
          } finally {
            exit.mockRestore();
            clock.mockRestore();
          }
        }
        const verified = await verifyRun({
          ...input,
          externalReceiptPaths: [file],
        });
        expect(verified.evidence.semantic?.passed).toBe(status === "passed");
        expect(
          first(verified.evidence.externalReceipts ?? []).receiptDigest,
        ).toBe(canonicalDigest(receipt as unknown as JsonValue));
        if (status === "passed")
          expect((await reviewRun(input)).run.status).toBe("reviewed");
        else {
          expect(verified.run.status).toBe("blocked");
          await expect(reviewRun(input)).rejects.toThrow();
        }
      } finally {
        await f.cleanup();
      }
    });
});
