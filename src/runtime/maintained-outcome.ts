import { execFile } from "node:child_process";
import { createHash, verify } from "node:crypto";
import { promisify } from "node:util";

import { canonicalDigest, canonicalJson } from "../contracts/canonical.js";
import type { JsonValue } from "../contracts/canonical.js";
import { decodeExternalPublicKey } from "../contracts/external-verification.js";
import {
  maintainedOutcomeAcceptanceSchema,
  maintainedOutcomeHandoffSchema,
  maintainedOutcomePathSchema,
  maintainedOutcomePolicySchema,
  maintainedOutcomeVerificationSchema,
} from "../contracts/maintained-outcome.js";
import type {
  MaintainedOutcomeHandoff,
  MaintainedOutcomeRequest,
} from "../contracts/maintained-outcome.js";
import { findTrustedExecutable } from "../doctor.js";
import { ExitCode, MillError } from "../errors.js";
import { safeReadBytes } from "../security/safe-path.js";

const run = promisify(execFile);
const maxPolicyBytes = 64 * 1024;
const maxRecordBytes = 32 * 1024;
const maxInputBytes = 1024 * 1024;
const maxCommitBytes = 1024 * 1024;
const maxTreeBytes = 4 * 1024 * 1024;
const maxInspectionTreeBytes = 16 * 1024 * 1024;
const maxInspectionMilliseconds = 60_000;
const maxAncestryCandidates = 4096;
const maxAncestryMilliseconds = 30_000;
const maxGitMilliseconds = 10_000;
const commitId = /^[a-f0-9]{40}$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const treeModes = ["40000", "100644", "100755", "120000", "160000"] as const;

interface TreeEntry {
  mode: (typeof treeModes)[number];
  oid: string;
}

interface CommitObject {
  tree: string;
  parents: string[];
}

function parseCommit(bytes: Buffer): CommitObject | undefined {
  const treeHeaderBytes = 46;
  const parentHeaderBytes = 48;
  const tree = /^tree ([a-f0-9]{40})\n$/u.exec(
    bytes.toString("latin1", 0, treeHeaderBytes),
  )?.[1];
  if (tree === undefined) return undefined;
  const parents: string[] = [];
  for (
    let offset = treeHeaderBytes;
    bytes.toString("latin1", offset, offset + 7) === "parent ";
    offset += parentHeaderBytes
  ) {
    const parent = /^parent ([a-f0-9]{40})\n$/u.exec(
      bytes.toString("latin1", offset, offset + parentHeaderBytes),
    )?.[1];
    if (parent === undefined) return undefined;
    parents.push(parent);
  }
  return { tree, parents };
}

function treeEntry(
  tree: Buffer,
  component: string,
): TreeEntry | null | undefined {
  const target = Buffer.from(component, "utf8");
  let found: TreeEntry | null = null;
  let offset = 0;
  while (offset < tree.length) {
    const separator = tree.indexOf(0x20, offset);
    if (separator === -1 || separator - offset > 6) return undefined;
    const encodedMode = tree.toString("latin1", offset, separator);
    const mode = treeModes.find((candidate) => candidate === encodedMode);
    const terminator = tree.indexOf(0, separator + 1);
    if (mode === undefined || terminator <= separator + 1) return undefined;
    const next = terminator + 21;
    if (next > tree.length) return undefined;
    const name = tree.subarray(separator + 1, terminator);
    const dot = name[0] === 0x2e;
    if (
      name.includes(0x2f) ||
      (dot && (name.length === 1 || (name.length === 2 && name[1] === 0x2e)))
    )
      return undefined;
    if (name.equals(target)) {
      if (found !== null) return undefined;
      found = { mode, oid: tree.toString("hex", terminator + 1, next) };
    }
    offset = next;
  }
  return found;
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decode(bytes: Buffer): unknown {
  try {
    const text = utf8.decode(bytes);
    const value: unknown = JSON.parse(text);
    // The grammar is already valid. Scan complete strings so braces or colons
    // inside string values cannot affect duplicate-member detection.
    const objects: Set<string>[] = [];
    for (const token of text.matchAll(
      /("(?:\\.|[^"\\])*")([ \t\r\n]*:)?|[{}]/gu,
    )) {
      if (token[0] === "{") {
        objects.push(new Set());
      } else if (token[0] === "}") {
        objects.pop();
      } else if (token[1] !== undefined && token[2] !== undefined) {
        const key = JSON.parse(token[1]) as string;
        const object = objects.at(-1);
        if (object === undefined || object.has(key)) return null;
        object.add(key);
      }
    }
    return value;
  } catch {
    return null;
  }
}

