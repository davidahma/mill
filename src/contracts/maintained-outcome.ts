import { ed25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";

import {
  decodeExternalPublicKey,
  externalPublicKeyPemPattern,
} from "./external-verification.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const claimText = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}\p{Bidi_Control}\u2028\u2029]+$/u);
export const maintainedOutcomePathSchema = z
  .string()
  .max(512)
  .regex(
    /^(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+\/)*(?!\.{1,2}$)[A-Za-z0-9._-]+$/u,
  );

const publicKey = z
  .string()
  .max(4096)
  .regex(externalPublicKeyPemPattern)
  .refine((pem) => {
    const key = decodeExternalPublicKey(pem);
    if (key === undefined) return false;
    try {
      const { x } = key.export({ format: "jwk" });
      if (x === undefined) return false;
      const point = ed25519.Point.fromBytes(Buffer.from(x, "base64url"), false);
      return !point.isSmallOrder() && point.isTorsionFree();
    } catch {
      return false;
    }
  }, "Expected a canonical Ed25519 SPKI key with a nonidentity prime-order point.");

export const maintainedOutcomePolicySchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    outcomeId: identifier,
    claim: claimText,
    owner: identifier,
    reuseScope: z.literal("immutable-inputs"),
    runtimePath: maintainedOutcomePathSchema,
    checkPath: maintainedOutcomePathSchema,
    verifierPublicKeyPem: publicKey,
    ownerPublicKeyPem: publicKey,
    maxAgeSeconds: z.number().int().min(1).max(86400),
  })
  .refine(
    (policy) =>
      policy.verifierPublicKeyPem.replace(/\s/gu, "") !==
        policy.ownerPublicKeyPem.replace(/\s/gu, "") &&
      policy.runtimePath !== policy.checkPath,
    "Use separate verifier and owner keys and separate runtime and check files.",
  );

const verificationInputsSchema = z.strictObject({
  artifactDigest: digestSchema,
  runtimeDigest: digestSchema,
  checkDigest: digestSchema,
  checkMode: z.enum(["100644", "100755"]),
});

export const maintainedOutcomeRequestSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  outcomeId: identifier,
  policyPath: maintainedOutcomePathSchema,
  policyCommit: commitSchema,
  policyDigest: digestSchema,
  subjectCommit: commitSchema,
  inputs: verificationInputsSchema,
});

const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/u);
const evidenceTimestamp = z.iso.datetime({ precision: 3 });
export const maintainedOutcomeVerificationSchema = z.strictObject({
  payload: z.strictObject({
    kind: z.literal("maintained-outcome-verification"),
    request: maintainedOutcomeRequestSchema,
    producedAt: evidenceTimestamp,
    result: z.enum(["passed", "failed"]),
  }),
  signature,
});

export const maintainedOutcomeAcceptanceSchema = z.strictObject({
  payload: z.strictObject({
    schemaVersion: z.literal("1"),
    kind: z.literal("maintained-outcome-acceptance"),
    outcomeId: identifier,
    policyPath: maintainedOutcomePathSchema,
    policyCommit: commitSchema,
    policyDigest: digestSchema,
    subjectCommit: commitSchema,
    verificationDigest: digestSchema,
    acceptedAt: evidenceTimestamp,
  }),
  signature,
});

export const maintainedOutcomeHandoffSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  outcomeId: identifier,
  claim: claimText,
  owner: identifier,
  policyPath: maintainedOutcomePathSchema,
  policyCommit: commitSchema,
  policyDigest: digestSchema,
  subjectCommit: commitSchema,
  artifactDigest: digestSchema,
  request: maintainedOutcomeRequestSchema.nullable(),
  evidenceScope: z.literal("supplied-artifact-digest-and-selected-records"),
  status: z.enum(["current", "stale", "failed", "unverified"]),
  reason: z.enum([
    "POLICY_CHANGED",
    "INPUTS_UNAVAILABLE",
    "VERIFICATION_MISSING",
    "VERIFICATION_INVALID",
    "VERIFICATION_NOT_APPLICABLE",
    "INPUTS_CHANGED",
    "VERIFICATION_EXPIRED",
    "VERIFICATION_FAILED",
    "VERIFICATION_PASSED",
  ]),
  changedInputs: z.array(z.enum(["policy", "artifact", "runtime", "check"])),
  unavailableInputs: z.array(z.enum(["runtime", "check"])),
  verification: z
    .strictObject({
      digest: digestSchema,
      subjectCommit: commitSchema,
      producedAt: evidenceTimestamp,
      result: z.enum(["passed", "failed"]),
    })
    .nullable(),
  ownerAcceptance: z.enum(["accepted", "not_recorded", "stale", "invalid"]),
  next: z.strictObject({
    action: z.enum([
      "select-policy",
      "resolve-inputs",
      "verify",
      "review-failure",
      "accept",
      "none",
    ]),
    owner: identifier,
    scope: z.string().min(1).max(256),
  }),
  authorizationGranted: z.literal(false),
});

export type MaintainedOutcomePolicy = z.infer<
  typeof maintainedOutcomePolicySchema
>;
export type MaintainedOutcomeRequest = z.infer<
  typeof maintainedOutcomeRequestSchema
>;
export type MaintainedOutcomeVerification = z.infer<
  typeof maintainedOutcomeVerificationSchema
>;
export type MaintainedOutcomeAcceptance = z.infer<
  typeof maintainedOutcomeAcceptanceSchema
>;
export type MaintainedOutcomeHandoff = z.infer<
  typeof maintainedOutcomeHandoffSchema
>;
