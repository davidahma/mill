#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Attended local accounting, never admission or delivery authority.
const limit = 1024 * 1024;
const eventLimit = 128;
const workerKey = (attempt, phase) =>
  phase === "validation" ? `validation:${attempt}` : attempt;
const implementation = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
const sha = /^[a-f0-9]{40}$/u;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const insist = (condition, message) => {
  if (!condition) throw Error(message);
};
const fields = (v, keys) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === keys.slice().sort().join(",");
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const controlName = (name) =>
  ["lock", "reconcile-lock"].includes(name) ||
  /^reconcile-[a-f0-9]{64}$/u.test(name);
const controlNames = (directory) =>
  readdirSync(directory).filter(controlName).sort();
const text = (v) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 4000;
function safeFile(file) {
  const stat = lstatSync(file);
  insist(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit,
    "Unsafe session evidence file",
  );
  insist(
    realpathSync(file) === file,
    "Session evidence cannot use symlink aliases",
  );
  return readFileSync(file);
}
function json(file) {
  return JSON.parse(safeFile(file).toString("utf8"));
}
function external(file, root) {
  insist(
    typeof file === "string" && path.isAbsolute(file),
    "Session paths must be absolute",
  );
  const resolved = path.join(
    realpathSync(path.dirname(file)),
    path.basename(file),
  );
  insist(
    resolved !== root && !resolved.startsWith(root + path.sep),
    "Session evidence must stay outside the repository",
  );
  if (existsSync(resolved))
    insist(
      realpathSync(resolved) === resolved &&
        !lstatSync(resolved).isSymbolicLink(),
      "Session path cannot be a symlink",
    );
  return resolved;
}
function pathsValid(paths) {
  return (
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.length <= 100 &&
    new Set(paths).size === paths.length &&
    paths.every(
      (p) =>
        text(p) &&
        !p.includes("\\") &&
        !p.startsWith("/") &&
        p.split("/").every((s) => s !== "" && s !== "." && s !== "..") &&
        (!p.includes("*") ||
          (p.endsWith("/**") && !p.slice(0, -3).includes("*"))),
    )
  );
}
const allows = (patterns, p) =>
  patterns.some(
    (pattern) =>
      pattern === p ||
      (pattern.endsWith("/**") && p.startsWith(pattern.slice(0, -2))),
  );