function signed(
  payload: JsonValue,
  signature: string,
  publicKey: string,
): boolean {
  const key = decodeExternalPublicKey(publicKey);
  const bytes = Buffer.from(signature, "base64");
  return (
    key !== undefined &&
    bytes.toString("base64") === signature &&
    verify(null, Buffer.from(canonicalJson(payload), "utf8"), key, bytes)
  );
}

async function readRecord(
  root: string,
  file: string | undefined,
): Promise<unknown> {
  if (file === undefined) return undefined;
  if (!maintainedOutcomePathSchema.safeParse(file).success) return null;
  try {
    return decode(await safeReadBytes(root, file, maxRecordBytes));
  } catch {
    return null;
  }
}

async function gitReader(root: string) {
  const inspectionDeadline = performance.now() + maxInspectionMilliseconds;
  const executable = await findTrustedExecutable("git", root);
  if (executable === undefined) {
    throw new MillError(
      "GIT_UNAVAILABLE",
      "A trusted Git executable is required for maintained outcome inspection.",
      ExitCode.unavailable,
    );
  }
  const gitExecutable = executable;

  async function git(
    args: string[],
    maxBuffer = 4096,
    timeout = maxGitMilliseconds,
    input?: string,
  ) {
    const remaining = Math.floor(inspectionDeadline - performance.now());
    const available = Math.min(timeout, remaining);
    if (available < 1) return { code: -1 };
    try {
      const running = run(
        gitExecutable,
        [
          "--no-replace-objects",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.commitGraph=false",
          "-c",
          "credential.helper=",
          ...args,
        ],
        {
          cwd: root,
          encoding: "buffer",
          timeout: available,
          maxBuffer,
          env: {
            HOME: "/var/empty",
            LANG: "C",
            LC_ALL: "C",
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_GRAFT_FILE: "/dev/null",
            GIT_NO_LAZY_FETCH: "1",
            GIT_ALLOW_PROTOCOL: "",
            GIT_LITERAL_PATHSPECS: "1",
            GIT_OPTIONAL_LOCKS: "0",
          },
        },
      );
      const written =
        input === undefined
          ? undefined
          : new Promise<void>((resolve, reject) => {
              const stdin = running.child.stdin;
              if (stdin === null) {
                reject(new Error("Git did not accept input."));
                return;
              }
              stdin.once("error", reject);
              stdin.end(input, resolve);
            });
      const [result] = await Promise.all([running, written]);
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "number"
      )
        return { code: error.code };
      return { code: -1 };
    }
  }

  const objectFormat = (
    await git(["rev-parse", "--show-object-format=storage"])
  ).stdout?.toString("ascii");
  if (objectFormat === "sha256\n") {
    throw new MillError(
      "UNSUPPORTED_MAINTAINED_OUTCOME_GIT_OBJECT_FORMAT",
      "Maintained outcome inspection requires a repository that uses SHA-1 Git object IDs. This repository uses SHA-256 Git object IDs.",
      ExitCode.configuration,
    );
  }
  if (objectFormat !== "sha1\n") policyInspectionUnavailable();

  async function readObject(
    type: "commit" | "tree" | "blob",
    oid: string,
    limit: number,
    timeout?: number,
  ) {
    const { stdout: bytes } = await git(
      ["cat-file", type, oid],
      limit,
      timeout,
    );
    if (bytes === undefined) return undefined;
    const actual = createHash("sha1")
      .update(`${type} ${bytes.byteLength}\0`)
      .update(bytes)
      .digest("hex");
    return actual === oid ? bytes : undefined;
  }

  const commits = new Map<string, Promise<CommitObject | undefined>>();
  function commitObject(oid: string, timeout?: number) {
    const cached = commits.get(oid);
    if (cached !== undefined) return cached;
    const reading = readObject("commit", oid, maxCommitBytes, timeout).then(
      (bytes) => (bytes === undefined ? undefined : parseCommit(bytes)),
    );
    if (commits.size < 8) commits.set(oid, reading);
    return reading;
  }

  const trees = new Map<string, Promise<Buffer | undefined>>();
  let remainingTreeBytes = maxInspectionTreeBytes;
  let queuedTreeRead: Promise<unknown> = Promise.resolve();
  function readTree(oid: string) {
    if (performance.now() >= inspectionDeadline)
      return Promise.resolve(undefined);
    const cached = trees.get(oid);
    if (cached !== undefined) return cached;
    // Parallel input lookups share one byte allowance for uncached tree reads.
    const reading = queuedTreeRead.then(async () => {
      const allowance = Math.min(maxTreeBytes, remainingTreeBytes);
      if (allowance === 0) return undefined;
      const bytes = await readObject("tree", oid, allowance);
      remainingTreeBytes -= bytes?.byteLength ?? allowance;
      return bytes;
    });
    queuedTreeRead = reading;
    if (trees.size < 8) trees.set(oid, reading);
    return reading;
  }

  return {
    async commit(identity: string): Promise<boolean | undefined> {
      if (!commitId.test(identity)) return false;
      const result = await git(
        [
          "-c",
          "core.warnAmbiguousRefs=false",
          "cat-file",
          "--batch-check=%(objectname) %(objecttype)",
        ],
        4096,
        maxGitMilliseconds,
        `${identity}\n`,
      );
      // Git also emits a 'missing' record for unreadable objects, with diagnostics.
      if (result.code !== 0 || result.stderr?.length !== 0) return undefined;
      const entry = /^([a-f0-9]{40}) (commit|tree|blob|tag|missing)\n$/u.exec(
        result.stdout?.toString("latin1") ?? "",
      );
      if (entry?.[1] !== identity) return undefined;
      if (entry[2] !== "commit") return false;
      return (await commitObject(identity)) === undefined ? undefined : true;
    },
    async ancestor(older: string, newer: string): Promise<boolean | undefined> {
      if (older === newer)
        return (await commitObject(older)) === undefined ? undefined : true;

      const deadline = Math.min(
        inspectionDeadline,
        performance.now() + maxAncestryMilliseconds,
      );
      const remaining = () => Math.floor(deadline - performance.now());
      const result = await git(
        ["merge-base", "--is-ancestor", older, newer],
        4096,
        remaining(),
      );
      let candidates: Set<string> | undefined;
      if (result.code === 1) {
        const shallow = await git(
          ["rev-parse", "--is-shallow-repository"],
          4096,
          remaining(),
        );
        // Truncated history cannot establish that two commits are unrelated.
        if (shallow.stdout?.toString("ascii") !== "false\n") return undefined;
      } else if (result.code === 0) {
        // Git locates candidates. Only parent links from verified bytes prove a path.
        const { stdout } = await git(
          [
            "rev-list",
            "--ancestry-path",
            `--max-count=${maxAncestryCandidates + 1}`,
            `${older}..${newer}`,
            "--",
          ],
          (maxAncestryCandidates + 1) * 41,
          remaining(),
        );
        if (stdout === undefined) return undefined;
        const ids = stdout.toString("latin1").split("\n");
        if (
          ids.pop() !== "" ||
          ids.length > maxAncestryCandidates ||
          ids.some((oid) => !commitId.test(oid))
        )
          return undefined;
        candidates = new Set(ids);
        if (!candidates.has(newer)) return undefined;
      } else {
        return undefined;
      }

      const pending = [newer];
      const scheduled = new Set(pending);
      let incomplete = false;
      for (const oid of pending) {
        const timeout = remaining();
        if (timeout < 1) return undefined;
        const commit = await commitObject(oid, timeout);
        if (commit === undefined) {
          incomplete = true;
          continue;
        }
        for (const parent of commit.parents) {
          if (parent === older) return true;
          if (candidates?.has(parent) === false || scheduled.has(parent))
            continue;
          if (scheduled.size === maxAncestryCandidates) return undefined;
          scheduled.add(parent);
          pending.push(parent);
        }
      }
      // An absence claim requires exhausting all reachable parents, with no unreadable objects.
      return candidates === undefined && !incomplete ? false : undefined;
    },
    async blob(commit: string, file: string, limit: number) {
      let treeOid = (await commitObject(commit))?.tree;
      if (treeOid === undefined) return undefined;
      const components = file.split("/");
      for (const [index, component] of components.entries()) {
        const tree = await readTree(treeOid);
        if (tree === undefined) return undefined;
        const entry = treeEntry(tree, component);
        if (entry == null) return entry;
        const { mode, oid } = entry;
        if (index < components.length - 1) {
          if (mode !== "40000") return null;
          treeOid = oid;
          continue;
        }
        if (mode !== "100644" && mode !== "100755") return null;
        const bytes = await readObject("blob", oid, limit);
        return bytes === undefined ? undefined : ({ mode, bytes } as const);
      }
      return undefined;
    },
  };
}

