import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { developmentEvidenceSummary } from "../src/runtime/development-evidence.js";
import { runtimeFixture } from "./runtime-fixture.js";
import { createHash } from "node:crypto";

describe("development evidence ledger", () => {
  it("binds whole-change evidence by stable ID and bytes without adding usage twice", async () => {
    const fixture = await runtimeFixture();
    try {
      const source = JSON.stringify({
        schemaVersion: "1",
        changeId: "CHANGE-TEST",
        measurements: [
          {
            id: "review",
            kind: "native",
            candidateCommit: "a".repeat(40),
            evidenceDigest: `sha256:${"b".repeat(64)}`,
            source: "measured",
            inputTokens: 100,
            outputTokens: 10,
            cacheInputTokens: 80,
          },
        ],
        effort: {
          preparationMinutes: null,
          reviewMinutes: null,
          repairMinutes: null,
        },
        hostedRequests: null,
      });
      const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
      await writeFile(path.join(fixture.root, "change.json"), source);
      const ledger = (id = "CHANGE-TEST") =>
        JSON.stringify({
          schemaVersion: "1",
          records: [
            {
              id,
              change: "Native repair",
              eligibility: { status: "eligible" },
              route: { kind: "manual", reason: "Maintainer control change" },
              outcome: "in_progress",
              effort: {
                preparationMinutes: null,
                reviewMinutes: null,
                repairMinutes: null,
              },
              elapsedMinutes: null,
              repairs: 0,
              providerUsage: {
                inputTokens: 100,
                outputTokens: 10,
                cost: null,
                currency: null,
              },
              changeEvidence: { path: "change.json", digest },
            },
          ],
        });
      await writeFile(path.join(fixture.root, "ledger.json"), ledger());
      expect(
        await developmentEvidenceSummary({
          root: fixture.root,
          ledgerPath: "ledger.json",
        }),
      ).toMatchObject({
        changes: [
          {
            changeId: "CHANGE-TEST",
            usage: { totalTokens: 110, cacheInputTokens: 80 },
          },
        ],
        providerUsage: { inputTokens: 100, outputTokens: 10 },
      });
      await writeFile(
        path.join(fixture.root, "ledger.json"),
        ledger("ANOTHER-ID"),
      );
      await expect(
        developmentEvidenceSummary({
          root: fixture.root,
          ledgerPath: "ledger.json",
        }),
      ).rejects.toMatchObject({ code: "CHANGE_EVIDENCE_ID_MISMATCH" });
      await writeFile(path.join(fixture.root, "ledger.json"), ledger());
      await writeFile(path.join(fixture.root, "change.json"), `${source}\n`);
      await expect(
        developmentEvidenceSummary({
          root: fixture.root,
          ledgerPath: "ledger.json",
        }),
      ).rejects.toMatchObject({ code: "CHANGE_EVIDENCE_STALE" });
    } finally {
      await fixture.cleanup();
    }
  });
  it("uses the declared eligible-change denominator and leaves partial measurements unavailable", async () => {
    const fixture = await runtimeFixture();
    try {
      await mkdir(path.join(fixture.root, "quality"), { recursive: true });
      await writeFile(
        path.join(fixture.root, "quality", "ledger.yaml"),
        `schemaVersion: "1"
records:
  - id: eligible-through-mill
    change: A completed compatible change
    eligibility: { status: eligible }
    route: { kind: mill }
    outcome: accepted
    effort: { preparationMinutes: 2, reviewMinutes: 3, repairMinutes: 0 }
    elapsedMinutes: 12
    repairs: 0
    providerUsage: { inputTokens: 10, outputTokens: 4, cost: 0.02, currency: USD }
  - id: eligible-manual
    change: A compatible change outside Mill
    eligibility: { status: eligible }
    route: { kind: manual, reason: OCI runtime unavailable }
    outcome: not_accepted
    effort: { preparationMinutes: null, reviewMinutes: 5, repairMinutes: null }
    elapsedMinutes: null
    repairs: 1
  - id: excluded-docs
    change: A documentation-only correction
    eligibility: { status: excluded, reason: No approved task boundary }
    route: { kind: manual, reason: Excluded from the trial }
    outcome: accepted
    effort: { preparationMinutes: 1, reviewMinutes: 1, repairMinutes: 0 }
    elapsedMinutes: 2
    repairs: 0
`,
      );
      await expect(
        developmentEvidenceSummary({
          root: fixture.root,
          ledgerPath: "quality/ledger.yaml",
        }),
      ).resolves.toEqual({
        ledgerPath: "quality/ledger.yaml",
        records: 3,
        eligibleChanges: 2,
        eligibleMillRoute: 1,
        eligibleManualRoute: 1,
        eligibleCompleted: 2,
        eligibleAccepted: 1,
        effort: {
          preparationMinutes: null,
          reviewMinutes: 8,
          repairMinutes: null,
        },
        elapsedMinutes: null,
        providerUsage: {
          inputTokens: null,
          outputTokens: null,
          cost: null,
          currency: null,
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a ledger whose records have duplicate identities", async () => {
    const fixture = await runtimeFixture();
    try {
      await mkdir(path.join(fixture.root, "quality"), { recursive: true });
      await writeFile(
        path.join(fixture.root, "quality", "ledger.yaml"),
        `schemaVersion: "1"
records:
  - id: duplicate
    change: First
    eligibility: { status: eligible }
    route: { kind: mill }
    outcome: accepted
    effort: { preparationMinutes: 1, reviewMinutes: 1, repairMinutes: 0 }
    elapsedMinutes: 2
    repairs: 0
  - id: duplicate
    change: Second
    eligibility: { status: eligible }
    route: { kind: mill }
    outcome: accepted
    effort: { preparationMinutes: 1, reviewMinutes: 1, repairMinutes: 0 }
    elapsedMinutes: 2
    repairs: 0
`,
      );
      await expect(
        developmentEvidenceSummary({
          root: fixture.root,
          ledgerPath: "quality/ledger.yaml",
        }),
      ).rejects.toMatchObject({ code: "DEVELOPMENT_EVIDENCE_LEDGER_INVALID" });
    } finally {
      await fixture.cleanup();
    }
  });
});
