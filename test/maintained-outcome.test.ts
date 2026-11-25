import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalDigest, canonicalJson } from "../src/contracts/canonical.js";
import type { JsonValue } from "../src/contracts/canonical.js";
import { decodeExternalPublicKey } from "../src/contracts/external-verification.js";
import {
  maintainedOutcomePolicySchema,
  maintainedOutcomeRequestSchema,
} from "../src/contracts/maintained-outcome.js";
import type { MaintainedOutcomeRequest } from "../src/contracts/maintained-outcome.js";
import { maintainedOutcomeHandoff } from "../src/runtime/maintained-outcome.js";
import { temporaryDirectory } from "./helpers.js";

const verifier = generateKeyPairSync("ed25519");
const owner = generateKeyPairSync("ed25519");
const policy = {
  schemaVersion: "1",
  outcomeId: "WHEEL",
  claim: "The wheel installs offline and its CLI emits the documented record.",
  owner: "maintainer",
  runtimePath: "runtime.lock",
  checkPath: "check.py",
  reuseScope: "immutable-inputs",
  verifierPublicKeyPem: verifier.publicKey
    .export({
      format: "pem",
      type: "spki",
    })
    .toString(),
  ownerPublicKeyPem: owner.publicKey
    .export({ format: "pem", type: "spki" })
    .toString(),
  maxAgeSeconds: 60,
} as const;
const artifactDigest = `sha256:${"a".repeat(64)}`;
const otherArtifact = `sha256:${"b".repeat(64)}`;
const now = new Date("2025-01-01T00:00:30.000Z");
const producedAt = "2025-01-01T00:00:01.000Z";
const acceptedAt = "2025-01-01T00:00:15.000Z";
const policyPath = "maintained.json";
const runtimeBytes = Buffer.from([0, 255, 12, 128]);
const checkBytes = Buffer.from("wheel cli --json\r\n");
const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function digest(bytes: Buffer) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function envelope<T extends JsonValue>(payload: T, key: KeyObject) {
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      key,
    ).toString("base64"),
  };
}

function verification(
  request: MaintainedOutcomeRequest,
  result: "passed" | "failed" = "passed",
  at = producedAt,
  key = verifier.privateKey,
) {
  return envelope(
    {
      kind: "maintained-outcome-verification",
      request,
      producedAt: at,
      result,
    } as const,
    key,
  );
}

function acceptance(
  request: MaintainedOutcomeRequest,
  verificationDigest: string,
  at = acceptedAt,
  key = owner.privateKey,
) {
  return envelope(
    {
      schemaVersion: "1",
      kind: "maintained-outcome-acceptance",
      outcomeId: request.outcomeId,
      policyPath: request.policyPath,
      policyCommit: request.policyCommit,
      policyDigest: request.policyDigest,
      subjectCommit: request.subjectCommit,
      verificationDigest,
      acceptedAt: at,
    } as const,
    key,
  );
}

async function createFixture(objectFormat = "sha1") {
  const temporary = await temporaryDirectory("mill-maintained-state-");
  function git(...args: string[]) {
    return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: temporary.path,
      encoding: "utf8",
      env,
    }).trim();
  }
  await writeFile(
    path.join(temporary.path, policyPath),
    JSON.stringify(policy),
  );
  await writeFile(path.join(temporary.path, policy.runtimePath), runtimeBytes);
  await writeFile(path.join(temporary.path, policy.checkPath), checkBytes);
  git("init", "-q", "-b", "main", `--object-format=${objectFormat}`);
  git("add", ".");
  git("commit", "-qm", "Approve one maintained claim");
  const base = {
    root: temporary.path,
    policyPath,
    policyCommit: git("rev-parse", "HEAD"),
    artifactDigest,
    now,
  };
  const read = (
    subjectCommit = base.policyCommit,
    options: Partial<Parameters<typeof maintainedOutcomeHandoff>[0]> = {},
  ) => maintainedOutcomeHandoff({ ...base, subjectCommit, ...options });
  async function commit(name: string, bytes: string | Buffer) {
    await writeFile(path.join(temporary.path, name), bytes);
    git("add", "--", name);
    git("commit", "-qm", "Change selected file");
    return git("rev-parse", "HEAD");
  }
  async function record(file: string, value: JsonValue) {
    await writeFile(path.join(temporary.path, file), JSON.stringify(value));
  }
  return {
    base,
    read,
    git,
    commit,
    record,
    path: temporary.path,
    cleanup: temporary.cleanup,
  };
}

let fixture: Awaited<ReturnType<typeof createFixture>>;

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(async () => fixture.cleanup());