function policyValid(p) {
  insist(
    fields(p, [
      "version",
      "id",
      "root",
      "base",
      "allowedPaths",
      "maxRounds",
      "recoveryRounds",
      "maxModelTokens",
      "maxElapsedMs",
      "maxHostedRequests",
    ]) &&
      p.version === 1 &&
      /^[a-zA-Z0-9_-]{1,80}$/u.test(p.id) &&
      typeof p.root === "string" &&
      path.isAbsolute(p.root) &&
      realpathSync(p.root) === p.root &&
      sha.test(p.base) &&
      pathsValid(p.allowedPaths) &&
      positive(p.maxRounds) &&
      p.maxRounds <= 10 &&
      positive(p.recoveryRounds) &&
      p.recoveryRounds < p.maxRounds &&
      (p.maxModelTokens === null || positive(p.maxModelTokens)) &&
      positive(p.maxElapsedMs) &&
      Number.isSafeInteger(p.maxHostedRequests) &&
      p.maxHostedRequests >= 0 &&
      p.maxHostedRequests <= 10,
    "Malformed session policy",
  );
}
function findingValid(f) {
  return (
    fields(f, [
      "id",
      "priority",
      "subsystem",
      "description",
      ...(f.defectId === undefined ? [] : ["defectId"]),
    ]) &&
    ["P0", "P1", "P2", "P3"].includes(f.priority) &&
    [f.id, f.subsystem, f.description].every(text) &&
    (f.defectId === undefined || text(f.defectId))
  );
}
export function defectIdentity(finding) {
  return (
    finding.defectId ??
    `DEF-${hash(JSON.stringify([finding.subsystem.trim(), finding.description.trim().replace(/\s+/gu, " ")])).slice(0, 24)}`
  );
}
function ownerValid(owner) {
  return (
    fields(owner, ["version", "pid", "acquiredAt"]) &&
    owner.version === 1 &&
    positive(owner.pid) &&
    positive(owner.acquiredAt)
  );
}
function inactive(owner) {
  insist(ownerValid(owner), "Controller owner is unknown or malformed");
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    insist(
      error?.code === "ESRCH",
      "Controller activity cannot be established",
    );
    return;
  }
  throw Error("Controller is still active; reconciliation denied");
}
function workerActivity(worker) {
  if (worker.status === "not_started") return "inactive";
  if (worker.processGroup === null) return "unknown";
  try {
    process.kill(-worker.processGroup, 0);
    return "active";
  } catch (error) {
    return error?.code === "ESRCH" ? "inactive" : "unknown";
  }
}
function insistWorkersInactive(state) {
  for (const worker of state.workers.values()) {
    const activity = workerActivity(worker);
    insist(
      activity !== "unknown",
      `Uncertain ${worker.phase ?? "reviewer"} launch identity; retain the journal and reconcile worker ownership externally`,
    );
    insist(
      activity === "inactive",
      `Recorded ${worker.phase ?? "reviewer"} process group is still active; reconciliation denied`,
    );
  }
}
function load(directory) {
  insist(
    realpathSync(directory) === directory &&
      !lstatSync(directory).isSymbolicLink(),
    "Session path cannot be a symlink",
  );
  const header = json(path.join(directory, "policy.json"));
  insist(
    fields(header, ["implementation", "createdAt", "policy"]) &&
      header.implementation === implementation &&
      positive(header.createdAt),
    "Session implementation or header changed",
  );
  policyValid(header.policy);
  const names = readdirSync(directory)
    .filter((n) => !controlName(n) && n !== "policy.json")
    .sort();
  insist(
    names.length <= eventLimit &&
      names.every((n, i) => n === `event-${String(i).padStart(3, "0")}.json`),
    "Session journal has missing or unexpected entries",
  );
  const events = names.map((n) => json(path.join(directory, n)));
  const workers = new Map();
  let pending = null,
    activeBase = header.policy.base,
    lastAt = header.createdAt;
  for (const [i, e] of events.entries()) {
    insist(positive(e.at) && e.at >= lastAt, "Malformed session event time");
    lastAt = e.at;
    if (e.kind === "attempt") {
      insist(
        fields(e, [
          "kind",
          "at",
          "head",
          "receipt",
          "purpose",
          ...(e.controller === undefined ? [] : ["controller", "base"]),
        ]) &&
          pending === null &&
          sha.test(e.head) &&
          path.isAbsolute(e.receipt) &&
          ["candidate", "acceptance"].includes(e.purpose) &&
          (e.controller === undefined ||
            (ownerValid(e.controller) && e.base === activeBase)),
        "Malformed or overlapping review attempt",
      );
      pending = i;
    } else if (e.kind === "result") {
      insist(
        fields(e, [
          "kind",
          "at",
          "attempt",
          "head",
          "receiptDigest",
          "usage",
          "findings",
        ]) &&
          e.attempt === pending &&
          pending !== null &&
          e.head === events[pending].head &&
          /^[a-f0-9]{64}$/u.test(e.receiptDigest) &&
          fields(e.usage, ["source", "inputTokens", "outputTokens"]) &&
          ["measured", "unavailable"].includes(e.usage.source) &&
          [e.usage.inputTokens, e.usage.outputTokens].every(
            (v) => v === null || (Number.isSafeInteger(v) && v >= 0),
          ) &&
          (e.usage.source !== "measured" ||
            (e.usage.inputTokens !== null && e.usage.outputTokens !== null)) &&
          Array.isArray(e.findings) &&
          e.findings.length <= 100 &&
          e.findings.every(findingValid),
        "Malformed review result",
      );
      pending = null;
    } else if (e.kind === "failed") {
      insist(
        fields(e, ["kind", "at", "attempt", "usage"]) &&
          e.attempt === pending &&
          pending !== null &&
          fields(e.usage, ["source", "inputTokens", "outputTokens"]) &&
          ["measured", "unavailable"].includes(e.usage.source) &&
          [e.usage.inputTokens, e.usage.outputTokens].every(
            (v) => v === null || (Number.isSafeInteger(v) && v >= 0),
          ) &&
          (e.usage.source !== "measured" ||
            (e.usage.inputTokens !== null && e.usage.outputTokens !== null)),
        "Malformed failed attempt",
      );
      pending = null;
    } else if (["model-admission", "validation-admission"].includes(e.kind)) {
      const phase =
          e.kind === "validation-admission" ? "validation" : "reviewer",
        key = workerKey(pending, phase);
      insist(
        fields(e, ["kind", "at", "attempt"]) &&
          e.attempt === pending &&
          pending !== null &&
          !workers.has(key),
        "Malformed or duplicate reviewer admission",
      );
      workers.set(key, { status: "admitted", processGroup: null, phase });
    } else if (
      [
        "worker",
        "worker-not-started",
        "validation-worker",
        "validation-not-started",
      ].includes(e.kind)
    ) {
      const phase = e.kind.startsWith("validation-")
          ? "validation"
          : "reviewer",
        key = workerKey(pending, phase),
        started = ["worker", "validation-worker"].includes(e.kind);
      const worker = workers.get(key);
      insist(
        fields(e, [
          "kind",
          "at",
          "attempt",
          ...(started ? ["processGroup"] : []),
        ]) &&
          e.attempt === pending &&
          pending !== null &&
          worker?.status === "admitted" &&
          worker.processGroup === null &&
          (!started || positive(e.processGroup)),
        "Malformed reviewer process ownership",
      );
      workers.set(key, {
        status: started ? "started" : "not_started",
        processGroup: e.processGroup ?? null,
        phase,
      });
    } else if (e.kind === "replan") {
      insist(
        pending === null &&
          fields(e, [
            "kind",
            "at",
            "head",
            "paths",
            "design",
            "verification",
            "acceptanceChanged",
            "acceptanceReview",
          ]) &&
          sha.test(e.head) &&
          pathsValid(e.paths) &&
          e.paths.every((p) => allows(header.policy.allowedPaths, p)) &&
          text(e.design) &&
          text(e.verification) &&
          typeof e.acceptanceChanged === "boolean" &&
          (e.acceptanceReview === null ||
            fields(e.acceptanceReview, ["path", "digest"])),
        "Malformed recovery plan",
      );
      insist(
        events.slice(0, i).filter((x) => x.kind === "replan").length === 0,
        "Recovery allowance already used",
      );
    } else if (e.kind === "continuation") {
      insist(
        pending === null &&
          fields(e, [
            "kind",
            "at",
            "previousBase",
            "base",
            "reason",
            "approvalDigest",
          ]) &&
          e.previousBase === activeBase &&
          sha.test(e.base) &&
          e.base !== activeBase &&
          text(e.reason) &&
          /^sha256:[a-f0-9]{64}$/u.test(e.approvalDigest),
        "Malformed approved continuation",
      );
      activeBase = e.base;
    } else if (e.kind === "reconciled") {
      insist(
        fields(e, [
          "kind",
          "at",
          "attempt",
          "controls",
          "usage",
          "approvalDigest",
        ]) &&
          e.attempt === pending &&
          Array.isArray(e.controls) &&
          e.controls.every(
            (c) =>
              fields(c, ["name", "owner", "digest"]) &&
              controlName(c.name) &&
              ownerValid(c.owner) &&
              /^[a-f0-9]{64}$/u.test(c.digest),
          ) &&
          /^sha256:[a-f0-9]{64}$/u.test(e.approvalDigest) &&
          (pending === null
            ? e.usage === null
            : fields(e.usage, ["source", "inputTokens", "outputTokens"]) &&
              e.usage.source === "unavailable" &&
              e.usage.inputTokens === null &&
              e.usage.outputTokens === null),
        "Malformed reconciliation evidence",
      );
      pending = null;
    } else {
      insist(
        e.kind === "hosted-request" &&
          pending === null &&
          fields(e, ["kind", "at", "head", "reason"]) &&
          sha.test(e.head) &&
          text(e.reason),
        "Malformed session event",
      );
    }
  }
  return { ...header, events, pending, directory, activeBase, workers };
}
function append(state, event) {
  insist(state.events.length < eventLimit, "Session journal limit exhausted");
  const file = path.join(
    state.directory,
    `event-${String(state.events.length).padStart(3, "0")}.json`,
  );
  const bytes = JSON.stringify(event) + "\n";
  insist(Buffer.byteLength(bytes) <= limit, "Session event too large");
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  state.events.push(event);
}
function acquireLock(directory, name = "lock") {
  if (name === "lock")
    insist(
      !controlNames(directory).some((n) => n !== "lock"),
      "Session reconciliation lock is held",
    );
  const lock = path.join(directory, name);
  mkdirSync(lock, { mode: 0o700 });
  const owner = { version: 1, pid: process.pid, acquiredAt: Date.now() };
  try {
    writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    rmSync(lock, { recursive: true });
    throw error;
  }
  return { lock, owner };
}
function locked(directory, action) {
  const { lock } = acquireLock(directory);
  try {
    return action(load(directory));
  } finally {
    rmSync(lock, { recursive: true });
  }
}
function defectLedger(s) {
  const ledger = new Map();
  for (const result of s.events.filter(
    (e) => e.kind === "result" && s.events[e.attempt].purpose === "candidate",
  )) {
    for (const item of ledger.values()) item.status = "not_reported";
    for (const finding of result.findings) {
      const defectId = defectIdentity(finding);
      const prior = ledger.get(defectId);
      ledger.set(defectId, {
        defectId,
        id: finding.id,
        subsystem: finding.subsystem,
        priority: finding.priority,
        description: finding.description,
        disposition: ["P0", "P1"].includes(finding.priority)
          ? "blocking"
          : "advisory",
        status: "active",
        firstHead: prior?.firstHead ?? result.head,
        lastHead: result.head,
        occurrences: (prior?.occurrences ?? 0) + 1,
      });
    }
  }
  return [...ledger.values()].sort((a, b) =>
    a.defectId.localeCompare(b.defectId),
  );
}
function controllerState(directory) {
  return [...new Set(["lock", ...controlNames(directory)])].map((name) => {
    const lock = path.join(directory, name);
    if (!existsSync(lock)) return { name, status: "absent", owned: false };
    try {
      const owner = json(path.join(lock, "owner.json"));
      if (!ownerValid(owner)) return { name, status: "unknown", owned: false };
      try {
        process.kill(owner.pid, 0);
        return { name, status: "active", owned: owner.pid === process.pid };
      } catch (error) {
        return {
          name,
          status: error?.code === "ESRCH" ? "inactive" : "unknown",
          owned: false,
        };
      }
    } catch {
      return { name, status: "unknown", owned: false };
    }
  });
}
function summary(s) {
  const attempts = s.events.filter((e) => e.kind === "attempt"),
    results = s.events.filter((e) => e.kind === "result");
  const recoveryUsed = s.events.some((e) => e.kind === "replan");
  const measurements = s.events.filter(
    (e) =>
      e.kind === "result" ||
      e.kind === "failed" ||
      (e.kind === "reconciled" && e.usage !== null),
  );
  const unavailable =
    s.pending !== null ||
    measurements.some((e) => e.usage.source !== "measured");
  const modelTokens = measurements.reduce(
    (n, e) => n + (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0),
    0,
  );
  insist(Number.isSafeInteger(modelTokens), "Cumulative token overflow");
  const candidates = results.filter(
    (e) => s.events[e.attempt].purpose === "candidate",
  );
  const last = candidates.at(-1),
    blocking =
      last?.findings.filter((f) => ["P0", "P1"].includes(f.priority)) ?? [];
  const repeated = blocking
    .filter(
      (f) =>
        candidates.filter((e) =>
          e.findings.some(
            (prior) =>
              ["P0", "P1"].includes(prior.priority) &&
              defectIdentity(prior) === defectIdentity(f),
          ),
        ).length >= 2,
    )
    .map((f) => f.subsystem);
  const normal = s.policy.maxRounds - s.policy.recoveryRounds;
  const needsReplan =
    !recoveryUsed && (repeated.length > 0 || attempts.length >= normal);
  const blockers = [];
  const controllers = controllerState(s.directory);
  if (controllers.some((c) => !c.owned && c.status === "active"))
    blockers.push("controller-active");
  if (controllers.some((c) => ["inactive", "unknown"].includes(c.status)))
    blockers.push("controller-reconciliation-required");
  const workerActivities = [...s.workers.values()].map(workerActivity);
  if (workerActivities.includes("active"))
    blockers.push("review-worker-active");
  if (workerActivities.includes("unknown"))
    blockers.push("review-worker-unknown");
  if (s.pending !== null) blockers.push("incomplete-attempt");
  if (attempts.length >= s.policy.maxRounds) blockers.push("round-limit");
  if (Date.now() - s.createdAt >= s.policy.maxElapsedMs)
    blockers.push("elapsed-limit");
  if (
    s.policy.maxModelTokens !== null &&
    (unavailable || modelTokens >= s.policy.maxModelTokens)
  )
    blockers.push(
      unavailable ? "token-measurement-unavailable" : "token-limit",
    );
  const latestAttempt = attempts.at(-1),
    latestResult = s.events
      .filter((e) => !["hosted-request", "reconciled"].includes(e.kind))
      .at(-1);
  const readyToPush = Boolean(
    last &&
    blocking.length === 0 &&
    s.pending === null &&
    !blockers.some(
      (code) =>
        code.startsWith("controller-") || code.startsWith("review-worker-"),
    ) &&
    latestAttempt?.purpose === "candidate" &&
    latestResult?.kind === "result" &&
    latestResult.attempt === s.events.indexOf(latestAttempt) &&
    (latestAttempt.base ?? s.policy.base) === s.activeBase,
  );
  return {
    id: s.policy.id,
    initialBase: s.policy.base,
    activeBase: s.activeBase,
    createdAt: s.createdAt,
    deadlineAt: s.createdAt + s.policy.maxElapsedMs,
    readyToPush,
    controllers: controllers.map(({ name, status }) => ({ name, status })),
    rounds: attempts.length,
    modelTokens,
    modelTokensAreComplete: !unavailable,
    unknownUsageAttempts:
      measurements.filter((e) => e.usage.source !== "measured").length +
      (s.pending === null ? 0 : 1),
    usage: unavailable ? "partial" : "measured",
    elapsedMs: Math.max(0, Date.now() - s.createdAt),
    hostedRequests: s.events.filter((e) => e.kind === "hosted-request").length,
    hostedTokens: "unavailable",
    recoveryUsed,
    repeatedSubsystems: [...new Set(repeated)],
    repeatedDefects: [
      ...new Set(
        blocking
          .filter(
            (f) =>
              candidates.filter((e) =>
                e.findings.some(
                  (prior) =>
                    ["P0", "P1"].includes(prior.priority) &&
                    defectIdentity(prior) === defectIdentity(f),
                ),
              ).length >= 2,
          )
          .map(defectIdentity),
      ),
    ].sort(),
    defects: defectLedger(s),
    blockingFindings: blocking,
    replanRequired: needsReplan,
    nextAction: readyToPush
      ? "review-or-ship"
      : blockers.length
        ? "reconcile-or-stop"
        : needsReplan
          ? "reassess-and-replan"
          : blocking.length
            ? "repair-and-review"
            : "review-candidate",
    blockers,
    authority: "local-evidence-only",
  };
}
export function beginReviewSession(directory, context) {
  directory = external(directory, context.root);
  const { lock, owner } = acquireLock(directory);
  let state,
    attempt,
    closed = false,
    finished = false;
  const close = () => {
    if (!closed) {
      rmSync(lock, { recursive: true });
      closed = true;
    }
  };
  try {
    state = load(directory);
    insist(
      state.policy.root === context.root && state.activeBase === context.base,
      "Session repository or base changed",
    );
    insist(
      context.changedPaths.every((p) => allows(state.policy.allowedPaths, p)),
      "Candidate exceeds session scope",
    );
    insist(
      ["candidate", "acceptance"].includes(context.purpose),
      "Unknown review purpose",
    );
    const view = summary(state);
    insist(
      state.events.length + 6 <= eventLimit,
      "Session journal lacks space for a complete review attempt",
    );
    insist(
      view.blockers.length === 0,
      `Session blocked: ${view.blockers.join(", ")}`,
    );
    insist(
      !view.replanRequired ||
        (context.purpose === "acceptance" &&
          !state.events.some(
            (e) => e.kind === "attempt" && e.purpose === "acceptance",
          )),
      "Session requires a bounded replan before another review",
    );
    insist(
      !state.events.some(
        (e) => e.kind === "attempt" && e.receipt === context.receipt,
      ),
      "Receipt already reserved by this session",
    );
    const history = state.events
      .filter((e) =>
        ["result", "replan", "continuation", "reconciled"].includes(e.kind),
      )
      .map((e) =>
        e.kind === "result"
          ? {
              ...e,
              findings: e.findings.map((f) => ({
                ...f,
                defectId: defectIdentity(f),
              })),
            }
          : e,
      );
    insist(
      Buffer.byteLength(JSON.stringify(history)) <= 128 * 1024,
      "Prior review context exceeds 128 KiB; reconcile before more spend",
    );
    attempt = state.events.length;
    append(state, {
      kind: "attempt",
      at: Date.now(),
      head: context.head,
      receipt: context.receipt,
      purpose: context.purpose,
      base: context.base,
      controller: owner,
    });
    const admit = (phase) => {
      insist(
        Date.now() - state.createdAt < state.policy.maxElapsedMs,
        `Session blocked: elapsed-limit before ${phase === "validation" ? "validation" : "model invocation"}`,
      );
      const key = workerKey(attempt, phase);
      insist(!state.workers.has(key), "Worker invocation already admitted");
      append(state, {
        kind:
          phase === "validation" ? "validation-admission" : "model-admission",
        at: Date.now(),
        attempt,
      });
      state.workers.set(key, { status: "admitted", processGroup: null, phase });
    };
    return {
      history,
      beforeModel() {
        admit("reviewer");
      },
      beforeValidation() {
        admit("validation");
      },
      workerStarted(processGroup, phase = "reviewer") {
        insist(
          ["reviewer", "validation"].includes(phase),
          "Unknown worker phase",
        );
        const key = workerKey(attempt, phase);
        insist(
          positive(processGroup) &&
            state.workers.get(key)?.status === "admitted",
          "Malformed reviewer process ownership",
        );
        append(state, {
          kind: phase === "validation" ? "validation-worker" : "worker",
          at: Date.now(),
          attempt,
          processGroup,
        });
        state.workers.set(key, { status: "started", processGroup, phase });
      },
      workerNotStarted(phase = "reviewer") {
        insist(
          ["reviewer", "validation"].includes(phase),
          "Unknown worker phase",
        );
        const key = workerKey(attempt, phase);
        insist(
          state.workers.get(key)?.status === "admitted",
          "Reviewer launch is already recorded",
        );
        append(state, {
          kind:
            phase === "validation"
              ? "validation-not-started"
              : "worker-not-started",
          at: Date.now(),
          attempt,
        });
        state.workers.set(key, {
          status: "not_started",
          processGroup: null,
          phase,
        });
      },
      complete(evidence) {
        insist(!finished, "Review attempt already completed");
        insistWorkersInactive(state);
        const usage = evidence.usage;
        append(state, {
          kind: "result",
          at: Date.now(),
          attempt,
          head: context.head,
          receiptDigest: hash(safeFile(context.receipt)),
          usage: {
            source: usage.source,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          },
          findings: evidence.review.findings,
        });
        finished = true;
        return summary(state);
      },
      fail(usage) {
        if (!finished) {
          append(state, {
            kind: "failed",
            at: Date.now(),
            attempt,
            usage: {
              source: usage.source,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            },
          });
          finished = true;
        }
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
export function checkSessionReceipt(directory, context) {
  directory = external(directory, context.root);
  return locked(directory, (state) => {
    insist(
      state.policy.root === context.root && state.activeBase === context.base,
      "Session repository or base changed",
    );
    const latestAttempt = state.events
      .filter((e) => e.kind === "attempt")
      .at(-1);
    insist(
      state.pending === null &&
        latestAttempt?.purpose === (context.purpose ?? "candidate") &&
        latestAttempt.receipt === context.receipt,
      "Session receipt is superseded or an attempt is incomplete",
    );
    const result = state.events.find(
      (e) =>
        e.kind === "result" &&
        state.events[e.attempt].receipt === context.receipt,
    );
    insist(
      result?.head === context.head &&
        result.receiptDigest === hash(safeFile(context.receipt)),
      "Session receipt missing or changed",
    );
    return summary(state);
  });
}
function stateDigest(state) {
  return hash(
    JSON.stringify({
      implementation: state.implementation,
      createdAt: state.createdAt,
      policy: state.policy,
      events: state.events,
    }),
  );
}
function controllerControls(directory) {
  return controlNames(directory).flatMap((name) => {
    const lock = path.join(directory, name);
    if (!existsSync(lock)) return [];
    insist(
      lstatSync(lock).isDirectory() &&
        realpathSync(lock) === lock &&
        readdirSync(lock).join(",") === "owner.json",
      "Controller owner is unknown; preserve the lock",
    );
    const bytes = safeFile(path.join(lock, "owner.json")),
      owner = JSON.parse(bytes);
    inactive(owner);
    return [{ name, owner, digest: hash(bytes) }];
  });
}
function operationPlan(state, mode, request, controls = []) {
  insistWorkersInactive(state);
  const view = summary(state);
  let detail;
  if (mode === "continue") {
    insist(
      state.pending === null,
      "Reconcile the incomplete attempt before continuation",
    );
    insist(
      fields(request, ["base", "reason"]) &&
        sha.test(request.base) &&
        request.base !== state.activeBase &&
        text(request.reason),
      "Continuation requires a new immutable base and a reason",
    );
    detail = {
      previousBase: state.activeBase,
      base: request.base,
      reason: request.reason,
    };
  } else {
    insist(
      controls.length > 0 || state.pending !== null,
      "No inactive controller or incomplete attempt requires reconciliation",
    );
    if (state.pending !== null)
      inactive(state.events[state.pending].controller);
    detail = {
      controls,
      incompleteAttempt:
        state.pending === null
          ? null
          : {
              eventIndex: state.pending,
              head: state.events[state.pending].head,
              purpose: state.events[state.pending].purpose,
              usage: "unavailable",
            },
    };
  }
  const bound = {
    version: 1,
    operation: mode,
    root: state.policy.root,
    id: state.policy.id,
    stateDigest: stateDigest(state),
    ...detail,
    accounting: {
      createdAt: state.createdAt,
      deadlineAt: view.deadlineAt,
      rounds: view.rounds,
      maxRounds: state.policy.maxRounds,
      recoveryUsed: view.recoveryUsed,
      modelTokens: view.modelTokens,
      usage: view.usage,
      maxModelTokens: state.policy.maxModelTokens,
      hostedRequests: view.hostedRequests,
      maxHostedRequests: state.policy.maxHostedRequests,
    },
    authority: "local-evidence-only",
  };
  return { ...bound, approvalDigest: `sha256:${hash(JSON.stringify(bound))}` };
}
function approvedOperation(directory, root, mode, request, approve, attended) {
  const state = load(directory);
  insist(state.policy.root === root, "Session root changed");
  const controls = mode === "reconcile" ? controllerControls(directory) : [];
  if (mode === "continue")
    insist(
      controlNames(directory).length === 0,
      "Session controller lock must be reconciled before continuation",
    );
  const plan = operationPlan(state, mode, request, controls);
  if (approve === undefined) {
    insist(
      !attended,
      "Approval digest is required to apply an attended operation",
    );
    return { ...plan, applied: false };
  }
  insist(
    attended && approve === plan.approvalDigest,
    "Exact approval digest and attendance are required",
  );
  if (mode === "continue")
    return locked(directory, (current) => {
      insist(
        operationPlan(current, mode, request).approvalDigest === approve,
        "Continuation approval is stale",
      );
      append(current, {
        kind: "continuation",
        at: Date.now(),
        previousBase: current.activeBase,
        ...request,
        approvalDigest: approve,
      });
      current.activeBase = request.base;
      return { ...summary(current), applied: true, approvalDigest: approve };
    });
  // A separate guard serializes reconciliations while the dead controller's
  // original lock remains in place. A crash leaves another owned, reconcilable
  // guard; no missing measurement is relabeled as zero spending.
  // The exact-plan claim is atomic and never steals another reconciler's
  // newly created guard. A later approved plan may retire an inactive claim.
  const { lock } = acquireLock(directory, `reconcile-${approve.slice(7)}`);
  try {
    const current = load(directory);
    insist(
      stateDigest(current) === plan.stateDigest,
      "Reconciliation approval is stale",
    );
    for (const control of controls) {
      const bytes = safeFile(path.join(directory, control.name, "owner.json"));
      insist(
        hash(bytes) === control.digest,
        "Controller owner changed after reconciliation approval",
      );
      inactive(JSON.parse(bytes));
    }
    append(current, {
      kind: "reconciled",
      at: Date.now(),
      attempt: current.pending,
      controls,
      usage:
        current.pending === null
          ? null
          : { source: "unavailable", inputTokens: null, outputTokens: null },
      approvalDigest: approve,
    });
    current.pending = null;
    for (const control of controls)
      rmSync(path.join(directory, control.name), { recursive: true });
    return { ...summary(current), applied: true, approvalDigest: approve };
  } finally {
    rmSync(lock, { recursive: true });
  }
}
function repairHandoff(state) {
  const receipts = state.events
    .filter((e) => e.kind === "result")
    .map((e) => {
      const attempt = state.events[e.attempt];
      insist(
        hash(safeFile(external(attempt.receipt, state.policy.root))) ===
          e.receiptDigest,
        "Retained review receipt changed; handoff blocked",
      );
      return {
        head: e.head,
        purpose: attempt.purpose,
        digest: e.receiptDigest,
      };
    });
  const view = summary(state);
  const handoff = {
    version: 1,
    id: state.policy.id,
    root: state.policy.root,
    base: state.activeBase,
    head:
      state.events
        .filter((e) => e.kind === "attempt" && e.purpose === "candidate")
        .at(-1)?.head ?? null,
    sessionDigest: stateDigest(state),
    allowedPaths: state.policy.allowedPaths,
    findings: view.defects.filter((d) => d.status === "active"),
    history: view.defects.filter((d) => d.status !== "active"),
    receipts,
    replan: state.events.find((e) => e.kind === "replan") ?? null,
    accounting: {
      rounds: view.rounds,
      maxRounds: state.policy.maxRounds,
      modelTokens: view.modelTokens,
      usage: view.usage,
      maxModelTokens: state.policy.maxModelTokens,
      deadlineAt: view.deadlineAt,
      recoveryUsed: view.recoveryUsed,
    },
    blockers: view.blockers.filter(
      (code) =>
        code !== "elapsed-limit" &&
        !code.startsWith("controller-") &&
        !code.startsWith("review-worker-"),
    ),
    currentStatusRequired: true,
    fullReviewRequired: true,
    authority: "repair-context-only",
  };
  insist(
    Buffer.byteLength(JSON.stringify(handoff)) <= 128 * 1024,
    "Repair handoff exceeds 128 KiB",
  );
  return handoff;
}
function main() {
  const [mode, ...args] = process.argv.slice(2);
  const opts = {};
  insist(
    [
      "create",
      "status",
      "replan",
      "hosted",
      "reconcile",
      "continue",
      "handoff",
    ].includes(mode),
    "Usage: create|status|replan|hosted|reconcile|continue|handoff --session /external/directory [--request /external/request.json] [--approve sha256:PLAN --attended]",
  );
  for (let i = 0; i < args.length;) {
    const key = args[i++];
    insist(
      [
        "--session",
        "--request",
        ...(["reconcile", "continue"].includes(mode)
          ? ["--approve", "--attended"]
          : []),
      ].includes(key) && opts[key] === undefined,
      "Unknown or duplicate session option",
    );
    if (key === "--attended") opts[key] = true;
    else {
      insist(
        typeof args[i] === "string" && !args[i].startsWith("--"),
        "Session option requires a value",
      );
      opts[key] = args[i++];
    }
  }
  const root = realpathSync(process.cwd()),
    directory = external(opts["--session"], root);
  if (["reconcile", "continue"].includes(mode)) {
    insist(
      mode !== "reconcile" || opts["--request"] === undefined,
      "Reconciliation does not accept a replacement request",
    );
    const request =
      mode === "continue" ? json(external(opts["--request"], root)) : null;
    process.stdout.write(
      JSON.stringify(
        approvedOperation(
          directory,
          root,
          mode,
          request,
          opts["--approve"],
          opts["--attended"] === true,
        ),
      ) + "\n",
    );
    return;
  }
  if (["status", "handoff"].includes(mode)) {
    insist(
      opts["--request"] === undefined,
      "Read-only session operation does not accept a request",
    );
    const state = load(directory);
    insist(state.policy.root === root, "Session root changed");
    process.stdout.write(
      JSON.stringify(
        mode === "handoff" ? repairHandoff(state) : summary(state),
      ) + "\n",
    );
    return;
  }
  if (mode === "create") {
    const policy = json(external(opts["--request"], root));
    policyValid(policy);
    insist(policy.root === root, "Session root must match current repository");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(
      path.join(directory, "policy.json"),
      JSON.stringify({ implementation, createdAt: Date.now(), policy }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } else if (mode !== "status") {
    const request = json(external(opts["--request"], root));
    locked(directory, (state) => {
      insist(state.policy.root === root, "Session root changed");
      const view = summary(state);
      const relevantBlockers =
        mode === "hosted"
          ? view.blockers.filter(
              (code) =>
                code === "incomplete-attempt" ||
                code === "elapsed-limit" ||
                code.startsWith("review-worker-"),
            )
          : view.blockers;
      insist(
        relevantBlockers.length === 0,
        `Session blocked: ${relevantBlockers.join(", ")}`,
      );
      if (mode === "hosted") {
        insist(
          fields(request, ["head", "reason"]) &&
            sha.test(request.head) &&
            text(request.reason),
          "Malformed hosted request",
        );
        insist(
          view.hostedRequests < state.policy.maxHostedRequests,
          "Hosted request limit exhausted",
        );
        append(state, { kind: "hosted-request", at: Date.now(), ...request });
      } else {
        insist(
          view.replanRequired && !view.recoveryUsed,
          "No recovery due or allowance already used",
        );
        insist(
          fields(request, [
            "head",
            "paths",
            "design",
            "verification",
            "acceptanceChanged",
            "acceptanceReview",
          ]) &&
            request.head ===
              state.events.filter((e) => e.kind === "attempt").at(-1)?.head &&
            pathsValid(request.paths) &&
            request.paths.every((p) => allows(state.policy.allowedPaths, p)) &&
            text(request.design) &&
            text(request.verification) &&
            typeof request.acceptanceChanged === "boolean",
          "Replan must bind latest candidate and original scope",
        );
        let acceptanceReview = null;
        if (request.acceptanceChanged) {
          const file = external(request.acceptanceReview, root),
            receipt = json(file);
          insist(
            receipt.kind === "local-maintainer-review" &&
              [2, 3].includes(receipt.version) &&
              (receipt.version === 2 ||
                (receipt.purpose === "acceptance" &&
                  receipt.readyToPush === false)) &&
              receipt.identity?.root === root &&
              receipt.review?.head === request.head &&
              receipt.validation?.exitCode === 0 &&
              Array.isArray(receipt.review.findings) &&
              receipt.review.findings.every(findingValid) &&
              !receipt.review.findings.some((f) =>
                ["P0", "P1"].includes(f.priority),
              ),
            "Changed acceptance requires separate clean exact-candidate review",
          );
          const attempt = state.events.find(
            (e) => e.kind === "attempt" && e.receipt === file,
          );
          insist(
            attempt?.purpose === "acceptance" &&
              state.events.some(
                (e) =>
                  e.kind === "result" &&
                  e.head === request.head &&
                  state.events[e.attempt] === attempt,
              ),
            "Acceptance review must be a separately accounted acceptance round",
          );
          const recorded = state.events.find(
            (e) => e.kind === "result" && state.events[e.attempt] === attempt,
          );
          insist(
            recorded.receiptDigest === hash(safeFile(file)) &&
              !recorded.findings.some((f) => ["P0", "P1"].includes(f.priority)),
            "Retained acceptance review changed or has blocking findings",
          );
          const checked = spawnSync(
            process.execPath,
            [
              fileURLToPath(
                new URL("./maintainer-review.mjs", import.meta.url),
              ),
              "check",
              "--base",
              receipt.identity.base,
              "--head",
              request.head,
              "--receipt",
              file,
            ],
            { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: limit },
          );
          insist(
            checked.status === 0,
            "Acceptance review must pass the exact-candidate receipt checker",
          );
          acceptanceReview = { path: file, digest: hash(safeFile(file)) };
        } else
          insist(
            request.acceptanceReview === null,
            "Unchanged acceptance must not supply a review",
          );
        append(state, {
          kind: "replan",
          at: Date.now(),
          ...request,
          acceptanceReview,
        });
      }
    });
  }
  process.stdout.write(
    JSON.stringify(
      locked(directory, (state) => {
        insist(state.policy.root === root, "Session root changed");
        return summary(state);
      }),
    ) + "\n",
  );
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : "Session failed") + "\n",
    );
    process.exitCode = 1;
  }
}
