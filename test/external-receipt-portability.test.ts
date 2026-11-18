import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { externalVerificationReceiptSchema } from "../src/contracts/external-verification.js";
import { verifyExternalReceipt } from "../src/runtime/external-verification.js";

it("verifies the independently serialized Python/OpenSSL receipt", async () => {
  const fixture = new URL("./fixtures/external-receipt/", import.meta.url);
  const receipt = externalVerificationReceiptSchema.parse(
    JSON.parse(await readFile(new URL("receipt.json", fixture), "utf8")),
  );
  const input = {
    receipt,
    request: receipt.payload.request,
    verifier: {
      publicKeyPem: await readFile(new URL("public.pem", fixture), "utf8"),
      profileDigest: receipt.payload.request.profileDigest,
      maxAgeSeconds: 3600,
    },
    now: new Date("2026-11-18T12:30:00Z"),
  };
  expect(verifyExternalReceipt(input).claims).toMatchObject([
    { id: "AC-PORTABLE", kind: "acceptance", status: "passed" },
  ]);
  const [report] = receipt.payload.reports;
  if (report === undefined)
    throw new Error("The fixture must contain a report.");
  report.content += " changed";
  expect(() => verifyExternalReceipt(input)).toThrow();
});