function policyInspectionUnavailable(): never {
  throw new MillError(
    "MAINTAINED_OUTCOME_POLICY_INSPECTION_UNAVAILABLE",
    "Mill could not inspect the selected policy, commits, or Git ancestry. Restore access to Git and readable committed evidence, then retry the same selection.",
    ExitCode.io,
  );
}

function ancestryInspectionUnavailable(): never {
  throw new MillError(
    "MAINTAINED_OUTCOME_ANCESTRY_INSPECTION_UNAVAILABLE",
    "Mill could not verify the selected Git ancestry within its inspection limits. Check that the committed history is complete and intact.",
    ExitCode.io,
  );
}

const scopes = {
  "select-policy": "Select the approved policy for this exact subject.",
  "resolve-inputs":
    "Supply readable, regular committed runtime and check inputs.",
  verify:
    "Request independent verification of the supplied artifact digest and listed inputs.",
  "review-failure":
    "Review the failed verification and decide whether to approve a bounded task to restore the claim under the same policy and check.",
  accept:
    "Review the verification and record a separate decision for this exact subject.",
  none: "The selected records require no further decision for the supplied inputs.",
} as const;

type Assessment = Pick<MaintainedOutcomeHandoff, "status" | "reason"> & {
  changedInputs?: MaintainedOutcomeHandoff["changedInputs"];
  unavailableInputs?: MaintainedOutcomeHandoff["unavailableInputs"];
  verification?: NonNullable<MaintainedOutcomeHandoff["verification"]>;
};