async function replaceParent(
  oid: string,
  original: string,
  replacement: string,
) {
  const objectPath = path.join(
    fixture.path,
    ".git",
    "objects",
    oid.slice(0, 2),
    oid.slice(2),
  );
  const object = inflateSync(await readFile(objectPath));
  const parent = object.indexOf(`parent ${original}\n`);
  expect(parent).toBeGreaterThan(0);
  object.write(replacement, parent + "parent ".length, "ascii");
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, deflateSync(object));
}

function requestFrom(
  handoff: Awaited<ReturnType<typeof maintainedOutcomeHandoff>>,
) {
  return maintainedOutcomeRequestSchema.parse(handoff.request);
}

describe("maintained outcome signer policy", () => {
  it("admits independently generated Ed25519 keys for both roles", () => {
    expect(maintainedOutcomePolicySchema.safeParse(policy).success).toBe(true);
  });

  it.each([
    ["identity", "01"],
    ["small-order", "00"],
    ["off-curve", "02"],
    ["mixed-order", "03"],
    ["noncanonical", `ed${"ff".repeat(30)}7f`],
  ])("rejects the %s Ed25519 point for either signer", (_name, encoding) => {
    const spki = Buffer.from(
      `302a300506032b6570032100${encoding.padEnd(64, "0")}`,
      "hex",
    );
    const pem = `-----BEGIN PUBLIC KEY-----\n${spki.toString("base64")}\n-----END PUBLIC KEY-----\n`;
    expect(decodeExternalPublicKey(pem)?.asymmetricKeyType).toBe("ed25519");
    for (const role of ["verifierPublicKeyPem", "ownerPublicKeyPem"] as const) {
      const result = maintainedOutcomePolicySchema.safeParse({
        ...policy,
        [role]: pem,
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("maintained outcome inspection", () => {
  it("accepts ordinary JSON whitespace in policies and signed records", async () => {
    const claim = 'The CLI emits {"allocated":3}.';
    const approved = await fixture.commit(
      policyPath,
      JSON.stringify({ ...policy, claim }, null, 2).replaceAll("\n", "\r"),
    );
    const options = { policyCommit: approved };
    const request = requestFrom(await fixture.read(approved, options));
    const evidencePath = "verification.json";
    const acceptancePath = "acceptance.json";
    const proof = verification(request);
    for (const [file, record] of [
      [evidencePath, proof],
      [acceptancePath, acceptance(request, canonicalDigest(proof))],
    ] as const) {
      await writeFile(
        path.join(fixture.path, file),
        JSON.stringify(record, null, 2).replaceAll("\n", "\r"),
      );
    }
    expect(
      await fixture.read(approved, {
        ...options,
        evidencePath,
        acceptancePath,
      }),
    ).toMatchObject({ claim, status: "current", ownerAcceptance: "accepted" });
  });

  it.each(['"claim"', '"cl\\u0061im"'])(
    "rejects an ambiguous approved policy containing the duplicate key %s",
    async (key) => {
      const oldClaim = '"first parser claim"';
      const ambiguous = `{${key}:${oldClaim},${JSON.stringify(policy).slice(1)}`;
      const selected = await fixture.commit(policyPath, ambiguous);
      await expect(
        fixture.read(selected, { policyCommit: selected }),
      ).rejects.toMatchObject({
        code: "INVALID_MAINTAINED_OUTCOME_POLICY",
      });
    },
  );

  it("does not admit a signed verification envelope with a duplicate nested member", async () => {
    const evidencePath = "verification.json";
    const request = requestFrom(await fixture.read());
    const signed = JSON.stringify(verification(request));
    await writeFile(
      path.join(fixture.path, evidencePath),
      signed.replace(
        '"result":"passed"',
        '"result":"failed","result":"passed"',
      ),
    );
    expect(await fixture.read(undefined, { evidencePath })).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_INVALID",
    });
  });

  it("uses committed inputs and never inherits exact owner acceptance to a later subject", async () => {
    const initial = await fixture.read();
    expect(initial).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_MISSING",
      evidenceScope: "supplied-artifact-digest-and-selected-records",
      ownerAcceptance: "not_recorded",
      next: { owner: "maintainer", action: "verify" },
      authorizationGranted: false,
    });
    expect(initial.request?.inputs).toEqual({
      artifactDigest,
      runtimeDigest: digest(runtimeBytes),
      checkDigest: digest(checkBytes),
      checkMode: "100644",
    });
    const request = requestFrom(initial);
    const proof = verification(request);
    await fixture.record("verification.json", proof);
    await fixture.record(
      "acceptance.json",
      acceptance(request, canonicalDigest(proof)),
    );
    const options = {
      evidencePath: "verification.json",
      acceptancePath: "acceptance.json",
    };
    expect(await fixture.read(undefined, options)).toMatchObject({
      status: "current",
      ownerAcceptance: "accepted",
      next: { action: "none" },
      authorizationGranted: false,
    });
    const subject = await fixture.commit("README.md", "# Unrelated edit\n");
    await writeFile(
      path.join(fixture.path, policy.runtimePath),
      "uncommitted drift",
    );
    const carry = await fixture.read(subject, options);
    expect(carry).toMatchObject({
      status: "current",
      ownerAcceptance: "stale",
      request: { subjectCommit: subject },
      verification: { subjectCommit: request.subjectCommit },
      next: { action: "accept", owner: "maintainer" },
    });
    expect(fixture.git("status", "--short").split("\n").at(0)).toBe(
      "M runtime.lock",
    );
    await fixture.record(
      "acceptance.json",
      acceptance(requestFrom(carry), canonicalDigest(proof)),
    );
    expect(await fixture.read(subject, options)).toMatchObject({
      status: "current",
      ownerAcceptance: "accepted",
      authorizationGranted: false,
    });
  });

  it("keeps verification and owner decisions on their signed policy path", async () => {
    const copyPath = "policy-copy.json";
    const selected = await fixture.commit(copyPath, JSON.stringify(policy));
    const evidencePath = "verification.json";
    const acceptancePath = "acceptance.json";
    const options = { policyCommit: selected, evidencePath, acceptancePath };
    const original = requestFrom(
      await fixture.read(selected, { policyCommit: selected }),
    );
    const proof = verification(original);
    await fixture.record(evidencePath, proof);
    await fixture.record(
      acceptancePath,
      acceptance(original, canonicalDigest(proof)),
    );
    expect(await fixture.read(selected, options)).toMatchObject({
      status: "current",
      policyPath,
      ownerAcceptance: "accepted",
    });

    const copy = { ...options, policyPath: copyPath };
    const rejected = await fixture.read(selected, copy);
    expect(rejected).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_NOT_APPLICABLE",
      policyPath: copyPath,
      ownerAcceptance: "stale",
    });
    const copyRequest = requestFrom(rejected);
    expect(copyRequest).toEqual({ ...original, policyPath: copyPath });

    const copyProof = verification(copyRequest);
    await fixture.record(evidencePath, copyProof);
    await fixture.record(
      acceptancePath,
      acceptance(original, canonicalDigest(copyProof)),
    );
    expect(await fixture.read(selected, copy)).toMatchObject({
      status: "current",
      ownerAcceptance: "stale",
      next: { action: "accept" },
    });
  });

  it("reports independent artifact, runtime, and check changes", async () => {
    const request = requestFrom(await fixture.read());
    await fixture.record("verification.json", verification(request));
    const options = { evidencePath: "verification.json" };
    expect(
      await fixture.read(undefined, {
        ...options,
        artifactDigest: otherArtifact,
      }),
    ).toMatchObject({
      status: "stale",
      reason: "INPUTS_CHANGED",
      changedInputs: ["artifact"],
      next: { action: "verify" },
    });
    const runtime = await fixture.commit(
      policy.runtimePath,
      Buffer.from([0, 254, 12, 128]),
    );
    expect(await fixture.read(runtime, options)).toMatchObject({
      status: "stale",
      changedInputs: ["runtime"],
    });
    const check = await fixture.commit(
      policy.checkPath,
      "wheel cli --json --new\n",
    );
    expect(await fixture.read(check, options)).toMatchObject({
      status: "stale",
      changedInputs: ["runtime", "check"],
    });
  });

  it("invalidates proof when the check's executable mode changes with identical bytes", async () => {
    fixture.git("update-index", "--chmod=+x", policy.checkPath);
    fixture.git("commit", "-qm", "Mark the check executable");
    const executable = fixture.git("rev-parse", "HEAD");
    const request = requestFrom(await fixture.read(executable));
    expect(request.inputs.checkMode).toBe("100755");
    await fixture.record("verification.json", verification(request));
    const evidencePath = "verification.json";
    expect(await fixture.read(executable, { evidencePath })).toMatchObject({
      status: "current",
    });

    fixture.git("update-index", "--chmod=-x", policy.checkPath);
    fixture.git("commit", "-qm", "Clear the check's executable mode");
    const changed = fixture.git("rev-parse", "HEAD");
    expect(await fixture.read(changed, { evidencePath })).toMatchObject({
      status: "stale",
      reason: "INPUTS_CHANGED",
      changedInputs: ["check"],
      unavailableInputs: [],
      request: {
        inputs: {
          checkDigest: request.inputs.checkDigest,
          checkMode: "100644",
        },
      },
    });
    await fixture.record(
      evidencePath,
      verification({
        ...request,
        inputs: { ...request.inputs, checkMode: "100644" },
      }),
    );
    expect(await fixture.read(changed, { evidencePath })).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_NOT_APPLICABLE",
      verification: null,
    });
  });

  it("identifies each unavailable input without producing a new request", async () => {
    for (const [file, unavailableInputs] of [
      [policy.runtimePath, ["runtime"]],
      [policy.checkPath, ["runtime", "check"]],
    ] as const) {
      fixture.git("rm", file);
      fixture.git("commit", "-qm", "Remove a selected input");
      expect(
        await fixture.read(fixture.git("rev-parse", "HEAD")),
      ).toMatchObject({
        status: "unverified",
        reason: "INPUTS_UNAVAILABLE",
        changedInputs: [],
        unavailableInputs,
        request: null,
        next: { action: "resolve-inputs" },
      });
    }
  });

  it("surfaces a fresh failure separately from expiry and rejects future verification", async () => {
    const subject = requestFrom(await fixture.read());
    const options = { evidencePath: "verification.json" };
    await fixture.record("verification.json", verification(subject, "failed"));
    expect(await fixture.read(undefined, options)).toMatchObject({
      status: "failed",
      reason: "VERIFICATION_FAILED",
      next: { action: "review-failure", owner: "maintainer" },
      authorizationGranted: false,
    });
    expect(
      await fixture.read(undefined, {
        ...options,
        now: new Date("2025-01-01T00:01:01.000Z"),
      }),
    ).toMatchObject({
      status: "stale",
      reason: "VERIFICATION_EXPIRED",
      next: { action: "verify" },
    });
    await fixture.record(
      "verification.json",
      verification(subject, "passed", "2025-01-01T00:00:31.000Z"),
    );
    expect(await fixture.read(undefined, options)).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_INVALID",
    });
  });

  it("observes expiry during asynchronous Git inspection before accepting proof", async () => {
    const { root, policyCommit } = fixture.base;
    const request = requestFrom(await fixture.read());
    const proof = verification(request);
    const evidencePath = "verification.json";
    const acceptancePath = "acceptance.json";
    await fixture.record(evidencePath, proof);
    await fixture.record(
      acceptancePath,
      acceptance(request, canonicalDigest(proof)),
    );
    const read = () =>
      maintainedOutcomeHandoff({
        root,
        policyPath,
        policyCommit,
        subjectCommit: policyCommit,
        artifactDigest,
        evidencePath,
        acceptancePath,
      });
    const expiresAt = Date.parse(producedAt) + policy.maxAgeSeconds * 1000;

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(expiresAt - 1);
      expect(await read()).toMatchObject({
        status: "current",
        ownerAcceptance: "accepted",
      });
      const pending = read();
      vi.setSystemTime(expiresAt);
      await expect(pending).resolves.toMatchObject({
        status: "stale",
        reason: "VERIFICATION_EXPIRED",
        ownerAcceptance: "stale",
        next: { action: "verify" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a wrong signer, payload mutation and verifier-supplied owner acceptance", async () => {
    const subject = requestFrom(await fixture.read());
    const evidencePath = "verification.json";
    const acceptancePath = "acceptance.json";
    const wrongSigner = verification(
      subject,
      "passed",
      producedAt,
      owner.privateKey,
    );
    await fixture.record(evidencePath, wrongSigner);
    expect(await fixture.read(undefined, { evidencePath })).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_INVALID",
    });
    const proof = verification(subject);
    await fixture.record(evidencePath, {
      ...proof,
      payload: { ...proof.payload, result: "failed" },
    });
    expect(await fixture.read(undefined, { evidencePath })).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_INVALID",
    });

    await fixture.record(evidencePath, proof);
    for (const wrongAcceptance of [
      acceptance(
        subject,
        canonicalDigest(proof),
        acceptedAt,
        verifier.privateKey,
      ),
      acceptance(subject, canonicalDigest(proof), "2025-01-01T00:00:31.000Z"),
      acceptance(subject, canonicalDigest(proof), "2025-01-01T00:00:00.000Z"),
    ]) {
      await fixture.record(acceptancePath, wrongAcceptance);
      expect(
        await fixture.read(undefined, { evidencePath, acceptancePath }),
      ).toMatchObject({
        status: "current",
        ownerAcceptance: "invalid",
        next: { action: "accept" },
      });
    }
    await fixture.record(acceptancePath, acceptance(subject, otherArtifact));
    expect(
      await fixture.read(undefined, { evidencePath, acceptancePath }),
    ).toMatchObject({
      status: "current",
      ownerAcceptance: "stale",
    });
  });

  it("does not accept signed assertions about unrelated or unreadable Git inputs", async () => {
    const request = requestFrom(await fixture.read());
    const evidencePath = "verification.json";
    await fixture.record(
      evidencePath,
      verification({
        ...request,
        inputs: { ...request.inputs, checkDigest: otherArtifact },
      }),
    );
    expect(await fixture.read(undefined, { evidencePath })).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_NOT_APPLICABLE",
      verification: null,
    });

    const alternate = await fixture.commit("alternate.md", "Divergent source");
    await fixture.record(
      evidencePath,
      verification({ ...request, subjectCommit: alternate }),
    );
    fixture.git("checkout", "-qb", "other", fixture.base.policyCommit);
    const current = await fixture.commit("current.md", "Current source");
    expect(await fixture.read(current, { evidencePath })).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_NOT_APPLICABLE",
      verification: null,
    });
  });

  it("stops requesting verifications under a changed or unaffiliated policy", async () => {
    const replacement = await fixture.commit(
      policyPath,
      JSON.stringify({ ...policy, owner: "other-owner" }),
    );
    expect(await fixture.read(replacement)).toMatchObject({
      request: null,
      status: "stale",
      reason: "POLICY_CHANGED",
      changedInputs: ["policy"],
      next: { action: "select-policy" },
      authorizationGranted: false,
    });
    expect(
      await fixture.read(fixture.base.policyCommit, {
        policyCommit: replacement,
      }),
    ).toMatchObject({
      request: null,
      reason: "POLICY_CHANGED",
    });
    fixture.git("rm", policyPath);
    fixture.git("commit", "-qm", "Remove the policy from the subject");
    expect(await fixture.read(fixture.git("rev-parse", "HEAD"))).toMatchObject({
      request: null,
      status: "stale",
      reason: "POLICY_CHANGED",
      changedInputs: ["policy"],
    });
  });

  it.each(["missing", "shallow"])(
    "reports a %s ancestry as an inspection error",
    async (condition) => {
      const parent = await fixture.commit("notes.md", "# Parent");
      const subject = await fixture.commit("notes.md", "# Subject");
      if (condition === "missing")
        await rm(
          path.join(
            fixture.path,
            ".git",
            "objects",
            parent.slice(0, 2),
            parent.slice(2),
          ),
        );
      else
        await writeFile(
          path.join(fixture.path, ".git", "shallow"),
          `${subject}\n`,
        );
      await expect(fixture.read(subject)).rejects.toMatchObject({
        code: "MAINTAINED_OUTCOME_ANCESTRY_INSPECTION_UNAVAILABLE",
        exitCode: 74,
      });
    },
  );

  it("carries a pass through a verified second merge parent", async () => {
    fixture.git("switch", "-qc", "proof-branch");
    const proof = await fixture.commit("proof.md", "Verification branch");
    const evidencePath = "verification.json";
    await fixture.record(
      evidencePath,
      verification(requestFrom(await fixture.read(proof))),
    );
    fixture.git("switch", "-q", "main");
    await fixture.commit("main.md", "Main branch");
    fixture.git(
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "Merge verified history",
      "proof-branch",
    );
    const subject = fixture.git("rev-parse", "HEAD");
    expect(fixture.git("rev-parse", `${subject}^2`)).toBe(proof);
    expect(await fixture.read(subject, { evidencePath })).toMatchObject({
      status: "current",
      verification: { subjectCommit: proof },
      request: { subjectCommit: subject },
    });
  });

  it("rejects apparent ancestry introduced by a damaged intermediate commit", async () => {
    const { policyCommit } = fixture.base;
    fixture.git("switch", "-qc", "proof-branch");
    const proof = await fixture.commit("proof.md", "Verification branch");
    const evidencePath = "verification.json";
    await fixture.record(
      evidencePath,
      verification(requestFrom(await fixture.read(proof))),
    );

    fixture.git("switch", "-q", "main");
    const intermediate = await fixture.commit("main.md", "Intermediate commit");
    const subject = await fixture.commit("main.md", "Selected subject");
    expect(await fixture.read(subject, { evidencePath })).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_NOT_APPLICABLE",
    });

    await replaceParent(intermediate, policyCommit, proof);

    expect(fixture.git("rev-parse", `${proof}^{commit}`)).toBe(proof);
    expect(fixture.git("rev-parse", `${subject}^{commit}`)).toBe(subject);
    expect(fixture.git("merge-base", "--is-ancestor", proof, subject)).toBe("");
    await expect(fixture.read(subject, { evidencePath })).rejects.toMatchObject(
      {
        code: "MAINTAINED_OUTCOME_ANCESTRY_INSPECTION_UNAVAILABLE",
        exitCode: 74,
      },
    );
  });

  it("rejects apparent unrelatedness introduced by a damaged intermediate commit", async () => {
    const { policyCommit } = fixture.base;
    const tree = fixture.git("rev-parse", `${policyCommit}^{tree}`);
    const unrelated = fixture.git("commit-tree", tree, "-m", "Unrelated root");
    const intermediate = await fixture.commit("main.md", "Intermediate commit");
    const subject = await fixture.commit("main.md", "Selected subject");
    expect(await fixture.read(subject)).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_MISSING",
    });

    await replaceParent(intermediate, policyCommit, unrelated);

    expect(fixture.git("rev-parse", `${policyCommit}^{commit}`)).toBe(
      policyCommit,
    );
    expect(fixture.git("rev-parse", `${subject}^{commit}`)).toBe(subject);
    expect(() =>
      fixture.git("merge-base", "--is-ancestor", policyCommit, subject),
    ).toThrow(expect.objectContaining({ status: 1 }));
    await expect(fixture.read(subject)).rejects.toMatchObject({
      code: "MAINTAINED_OUTCOME_ANCESTRY_INSPECTION_UNAVAILABLE",
      exitCode: 74,
    });
  });

  it("stops when the ancestry candidate set exceeds the inspection limit", async () => {
    const { policyCommit } = fixture.base;
    const record =
      "commit refs/heads/long\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 1\nx\n";
    const input = `${record}from ${policyCommit}\n\n${`${record}\n`.repeat(4096)}done\n`;
    execFileSync("git", ["fast-import", "--quiet"], {
      cwd: fixture.path,
      env,
      input,
    });
    const subject = fixture.git("rev-parse", "long");
    expect(
      fixture.git("rev-list", "--count", `${policyCommit}..${subject}`),
    ).toBe("4097");
    await expect(fixture.read(subject)).rejects.toMatchObject({
      code: "MAINTAINED_OUTCOME_ANCESTRY_INSPECTION_UNAVAILABLE",
      exitCode: 74,
    });
  });

  it("reports unreadable subject policy bytes outside the read budget as an inspection error", async () => {
    const subject = await fixture.commit(
      policyPath,
      Buffer.alloc(64 * 1024 + 1, 32),
    );
    await expect(fixture.read(subject)).rejects.toMatchObject({
      code: "MAINTAINED_OUTCOME_POLICY_INSPECTION_UNAVAILABLE",
      exitCode: 74,
    });
  });

  it("checks the selected policy through nested Git trees", async () => {
    const policyPath = "quality/governance/maintained.json";
    await mkdir(path.join(fixture.path, "quality", "governance"), {
      recursive: true,
    });
    const selected = await fixture.commit(policyPath, JSON.stringify(policy));
    expect(
      await fixture.read(selected, { policyPath, policyCommit: selected }),
    ).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_MISSING",
      request: { policyCommit: selected, subjectCommit: selected },
    });
  });

  it("reports the runtime path unavailable when individually bounded trees exhaust the shared byte budget", async () => {
    const { policyCommit } = fixture.base;
    const runtimePath = "a/a/a/a/a/runtime.lock";
    const runtime = fixture.git(
      "rev-parse",
      `${policyCommit}:${policy.runtimePath}`,
    );
    const check = fixture.git(
      "rev-parse",
      `${policyCommit}:${policy.checkPath}`,
    );
    const entry = (mode: string, name: string, oid: string) =>
      Buffer.concat([
        Buffer.from(`${mode} ${name}\0`),
        Buffer.from(oid, "hex"),
      ]);
    const rawObject = path.join(fixture.path, "raw-object");
    const writeObject = async (type: string, bytes: Buffer) => {
      await writeFile(rawObject, bytes);
      return fixture.git("hash-object", "-t", type, "-w", rawObject);
    };

    const filler = Buffer.concat(
      Array.from({ length: 16_000 }, (_, index) => {
        const name = `f${String(index).padStart(5, "0")}${"x".repeat(192)}`;
        return entry("100644", name, runtime);
      }),
    );
    expect(filler.length + 64).toBeLessThan(4 * 1024 * 1024);
    expect(filler.length * 5).toBeGreaterThan(16 * 1024 * 1024);
    let tree = await writeObject(
      "tree",
      Buffer.concat([filler, entry("100644", "runtime.lock", runtime)]),
    );
    for (let depth = 0; depth < 4; depth += 1) {
      tree = await writeObject(
        "tree",
        Buffer.concat([entry("40000", "a", tree), filler]),
      );
    }
    const policyObject = await writeObject(
      "blob",
      Buffer.from(JSON.stringify({ ...policy, runtimePath })),
    );
    const root = await writeObject(
      "tree",
      Buffer.concat([
        entry("40000", "a", tree),
        entry("100644", policy.checkPath, check),
        entry("100644", policyPath, policyObject),
      ]),
    );
    const selected = fixture.git(
      "commit-tree",
      root,
      "-m",
      "Select bounded Git object paths",
    );
    expect(fixture.git("rev-parse", `${selected}:${runtimePath}`)).toBe(
      runtime,
    );
    expect(
      await fixture.read(selected, { policyCommit: selected }),
    ).toMatchObject({
      status: "unverified",
      reason: "INPUTS_UNAVAILABLE",
      unavailableInputs: ["runtime"],
      request: null,
    });
  });

  it.each(["commit", "tree", "blob"] as const)(
    "rejects substituted Git %s bytes under the original object ID",
    async (type) => {
      const { policyCommit } = fixture.base;
      const oid = {
        commit: policyCommit,
        tree: fixture.git("rev-parse", `${policyCommit}^{tree}`),
        blob: fixture.git("rev-parse", `${policyCommit}:${policyPath}`),
      }[type];
      const file = path.join(
        fixture.path,
        ".git",
        "objects",
        oid.slice(0, 2),
        oid.slice(2),
      );
      const object = inflateSync(await readFile(file));
      await chmod(file, 0o600);
      const bodyStart = object.indexOf(0) + 1;
      if (type === "blob") {
        const substitute = Buffer.from(
          JSON.stringify({ ...policy, owner: "substitute" }),
        );
        const body = Buffer.concat([
          Buffer.from(`blob ${substitute.length}\0`),
          substitute,
        ]);
        await writeFile(file, deflateSync(body));
        expect(fixture.git("cat-file", type, oid)).toBe(
          substitute.toString("utf8"),
        );
      } else {
        const target =
          type === "tree" ? policyPath : "Approve one maintained claim";
        const offset = object.indexOf(target, bodyStart);
        expect(offset).toBeGreaterThan(bodyStart);
        object[offset] = 0x78;
        await writeFile(file, deflateSync(object));
      }
      await expect(fixture.read()).rejects.toMatchObject({
        code: "MAINTAINED_OUTCOME_POLICY_INSPECTION_UNAVAILABLE",
        exitCode: 74,
      });
    },
  );

  it.each(["runtime", "check"] as const)(
    "classifies a corrupted %s blob as an unavailable input",
    async (role) => {
      const selection =
        role === "runtime" ? policy.runtimePath : policy.checkPath;
      const oid = fixture.git(
        "rev-parse",
        `${fixture.base.policyCommit}:${selection}`,
      );
      const file = path.join(
        fixture.path,
        ".git",
        "objects",
        oid.slice(0, 2),
        oid.slice(2),
      );
      await chmod(file, 0o600);
      await writeFile(file, deflateSync(Buffer.from("blob 7\0changed")));
      expect(await fixture.read()).toMatchObject({
        status: "unverified",
        reason: "INPUTS_UNAVAILABLE",
        unavailableInputs: [role],
        request: null,
      });
    },
  );

  it("distinguishes a missing or non-commit object from failure to run Git", async () => {
    for (const commit of [
      "1".repeat(40),
      fixture.git("rev-parse", "HEAD^{tree}"),
    ]) {
      await expect(fixture.read(commit)).rejects.toMatchObject({
        code: "INVALID_MAINTAINED_OUTCOME_COMMIT",
      });
    }
    const tool = await temporaryDirectory("mill-unrunnable-git-");
    try {
      const executable = path.join(tool.path, "git");
      await writeFile(executable, `#!${path.join(tool.path, "missing")}\n`, {
        mode: 0o700,
      });
      vi.stubEnv("MILL_GIT_PATH", executable);
      await expect(fixture.read()).rejects.toMatchObject({
        code: "MAINTAINED_OUTCOME_POLICY_INSPECTION_UNAVAILABLE",
        exitCode: 74,
      });
    } finally {
      vi.unstubAllEnvs();
      await tool.cleanup();
    }
  });

  it("distinguishes an unreadable object header from a missing selected or signed commit", async () => {
    const unreadable = await fixture.commit(
      "unreadable.md",
      "Formerly readable commit",
    );
    const evidencePath = "verification.json";
    await fixture.record(
      evidencePath,
      verification(requestFrom(await fixture.read(unreadable))),
    );
    expect(await fixture.read(undefined, { evidencePath })).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_NOT_APPLICABLE",
    });
    const objectPath = path.join(
      fixture.path,
      ".git",
      "objects",
      unreadable.slice(0, 2),
      unreadable.slice(2),
    );
    await chmod(objectPath, 0o600);
    await writeFile(
      objectPath,
      deflateSync(Buffer.from("broken-header\0unreadable object")),
    );

    const unavailable = {
      code: "MAINTAINED_OUTCOME_POLICY_INSPECTION_UNAVAILABLE",
      exitCode: 74,
    };
    await expect(fixture.read(unreadable)).rejects.toMatchObject(unavailable);
    await expect(
      fixture.read(undefined, { evidencePath }),
    ).rejects.toMatchObject(unavailable);
  });

  it("reports the SHA-1 Git object requirement for an existing SHA-256 commit", async () => {
    const sha256 = await createFixture("sha256");
    try {
      expect(sha256.base.policyCommit).toMatch(/^[a-f0-9]{64}$/u);
      await expect(sha256.read()).rejects.toMatchObject({
        code: "UNSUPPORTED_MAINTAINED_OUTCOME_GIT_OBJECT_FORMAT",
        exitCode: 78,
      });
    } finally {
      await sha256.cleanup();
    }
  });

  it("reports unavailable history for a signed proof separately from unrelated proven history", async () => {
    const later = await fixture.commit("notes.md", "# Later subject");
    const request = requestFrom(await fixture.read(later));
    const evidencePath = "verification.json";
    await fixture.record(evidencePath, verification(request));
    expect(await fixture.read(undefined, { evidencePath })).toMatchObject({
      status: "unverified",
      reason: "VERIFICATION_NOT_APPLICABLE",
    });
    await writeFile(path.join(fixture.path, ".git", "shallow"), `${later}\n`);
    await expect(
      fixture.read(undefined, { evidencePath }),
    ).rejects.toMatchObject({
      code: "MAINTAINED_OUTCOME_ANCESTRY_INSPECTION_UNAVAILABLE",
      exitCode: 74,
    });
  });

  it("reports an unreadable signed proof's policy even when the current policy is readable", async () => {
    const request = requestFrom(await fixture.read());
    const unverifiableCommit = await fixture.commit(
      policyPath,
      Buffer.alloc(64 * 1024 + 1, 32),
    );
    const current = await fixture.commit(policyPath, JSON.stringify(policy));
    const evidencePath = "verification.json";
    await fixture.record(
      evidencePath,
      verification({
        ...request,
        subjectCommit: unverifiableCommit,
      }),
    );
    await expect(fixture.read(current, { evidencePath })).rejects.toMatchObject(
      {
        code: "MAINTAINED_OUTCOME_POLICY_INSPECTION_UNAVAILABLE",
        exitCode: 74,
      },
    );
  });

  it("rejects symlink policy, symlink input, malformed proofs and ambiguous identities", async () => {
    await symlink(policyPath, path.join(fixture.path, "symlink-policy"));
    fixture.git("add", "symlink-policy");
    fixture.git("commit", "-qm", "Declare a symlink instead of a policy");
    const linked = fixture.git("rev-parse", "HEAD");
    await expect(
      fixture.read(linked, {
        policyPath: "symlink-policy",
        policyCommit: linked,
      }),
    ).rejects.toMatchObject({ code: "INVALID_MAINTAINED_OUTCOME_POLICY" });
    await expect(fixture.read("main")).rejects.toMatchObject({
      code: "INVALID_MAINTAINED_OUTCOME_COMMIT",
    });

    const fakeId = "a".repeat(40);
    fixture.git("branch", fakeId);
    await expect(fixture.read(fakeId)).rejects.toMatchObject({
      code: "INVALID_MAINTAINED_OUTCOME_COMMIT",
    });

    fixture.git("rm", policy.checkPath);
    await symlink(
      policy.runtimePath,
      path.join(fixture.path, policy.checkPath),
    );
    fixture.git("add", policy.checkPath);
    fixture.git("commit", "-qm", "Use a symlink instead of a check");
    expect(await fixture.read(fixture.git("rev-parse", "HEAD"))).toMatchObject({
      status: "unverified",
      reason: "INPUTS_UNAVAILABLE",
      unavailableInputs: ["check"],
      request: null,
    });

    for (const evidencePath of [
      "../verification.json",
      "symlink-policy",
      "missing.json",
    ]) {
      expect(await fixture.read(undefined, { evidencePath })).toMatchObject({
        status: "unverified",
        reason: "VERIFICATION_INVALID",
      });
    }
  });

  it("requires distinct validated Ed25519 keys, paths and JSON fields", () => {
    for (const invalid of [
      {
        ...policy,
        ownerPublicKeyPem: policy.verifierPublicKeyPem.replace(/\n/gu, "\r\n"),
      },
      { ...policy, ownerPublicKeyPem: "not a key" },
      { ...policy, runtimePath: policy.checkPath },
      { ...policy, checkPath: "folder/../../check.py" },
      { ...policy, extra: "unexpected value" },
    ])
      expect(maintainedOutcomePolicySchema.safeParse(invalid).success).toBe(
        false,
      );
  });
});
