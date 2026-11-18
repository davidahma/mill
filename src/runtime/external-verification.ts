import { createHash, verify } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  canonicalDigest,
  canonicalJson,
  type JsonValue,
} from "../contracts/canonical.js";
import {
  decodeExternalPublicKey,
  externalVerificationClaimsSchema,
  externalVerificationReceiptSchema,
  externalVerificationRequestSchema,
  maxExternalReceipts,
  type ExternalClaimEvidence,
  type ExternalVerificationRequest,
} from "../contracts/external-verification.js";
import { semanticClaimDigest } from "../planning/impact.js";
import { ExitCode, MillError } from "../errors.js";
import type { RuntimeInputs } from "./inputs.js";

function reject(message: string): never {
  throw new MillError(
    "EXTERNAL_EVIDENCE_INVALID",
    message,
    ExitCode.configuration,
  );
}
type ExternalRequirements = Pick<
  RuntimeInputs,
  "task" | "config" | "continuity"
>;
type Claims = ExternalVerificationRequest["claims"];

function externalVerificationClaims(input: ExternalRequirements) {
  const byVerifier = new Map<string, Claims>();
  const add = (verifierId: string, claim: Claims[number]) => {
    const claims = byVerifier.get(verifierId);
    if (claims === undefined) byVerifier.set(verifierId, [claim]);
    else claims.push(claim);
  };
  if (input.task.schemaVersion !== "2") return byVerifier;

  for (const item of input.task.acceptance) {
    if (item.evidence.mode === "external")
      add(item.evidence.verifierId, {
        kind: "acceptance",
        id: item.id,
        digest: semanticClaimDigest("acceptance", item.id, item),
      });
  }
  const continuity = input.continuity;
  if (continuity === undefined) return byVerifier;
  const affectedInvariantIds = new Set(continuity.impact.affectedInvariantIds);
  for (const item of continuity.product.invariants) {
    if (
      affectedInvariantIds.has(item.id) &&
      item.verification.mode === "external"
    )
      add(item.verification.ref, {
        kind: "invariant",
        id: item.id,
        digest: semanticClaimDigest("invariant", item.id, item),
      });
  }
  const scenarioIds = new Set(continuity.impact.scenarioIds);
  for (const item of continuity.scenarios.scenarios) {
    if (
      scenarioIds.has(item.id) &&
      item.oracleOwner === "external" &&
      item.executionRef !== undefined &&
      Object.hasOwn(input.config.externalVerifiers ?? {}, item.executionRef)
    )
      add(item.executionRef, {
        kind: "scenario",
        id: item.id,
        digest: semanticClaimDigest(
          "scenario",
          item.id,
          item as unknown as JsonValue,
        ),
      });
  }
  return byVerifier;
}

export function requiredExternalVerifierIds(input: ExternalRequirements) {
  return new Set(externalVerificationClaims(input).keys());
}

function externalPublicKey(pem: string) {
  const key = decodeExternalPublicKey(pem);
  if (key !== undefined) return key;
  throw new MillError(
    "EXTERNAL_PUBLIC_KEY_INVALID",
    "An external producer must use exactly one Ed25519 public SPKI PEM.",
    ExitCode.configuration,
  );
}

export function validateExternalVerificationRequirements(
  input: ExternalRequirements,
) {
  const byVerifier = externalVerificationClaims(input);
  if (byVerifier.size > maxExternalReceipts)
    throw new MillError(
      "EXTERNAL_REQUIREMENTS_INVALID",
      "A task selects more external producers than a verification attempt can import.",
      ExitCode.configuration,
      { maxExternalReceipts },
    );
  for (const [verifierId, verifier] of Object.entries(
    input.config.externalVerifiers ?? {},
  )) {
    if (decodeExternalPublicKey(verifier.publicKeyPem) === undefined)
      throw new MillError(
        "EXTERNAL_PUBLIC_KEY_INVALID",
        "A configured external producer needs exactly one Ed25519 public SPKI PEM.",
        ExitCode.configuration,
        { verifierId },
      );
  }
  for (const [verifierId, claims] of byVerifier) {
    if (!Object.hasOwn(input.config.externalVerifiers ?? {}, verifierId))
      throw new MillError(
        "EXTERNAL_VERIFIER_MISSING",
        "Every required external producer needs a frozen Ed25519 key and profile before admission.",
        ExitCode.configuration,
        { verifierId },
      );
    if (
      input.continuity === undefined ||
      !externalVerificationClaimsSchema.safeParse(claims).success ||
      new Set(claims.map(({ kind, id }) => `${kind}:${id}`)).size !==
        claims.length
    )
      throw new MillError(
        "EXTERNAL_REQUIREMENTS_INVALID",
        "External claims must use distinct supported identifiers and fit the receipt request limits.",
        ExitCode.configuration,
        { verifierId, claimCount: claims.length },
      );
  }
}