interface HandoffInput {
  root: string;
  policyPath: string;
  policyCommit: string;
  subjectCommit: string;
  artifactDigest: string;
  evidencePath?: string;
  acceptancePath?: string;
  now?: Date;
}

export async function maintainedOutcomeHandoff(
  input: HandoffInput,
): Promise<MaintainedOutcomeHandoff> {
  const { root, policyPath, policyCommit, subjectCommit, artifactDigest } =
    input;
  const fixedTime = input.now?.getTime();
  if (
    !maintainedOutcomePathSchema.safeParse(policyPath).success ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifactDigest) ||
    (fixedTime !== undefined && !Number.isFinite(fixedTime))
  ) {
    throw new MillError(
      "INVALID_MAINTAINED_OUTCOME_INPUT",
      "A repository-relative policy path and a SHA-256 artifact digest are required.",
      ExitCode.usage,
    );
  }

  const git = await gitReader(root);
  async function resolvesCommit(identity: string): Promise<boolean> {
    const result = await git.commit(identity);
    if (result === undefined) policyInspectionUnavailable();
    return result;
  }

  if (
    !(await resolvesCommit(policyCommit)) ||
    !(await resolvesCommit(subjectCommit))
  ) {
    throw new MillError(
      "INVALID_MAINTAINED_OUTCOME_COMMIT",
      "Policy and subject must select locally available full Git commit IDs.",
      ExitCode.data,
    );
  }

  const approvedPolicy = await git.blob(
    policyCommit,
    policyPath,
    maxPolicyBytes,
  );
  if (approvedPolicy === undefined) policyInspectionUnavailable();
  const policyBytes = approvedPolicy?.bytes;
  const parsed = maintainedOutcomePolicySchema.safeParse(
    policyBytes === undefined ? null : decode(policyBytes),
  );
  if (!parsed.success || policyBytes === undefined) {
    throw new MillError(
      "INVALID_MAINTAINED_OUTCOME_POLICY",
      "The selected commit must contain a bounded regular maintained outcome policy with unique JSON member names.",
      ExitCode.configuration,
    );
  }
  const policy = parsed.data;
  const { outcomeId, claim, owner } = policy;
  const trustedPolicyBytes = policyBytes;
  const policyDigest = digest(trustedPolicyBytes);
  const authority = { outcomeId, policyPath, policyCommit, policyDigest };

  const [rawVerification, rawAcceptance] = await Promise.all([
    readRecord(root, input.evidencePath),
    readRecord(root, input.acceptancePath),
  ]);
  let request: MaintainedOutcomeRequest | null = null;

  function ownerAcceptance(
    assessment: Assessment,
    now: number,
  ): MaintainedOutcomeHandoff["ownerAcceptance"] {
    if (rawAcceptance === undefined) return "not_recorded";
    const candidate =
      maintainedOutcomeAcceptanceSchema.safeParse(rawAcceptance);
    if (
      !candidate.success ||
      !signed(
        candidate.data.payload,
        candidate.data.signature,
        policy.ownerPublicKeyPem,
      ) ||
      Date.parse(candidate.data.payload.acceptedAt) > now
    )
      return "invalid";
    const acceptance = candidate.data.payload;
    if (
      assessment.status !== "current" ||
      assessment.verification === undefined ||
      acceptance.outcomeId !== outcomeId ||
      acceptance.policyPath !== policyPath ||
      acceptance.policyCommit !== policyCommit ||
      acceptance.policyDigest !== policyDigest ||
      acceptance.subjectCommit !== subjectCommit ||
      acceptance.verificationDigest !== assessment.verification.digest
    )
      return "stale";
    if (
      Date.parse(acceptance.acceptedAt) <
      Date.parse(assessment.verification.producedAt)
    )
      return "invalid";
    return "accepted";
  }

  function handoff(
    assessment: Assessment,
    action?: MaintainedOutcomeHandoff["next"]["action"],
    now = fixedTime ?? Date.now(),
  ): MaintainedOutcomeHandoff {
    const acceptance = ownerAcceptance(assessment, now);
    const nextAction =
      action ??
      (assessment.status === "current"
        ? acceptance === "accepted"
          ? "none"
          : "accept"
        : assessment.status === "failed"
          ? "review-failure"
          : "verify");
    return maintainedOutcomeHandoffSchema.parse({
      schemaVersion: "1",
      ...authority,
      claim,
      owner,
      subjectCommit,
      artifactDigest,
      request,
      evidenceScope: "supplied-artifact-digest-and-selected-records",
      status: assessment.status,
      reason: assessment.reason,
      changedInputs: assessment.changedInputs ?? [],
      unavailableInputs: assessment.unavailableInputs ?? [],
      verification: assessment.verification ?? null,
      ownerAcceptance: acceptance,
      next: { action: nextAction, owner, scope: scopes[nextAction] },
      authorizationGranted: false,
    });
  }

  async function isAncestor(older: string, newer: string): Promise<boolean> {
    const result = await git.ancestor(older, newer);
    if (result === undefined) ancestryInspectionUnavailable();
    return result;
  }

  async function usesApprovedPolicy(commit: string): Promise<boolean> {
    if (!(await isAncestor(policyCommit, commit))) return false;
    const file = await git.blob(commit, policyPath, maxPolicyBytes);
    if (file === undefined) policyInspectionUnavailable();
    return file?.bytes.equals(trustedPolicyBytes) ?? false;
  }

  if (!(await usesApprovedPolicy(subjectCommit))) {
    return handoff(
      { status: "stale", reason: "POLICY_CHANGED", changedInputs: ["policy"] },
      "select-policy",
    );
  }

  async function readInputs(commit: string) {
    const [runtime, check] = await Promise.all([
      git.blob(commit, policy.runtimePath, maxInputBytes),
      git.blob(commit, policy.checkPath, maxInputBytes),
    ]);
    return {
      runtimeDigest: runtime ? digest(runtime.bytes) : undefined,
      check: check
        ? { digest: digest(check.bytes), mode: check.mode }
        : undefined,
    };
  }

  const subject = await readInputs(subjectCommit);
  if (subject.runtimeDigest === undefined || subject.check === undefined) {
    const unavailableInputs: MaintainedOutcomeHandoff["unavailableInputs"] = [];
    if (subject.runtimeDigest === undefined) unavailableInputs.push("runtime");
    if (subject.check === undefined) unavailableInputs.push("check");
    return handoff(
      { status: "unverified", reason: "INPUTS_UNAVAILABLE", unavailableInputs },
      "resolve-inputs",
    );
  }
  request = {
    schemaVersion: "1",
    ...authority,
    subjectCommit,
    inputs: {
      artifactDigest,
      runtimeDigest: subject.runtimeDigest,
      checkDigest: subject.check.digest,
      checkMode: subject.check.mode,
    },
  };

  if (rawVerification === undefined)
    return handoff({ status: "unverified", reason: "VERIFICATION_MISSING" });
  const evidence =
    maintainedOutcomeVerificationSchema.safeParse(rawVerification);
  if (
    !evidence.success ||
    !signed(
      evidence.data.payload,
      evidence.data.signature,
      policy.verifierPublicKeyPem,
    )
  )
    return handoff({ status: "unverified", reason: "VERIFICATION_INVALID" });

  const proof = evidence.data.payload.request;
  if (
    proof.outcomeId !== outcomeId ||
    proof.policyPath !== policyPath ||
    proof.policyCommit !== policyCommit ||
    proof.policyDigest !== policyDigest ||
    !(await resolvesCommit(proof.subjectCommit)) ||
    !(await isAncestor(proof.subjectCommit, subjectCommit)) ||
    !(await usesApprovedPolicy(proof.subjectCommit))
  )
    return handoff({
      status: "unverified",
      reason: "VERIFICATION_NOT_APPLICABLE",
    });

  const verified =
    proof.subjectCommit === subjectCommit
      ? subject
      : await readInputs(proof.subjectCommit);
  if (
    verified.runtimeDigest !== proof.inputs.runtimeDigest ||
    verified.check?.digest !== proof.inputs.checkDigest ||
    verified.check.mode !== proof.inputs.checkMode
  )
    return handoff({
      status: "unverified",
      reason: "VERIFICATION_NOT_APPLICABLE",
    });

  const verification = {
    digest: canonicalDigest(evidence.data),
    subjectCommit: proof.subjectCommit,
    producedAt: evidence.data.payload.producedAt,
    result: evidence.data.payload.result,
  };
  const changedInputs: MaintainedOutcomeHandoff["changedInputs"] = [];
  if (artifactDigest !== proof.inputs.artifactDigest)
    changedInputs.push("artifact");
  if (subject.runtimeDigest !== proof.inputs.runtimeDigest)
    changedInputs.push("runtime");
  if (
    subject.check.digest !== proof.inputs.checkDigest ||
    subject.check.mode !== proof.inputs.checkMode
  )
    changedInputs.push("check");
  const now = fixedTime ?? Date.now();
  const age = now - Date.parse(verification.producedAt);
  let assessment: Assessment;
  if (age < 0) {
    assessment = { status: "unverified", reason: "VERIFICATION_INVALID" };
  } else if (changedInputs.length > 0) {
    assessment = {
      status: "stale",
      reason: "INPUTS_CHANGED",
      changedInputs,
      verification,
    };
  } else if (age >= policy.maxAgeSeconds * 1000) {
    assessment = {
      status: "stale",
      reason: "VERIFICATION_EXPIRED",
      verification,
    };
  } else if (verification.result === "failed") {
    assessment = {
      status: "failed",
      reason: "VERIFICATION_FAILED",
      verification,
    };
  } else {
    assessment = {
      status: "current",
      reason: "VERIFICATION_PASSED",
      verification,
    };
  }
  return handoff(assessment, undefined, now);
}
