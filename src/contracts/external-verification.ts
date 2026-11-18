import { createPublicKey } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitId = z.string().regex(/^[a-f0-9]{40}$/u);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
export const maxExternalReceipts = 32;
export const externalPublicKeyPemPattern =
  /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----(?:\r?\n)?$/u;
export function decodeExternalPublicKey(pem: string) {
  if (pem.length > 4096 || !externalPublicKeyPemPattern.test(pem))
    return undefined;
  const encoded = pem
    .split(/\r?\n/u)
    .slice(1)
    .filter((line) => line !== "-----END PUBLIC KEY-----")
    .join("");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return undefined;
  try {
    const publicKey = createPublicKey({
      key: bytes,
      format: "der",
      type: "spki",
    });
    if (
      publicKey.asymmetricKeyType === "ed25519" &&
      publicKey.export({ format: "der", type: "spki" }).equals(bytes)
    )
      return publicKey;
  } catch {
    // Invalid key encodings must never include their source in the diagnostic.
  }
  return undefined;
}

export const externalVerifierSchema = z.strictObject({
  publicKeyPem: z
    .string()
    .min(32)
    .max(4096)
    .regex(externalPublicKeyPemPattern)
    .refine(
      (pem) => decodeExternalPublicKey(pem) !== undefined,
      "Expected exactly one Ed25519 public SPKI PEM.",
    ),
  profileDigest: digest,
  maxAgeSeconds: z.number().int().min(1).max(86400),
});
const claim = z.strictObject({
  kind: z.enum(["acceptance", "invariant", "scenario"]),
  id: identifier,
  digest,
});
const maxExternalClaims = 512;
export const externalVerificationClaimsSchema = z
  .array(claim)
  .min(1)
  .max(maxExternalClaims);
export const externalVerificationRequestSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  repositoryId: z.uuid(),
  runId: z.uuid(),
  candidateCommit: gitId,
  candidateTree: gitId,
  taskDigest: digest,
  configDigest: digest,
  verifierId: identifier,
  profileDigest: digest,
  claims: externalVerificationClaimsSchema,
});
export const externalVerificationReceiptSchema = z.strictObject({
  payload: z.strictObject({
    request: externalVerificationRequestSchema,
    producedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    runtimeManifest: z.record(
      z.string().min(1).max(128),
      z.string().min(1).max(4096),
    ),
    claims: z
      .array(
        claim.extend({
          status: z.enum(["passed", "failed", "blocked"]),
          report: identifier,
        }),
      )
      .min(1)
      .max(maxExternalClaims),
    reports: z
      .array(
        z.strictObject({
          name: identifier,
          digest,
          content: z.string().max(1_000_000),
        }),
      )
      .min(1)
      .max(32),
  }),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
});

export type ExternalVerificationRequest = z.infer<
  typeof externalVerificationRequestSchema
>;
export interface ExternalClaimEvidence {
  verifierId: string;
  kind: "acceptance" | "invariant" | "scenario";
  id: string;
  digest: string;
  status: "passed" | "failed" | "blocked";
  evidenceRef: string;
}