export function externalVerificationRequest(input: {
  inputs: RuntimeInputs;
  runId: string;
  candidateCommit: string;
  candidateTree: string;
  verifierId: string;
}): ExternalVerificationRequest {
  const { inputs } = input;
  const verifier = inputs.config.externalVerifiers?.[input.verifierId];
  const claims = externalVerificationClaims(inputs).get(input.verifierId);
  if (
    verifier === undefined ||
    inputs.continuity === undefined ||
    claims === undefined
  )
    reject(
      "An approved external verifier with selected claims and a continuity contract is required.",
    );
  claims.sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`, "en"),
  );
  return externalVerificationRequestSchema.parse({
    schemaVersion: "1",
    repositoryId: inputs.config.repositoryId,
    runId: input.runId,
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    taskDigest: inputs.taskDigest,
    configDigest: inputs.configDigest,
    verifierId: input.verifierId,
    profileDigest: verifier.profileDigest,
    claims,
  });
}

export function verifyExternalReceipt(input: {
  receipt: unknown;
  request: ExternalVerificationRequest;
  verifier: {
    publicKeyPem: string;
    profileDigest: string;
    maxAgeSeconds: number;
  };
  now?: Date;
}) {
  const parsed = externalVerificationReceiptSchema.safeParse(input.receipt);
  if (!parsed.success) reject("Receipt structure is invalid.");
  const receipt = parsed.data;
  const key = externalPublicKey(input.verifier.publicKeyPem);
  if (
    !verify(
      null,
      Buffer.from(canonicalJson(receipt.payload)),
      key,
      Buffer.from(receipt.signature, "base64"),
    )
  )
    reject("The external producer signature is invalid.");
  if (
    canonicalDigest(receipt.payload.request) !==
      canonicalDigest(input.request) ||
    receipt.payload.request.profileDigest !== input.verifier.profileDigest
  )
    reject(
      "External evidence belongs to a different request, candidate, authority or profile.",
    );
  const now = (input.now ?? new Date()).getTime();
  const start = Date.parse(receipt.payload.producedAt),
    end = Date.parse(receipt.payload.expiresAt);
  if (
    start > now ||
    end <= now ||
    end <= start ||
    now - start > input.verifier.maxAgeSeconds * 1000 ||
    end - start > input.verifier.maxAgeSeconds * 1000
  )
    reject("External evidence is future-dated or expired.");
  if (
    Object.keys(receipt.payload.runtimeManifest).length === 0 ||
    Object.keys(receipt.payload.runtimeManifest).length > 64
  )
    reject("A bounded actual runtime manifest is required.");
  const expected = new Map(
    input.request.claims.map((x) => [`${x.kind}:${x.id}`, x.digest]),
  );
  const seen = new Set<string>();
  const reports = new Set<string>();
  for (const report of receipt.payload.reports) {
    if (
      reports.has(report.name) ||
      `sha256:${createHash("sha256").update(report.content).digest("hex")}` !==
        report.digest
    )
      reject("A report is duplicated or its bytes differ from its digest.");
    reports.add(report.name);
  }
  const receiptDigest = canonicalDigest(receipt);
  const claims: ExternalClaimEvidence[] = receipt.payload.claims.map(
    (claim) => {
      const id = `${claim.kind}:${claim.id}`;
      if (
        seen.has(id) ||
        expected.get(id) !== claim.digest ||
        !reports.has(claim.report)
      )
        reject("External claim coverage or report linkage is invalid.");
      seen.add(id);
      return {
        verifierId: input.request.verifierId,
        kind: claim.kind,
        id: claim.id,
        digest: claim.digest,
        status: claim.status,
        evidenceRef: `external:${input.request.verifierId}:${receiptDigest}:${id}`,
      };
    },
  );
  if (seen.size !== expected.size)
    reject("Required external claims are missing.");
  return { receipt, receiptDigest, claims };
}

export function assertExternalEvidenceFresh(deadlineMs: number): void {
  if (Date.now() >= deadlineMs)
    throw new MillError(
      "EXTERNAL_EVIDENCE_EXPIRED",
      "The required signed external evidence expired before this step could finish.",
      ExitCode.configuration,
    );
}

export function externalReceiptFilename(verifierId: string): string {
  return `${createHash("sha256").update(verifierId).digest("hex")}.json`;
}

export async function readExternalReceipt(file: string): Promise<unknown> {
  try {
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
        reject("Receipt must be a regular file no larger than 4 MiB.");
      const limit = 4 * 1024 * 1024;
      const bytes = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > limit) reject("Receipt exceeds the 4 MiB import limit.");
      }
      if (length !== stat.size) reject("Receipt changed during import.");
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        );
        return JSON.parse(text) as unknown;
      } catch {
        reject("Receipt is not valid UTF-8 JSON.");
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof MillError) throw error;
    reject("The receipt could not be safely read.");
  }
}
