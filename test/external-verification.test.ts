import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, type JsonValue } from "../src/contracts/canonical.js";
import { externalVerifierSchema } from "../src/contracts/external-verification.js";
import {
  externalReceiptFilename,
  validateExternalVerificationRequirements,
  verifyExternalReceipt,
} from "../src/runtime/external-verification.js";

import { loadRuntimeInputs } from "../src/runtime/inputs.js";
import { runtimeFixture } from "./runtime-fixture.js";

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("Expected nonempty test fixture");
  return item;
}

const pair = generateKeyPairSync("ed25519");
const request = {
  schemaVersion: "1" as const,
  repositoryId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  candidateCommit: "a".repeat(40),
  candidateTree: "b".repeat(40),
  taskDigest: `sha256:${"c".repeat(64)}`,
  configDigest: `sha256:${"d".repeat(64)}`,
  verifierId: "gpu",
  profileDigest: `sha256:${"e".repeat(64)}`,
  claims: [
    {
      kind: "scenario" as const,
      id: "SC-GPU",
      digest: `sha256:${"f".repeat(64)}`,
    },
    {
      kind: "acceptance" as const,
      id: "AC-GPU",
      digest: `sha256:${"a".repeat(64)}`,
    },
  ],
};
const config = {
  publicKeyPem: pair.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
  profileDigest: request.profileDigest,
  maxAgeSeconds: 3600,
};
const now = new Date("2026-10-12T12:00:00Z");
function receipt(
  change: (payload: Record<string, unknown>) => void = () => undefined,
) {
  const content = '{"test":"gpu accounting","status":"passed"}';
  const payload = {
    request: structuredClone(request),
    producedAt: "2026-10-12T11:59:00Z",
    expiresAt: "2026-10-12T12:59:00Z",
    runtimeManifest: {
      gpu: "synthetic-test-device",
      driver: "fixture",
      model: "sha256:fixture",
    },
    claims: request.claims.map((claim) => ({
      ...claim,
      status: "passed",
      report: "result.json",
    })),
    reports: [
      { name: "result.json", digest: `sha256:${"0".repeat(64)}`, content },
    ],
  };
  // Reports have byte digests, distinct from canonical-object digests.
  first(payload.reports).digest =
    `sha256:${createHash("sha256").update(content).digest("hex")}`;
  change(payload);
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload as unknown as JsonValue)),
      pair.privateKey,
    ).toString("base64"),
  };
}
describe("external producer receipts", () => {
  it("rejects private and combined PEM inputs at configuration and verification boundaries", () => {
    const privatePem = pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const body = privatePem.split("\n")[1];
    if (body === undefined) throw new Error("Unexpected fixture key format");
    for (const publicKeyPem of [privatePem, config.publicKeyPem + privatePem]) {
      const verifier = { ...config, publicKeyPem };
      const invalid = externalVerifierSchema.safeParse(verifier);
      expect(invalid.success).toBe(false);
      if (!invalid.success)
        expect(JSON.stringify(invalid.error.issues)).not.toContain(body);
      expect(() =>
        verifyExternalReceipt({ receipt: receipt(), request, verifier, now }),
      ).toThrow("exactly one Ed25519 public SPKI PEM");
    }
  });

  it("keeps producer filenames distinct on case-insensitive filesystems", () => {
    const lower = externalReceiptFilename("gpu");
    const upper = externalReceiptFilename("GPU");
    expect(lower).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect(lower.toLowerCase()).not.toBe(upper.toLowerCase());
  });

  it("requires valid signatures and exact candidate/run/profile/claim coverage", () => {
    const valid = receipt();
    expect(
      verifyExternalReceipt({ receipt: valid, request, verifier: config, now })
        .claims[0]?.status,
    ).toBe("passed");
    expect(() =>
      verifyExternalReceipt({
        receipt: { ...valid, signature: "A".repeat(86) + "==" },
        request,
        verifier: config,
        now,
      }),
    ).toThrow();
    for (const field of [
      "candidateCommit",
      "candidateTree",
      "runId",
      "taskDigest",
      "configDigest",
      "profileDigest",
    ]) {
      const wrong = receipt((p) => {
        const r = p.request as Record<string, unknown>;
        r[field] = field.endsWith("Digest")
          ? `sha256:${"1".repeat(64)}`
          : field === "runId"
            ? "33333333-3333-4333-8333-333333333333"
            : "1".repeat(40);
      });
      expect(() =>
        verifyExternalReceipt({
          receipt: wrong,
          request,
          verifier: config,
          now,
        }),
      ).toThrow();
    }
  });
  it("rejects expired, future, incomplete, duplicate and tampered report evidence", () => {
    for (const change of [
      (p: Record<string, unknown>) => {
        p.expiresAt = "2026-10-12T11:59:30Z";
      },
      (p: Record<string, unknown>) => {
        p.producedAt = "2026-10-12T12:00:01Z";
      },
      (p: Record<string, unknown>) => {
        const claims = p.claims as unknown[];
        claims.push(claims[0]);
      },
      (p: Record<string, unknown>) => {
        const reports = p.reports as { content: string }[];
        first(reports).content = "changed";
      },
    ])
      expect(() =>
        verifyExternalReceipt({
          receipt: receipt(change),
          request,
          verifier: config,
          now,
        }),
      ).toThrow();
  });
  it("rejects a signed and schema-valid result missing one of two claims", () => {
    const partial = receipt((p) => {
      (p.claims as unknown[]).pop();
    });
    expect(() =>
      verifyExternalReceipt({
        receipt: partial,
        request,
        verifier: config,
        now,
      }),
    ).toThrow("Required external claims are missing.");
  });

  it("retains producer failure as failure rather than treating a signature as a pass", () => {
    const failed = receipt((p) => {
      first(p.claims as { status: string }[]).status = "failed";
    });
    expect(
      verifyExternalReceipt({ receipt: failed, request, verifier: config, now })
        .claims[0]?.status,
    ).toBe("failed");
  });
});

it("enforces request identifier, claim count, and producer limits at admission", async () => {
  const fixture = await runtimeFixture();
  try {
    const inputs = await loadRuntimeInputs(fixture.root, fixture.taskPath);
    if (inputs.task.schemaVersion !== "2")
      throw new Error("Expected version 2 task");
    const acceptance = first(inputs.task.acceptance);
    const task = inputs.task;
    const generated = (count: number, separate: boolean) => {
      task.acceptance = Array.from({ length: count }, (_, index) => ({
        ...acceptance,
        id: `AC-${index}`,
        evidence: {
          mode: "external",
          verifierId: separate ? `worker-${index}` : "worker-0",
        },
      }));
      inputs.config.externalVerifiers = Object.fromEntries(
        Array.from({ length: separate ? count : 1 }, (_, index) => [
          `worker-${index}`,
          config,
        ]),
      );
    };
    for (const [limit, separate] of [
      [512, false],
      [32, true],
    ] as const) {
      generated(limit, separate);
      expect(() =>
        validateExternalVerificationRequirements(inputs),
      ).not.toThrow();
      generated(limit + 1, separate);
      expect(() => validateExternalVerificationRequirements(inputs)).toThrow(
        expect.objectContaining({ code: "EXTERNAL_REQUIREMENTS_INVALID" }),
      );
    }
    generated(1, false);
    first(task.acceptance).id = "request cannot encode this ID";
    expect(() => validateExternalVerificationRequirements(inputs)).toThrow(
      expect.objectContaining({ code: "EXTERNAL_REQUIREMENTS_INVALID" }),
    );
  } finally {
    await fixture.cleanup();
  }
});
