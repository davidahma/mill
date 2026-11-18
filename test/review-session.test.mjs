import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";

const helper = path.resolve("scripts/review-session.mjs");
const review = path.resolve("scripts/maintainer-review.mjs");
const directories = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
function fixture(overrides = {}) {
  const dir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "mill-session-test-")),
  );
  directories.push(dir);
  const root = path.join(dir, "repo"),
    bin = path.join(dir, "bin"),
    session = path.join(dir, "session");
  mkdirSync(root);
  mkdirSync(bin);
  const git = (...args) => {
    const r = spawnSync(process.env.MILL_GIT_PATH ?? "git", args, {
      cwd: root,
      encoding: "utf8",
    });
    if (r.status) throw Error(r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(path.join(root, "file.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(path.join(root, "file.txt"), "candidate\n");
  git("commit", "-qam", "candidate");
  const head = git("rev-parse", "HEAD");
  const request = path.join(dir, "policy.json");
  writeFileSync(
    request,
    JSON.stringify({
      version: 1,
      id: "fixture",
      root,
      base,
      allowedPaths: ["file.txt"],
      maxRounds: 4,
      recoveryRounds: 2,
      maxModelTokens: 100,
      maxElapsedMs: 60000,
      maxHostedRequests: 1,
      ...overrides,
    }),
  );
  const cli = (mode, extra = []) =>
    spawnSync(
      process.execPath,
      [helper, mode, "--session", session, ...extra],
      { cwd: root, encoding: "utf8" },
    );
  const create = () => cli("create", ["--request", request]);
  let round = 0;
  const run = (
    findings = [],
    usage = { input_tokens: 12, output_tokens: 3 },
    extra = [],
    validation = "console.log('validated')",
    reviewBase = base,
  ) => {
    writeFileSync(
      path.join(bin, "codex"),
      `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(path.join(dir, "prompt.txt"))},input);fs.writeFileSync(a[a.indexOf('--output-last-message')+1],${JSON.stringify(JSON.stringify({ base: reviewBase, head, findings }))}); console.log(JSON.stringify({type:'turn.completed',usage:${JSON.stringify(usage)}}));});\n`,
      { mode: 0o700 },
    );
    return spawnSync(
      process.execPath,
      [
        review,
        "run",
        "--base",
        reviewBase,
        "--head",
        head,
        "--receipt",
        path.join(dir, `receipt-${++round}.json`),
        "--validation",
        JSON.stringify([process.execPath, "-e", validation]),
        "--session",
        session,
        ...extra,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        },
      },
    );
  };
  const replan = (changes = {}) => {
    const file = path.join(dir, "replan.json");
    writeFileSync(
      file,
      JSON.stringify({
        head,
        paths: ["file.txt"],
        design: "Consolidate the parsing repair.",
        verification: "Preserve checks and exercise malformed inputs.",
        acceptanceChanged: false,
        acceptanceReview: null,
        ...changes,
      }),
    );
    return cli("replan", ["--request", file]);
  };
  return { dir, root, bin, session, base, head, cli, create, run, replan };
}
const blocker = {
  id: "R1",
  priority: "P1",
  subsystem: "parser",
  description: "file.txt:1 incorrect boundary",
};
it("retains cumulative usage and feeds prior finding history to the next full review", () => {
  const f = fixture();
  expect(f.create().status).toBe(0);
  expect(f.run([blocker]).status).toBe(1);
  expect(f.run().status).toBe(0);
  const state = JSON.parse(f.cli("status").stdout);
  expect(state.rounds).toBe(2);
  expect(state.modelTokens).toBe(30);
  expect(readFileSync(path.join(f.dir, "prompt.txt"), "utf8")).toContain(
    "incorrect boundary",
  );
});
it("routes recurrent blockers to one replan and continues without resetting total spending", () => {
  const f = fixture();
  expect(f.create().status).toBe(0);
  f.run([blocker]);
  f.run([blocker]);
  expect(JSON.parse(f.cli("status").stdout).nextAction).toBe(
    "reassess-and-replan",
  );
  expect(f.run().stderr).toContain("replan");
  expect(f.replan().status).toBe(0);
  expect(f.run().status).toBe(0);
  expect(JSON.parse(f.cli("status").stdout)).toMatchObject({
    rounds: 3,
    recoveryUsed: true,
    modelTokens: 45,
  });
  expect(f.replan().status).toBe(1);
});
it("blocks scope widening and acceptance rewrites without independent evidence", () => {
  const f = fixture();
  f.create();
  f.run([blocker]);
  f.run([blocker]);
  expect(f.replan({ paths: ["secrets.txt"] }).status).toBe(1);
  expect(f.replan({ acceptanceChanged: true }).status).toBe(1);
});
it("preserves legacy receipts and counts advisory rounds without declaring recurrence", () => {
  const f = fixture();
  f.create();
  expect(f.run([{ ...blocker, priority: "P2" }]).status).toBe(0);
  expect(JSON.parse(f.cli("status").stdout).nextAction).toBe("review-or-ship");
});
it("guards tokens and unknown measurements before another invocation", () => {
  const f = fixture({ maxModelTokens: 15 });
  f.create();
  expect(f.run().status).toBe(0);
  expect(f.run().stderr).toContain("token");
  const g = fixture();
  g.create();
  expect(g.run([], {}).status).toBe(0);
  expect(g.run().stderr).toContain("unavailable");
});
it("rejects malformed policy, concurrent writers and exhausted hosted requests", () => {
  const bad = fixture({ recoveryRounds: 4 });
  expect(bad.create().status).toBe(1);
  const f = fixture();
  f.create();
  mkdirSync(path.join(f.session, "lock"));
  expect(f.run().stderr).toContain("lock");
  rmSync(path.join(f.session, "lock"), { recursive: true });
  const args = ["--request", path.join(f.dir, "hosted.json")];
  writeFileSync(
    args[1],
    JSON.stringify({
      head: f.head,
      reason: "Automatic review absent after ready.",
    }),
  );
  expect(f.cli("hosted", args).status).toBe(0);
  expect(f.cli("hosted", args).status).toBe(1);
});
it("counts a separate acceptance review inside recovery and validates its exact receipt", () => {
  const f = fixture({ maxRounds: 5, recoveryRounds: 3 });
  f.create();
  f.run([blocker]);
  f.run([blocker]);
  expect(f.run([], undefined, ["--purpose", "acceptance"]).status).toBe(0);
  expect(
    f.replan({
      acceptanceChanged: true,
      acceptanceReview: path.join(f.dir, "receipt-3.json"),
    }).status,
  ).toBe(0);
  expect(f.run().status).toBe(0);
  expect(JSON.parse(f.cli("status").stdout).rounds).toBe(4);
});
it("rejects symlinked evidence and missing journal entries", () => {
  const f = fixture();
  f.create();
  f.run();
  const event = path.join(
      f.session,
      readdirSync(f.session)
        .filter((n) => /^event-\d{3}\.json$/u.test(n))
        .find(
          (n) =>
            JSON.parse(readFileSync(path.join(f.session, n))).kind === "result",
        ),
    ),
    copy = path.join(f.dir, "copy.json");
  writeFileSync(copy, readFileSync(event));
  rmSync(event);
  symlinkSync(copy, event);
  expect(f.cli("status").status).toBe(1);
  rmSync(event);
  expect(f.cli("status").stdout).toContain("incomplete-attempt");
  expect(f.run().stderr).toContain("incomplete-attempt");
  const g = fixture();
  g.create();
  g.run();
  rmSync(path.join(g.session, "event-001.json"));
  expect(g.cli("status").stderr).toContain("missing or unexpected");
});
it("exhausts total rounds after recovery and never renews the allowance", () => {
  const f = fixture();
  f.create();
  f.run([blocker]);
  f.run([blocker]);
  f.replan();
  f.run([blocker]);
  f.run([blocker]);
  expect(f.run().stderr).toContain("round-limit");
  expect(f.replan().status).toBe(1);
});
it("blocks elapsed limits before any model invocation", () => {
  const f = fixture({ maxElapsedMs: 1 });
  f.create();
  expect(f.run().stderr).toContain("elapsed-limit");
  expect(JSON.parse(f.cli("status").stdout).rounds).toBe(0);
});
it("retains failed validation attempts without inventing model spend", () => {
  const f = fixture();
  f.create();
  expect(f.run([], undefined, [], "process.exit(1)").status).toBe(1);
  expect(JSON.parse(f.cli("status").stdout)).toMatchObject({
    rounds: 1,
    modelTokens: 0,
    usage: "measured",
  });
  expect(f.run().status).toBe(0);
});
it("checks that the retained session receipt has not changed", () => {
  const f = fixture();
  f.create();
  f.run();
  const receipt = path.join(f.dir, "receipt-1.json");
  const value = JSON.parse(readFileSync(receipt));
  writeFileSync(receipt, JSON.stringify(value) + "\n\n");
  const checked = spawnSync(
    process.execPath,
    [
      review,
      "check",
      "--base",
      value.identity.base,
      "--head",
      f.head,
      "--receipt",
      receipt,
      "--session",
      f.session,
    ],
    { cwd: f.root, encoding: "utf8", env: process.env },
  );
  expect(checked.status).toBe(1);
  expect(checked.stderr).toContain("Session receipt");
});
it("rejects a blocking acceptance receipt rewritten into a passing report", () => {
  const f = fixture({ maxRounds: 6, recoveryRounds: 4 });
  f.create();
  f.run([blocker]);
  f.run([blocker]);
  f.run([blocker], undefined, ["--purpose", "acceptance"]);
  const receipt = path.join(f.dir, "receipt-3.json"),
    value = JSON.parse(readFileSync(receipt));
  value.review.findings = [];
  value.ledger = [];
  writeFileSync(receipt, JSON.stringify(value) + "\n");
  const replanned = f.replan({
    acceptanceChanged: true,
    acceptanceReview: receipt,
  });
  expect(replanned.status).toBe(1);
  expect(replanned.stderr).toContain("Retained acceptance");
});
it("rejects an older passing receipt after a newer blocking review", () => {
  const f = fixture();
  f.create();
  f.run();
  f.run([blocker]);
  const receipt = path.join(f.dir, "receipt-1.json");
  const value = JSON.parse(readFileSync(receipt));
  const checked = spawnSync(
    process.execPath,
    [
      review,
      "check",
      "--base",
      value.identity.base,
      "--head",
      f.head,
      "--receipt",
      receipt,
      "--session",
      f.session,
    ],
    { cwd: f.root, encoding: "utf8", env: process.env },
  );
  expect(checked.status).toBe(1);
  expect(checked.stderr).toContain("superseded");
});
it("can replan after normal rounds fail entirely during validation", () => {
  const f = fixture();
  f.create();
  f.run([], undefined, [], "process.exit(1)");
  f.run([], undefined, [], "process.exit(1)");
  expect(f.replan().status).toBe(0);
  expect(f.run().status).toBe(0);
  expect(JSON.parse(f.cli("status").stdout)).toMatchObject({
    rounds: 3,
    modelTokens: 15,
    recoveryUsed: true,
  });
});
it("rechecks time immediately before the model call", () => {
  const f = fixture({ maxElapsedMs: 5000 });
  f.create();
  const r = f.run(
    [],
    undefined,
    [],
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5100)",
  );
  expect(r.stderr).toContain("elapsed-limit");
  expect(JSON.parse(f.cli("status").stdout)).toMatchObject({
    rounds: 1,
    modelTokens: 0,
  });
});
it("retains the separate hosted-request allowance after local rounds are exhausted", () => {
  const f = fixture();
  f.create();
  f.run([blocker]);
  f.run([blocker]);
  f.replan();
  f.run([blocker]);
  f.run();
  const request = path.join(f.dir, "hosted-final.json");
  writeFileSync(
    request,
    JSON.stringify({
      head: f.head,
      reason: "Automatic review absent on the final green head.",
    }),
  );
  expect(f.cli("hosted", ["--request", request]).status).toBe(0);
});

it("never reports an acceptance-only receipt as ready to push", () => {
  const f = fixture();
  f.create();
  const result = f.run([], undefined, ["--purpose", "acceptance"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    purpose: "acceptance",
    reviewPassed: true,
    ready: false,
    readyToPush: false,
  });
  expect(
    JSON.parse(readFileSync(path.join(f.dir, "receipt-1.json"))),
  ).toMatchObject({
    purpose: "acceptance",
    readyToPush: false,
  });
  expect(JSON.parse(f.cli("status").stdout)).toMatchObject({
    readyToPush: false,
    nextAction: "review-candidate",
  });
});

it("does not confuse distinct bugs within one subsystem with a recurring defect", () => {
  const f = fixture({ maxRounds: 6, recoveryRounds: 2 });
  f.create();
  f.run([blocker]);
  f.run([{ ...blocker, description: "file.txt:2 a different boundary" }]);
  const state = JSON.parse(f.cli("status").stdout);
  expect(state.replanRequired).toBe(false);
  expect(state.defects).toHaveLength(2);
  expect(state.defects.map((d) => d.status).sort()).toEqual([
    "active",
    "not_reported",
  ]);
  expect(new Set(state.defects.map((d) => d.defectId)).size).toBe(2);
  const handoff = JSON.parse(f.cli("handoff").stdout);
  expect(handoff).toEqual(JSON.parse(f.cli("handoff").stdout));
  expect(handoff.findings).toHaveLength(1);
  expect(handoff.fullReviewRequired).toBe(true);
  expect(handoff.authority).toBe("repair-context-only");
});

it("requires exact attended continuation and preserves the original limits and spending", () => {
  const f = fixture({ maxModelTokens: 30 });
  f.create();
  f.run();
  const policyBytes = readFileSync(path.join(f.session, "policy.json"), "utf8");
  const request = path.join(f.dir, "continuation.json");
  writeFileSync(
    request,
    JSON.stringify({
      base: f.head,
      reason: "Refresh the immutable review base.",
    }),
  );
  const args = ["--request", request];
  const planned = f.cli("continue", args);
  expect(planned.status).toBe(0);
  const plan = JSON.parse(planned.stdout);
  expect(
    f.cli("continue", [...args, "--approve", plan.approvalDigest]).status,
  ).toBe(1);
  expect(
    f.cli("continue", [
      ...args,
      "--approve",
      `sha256:${"0".repeat(64)}`,
      "--attended",
    ]).status,
  ).toBe(1);
  expect(
    f.cli("continue", [...args, "--approve", plan.approvalDigest, "--attended"])
      .status,
  ).toBe(0);
  expect(readFileSync(path.join(f.session, "policy.json"), "utf8")).toBe(
    policyBytes,
  );
  expect(JSON.parse(f.cli("status").stdout)).toMatchObject({
    initialBase: f.base,
    activeBase: f.head,
    rounds: 1,
    modelTokens: 15,
    readyToPush: false,
  });
  expect(f.run().stderr).toContain("base changed");
  expect(f.run([], undefined, [], undefined, f.head).status).toBe(0);
  expect(f.run([], undefined, [], undefined, f.head).stderr).toContain(
    "token-limit",
  );
  expect(
    f.cli("continue", [...args, "--approve", plan.approvalDigest, "--attended"])
      .status,
  ).toBe(1);
});

function interrupted(
  f,
  modelAdmission = false,
  worker = false,
  phase = "reviewer",
) {
  const context = {
    root: f.root,
    base: f.base,
    head: f.head,
    receipt: path.join(f.dir, "interrupted.json"),
    changedPaths: ["file.txt"],
    purpose: "candidate",
  };
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {beginReviewSession} from ${JSON.stringify(helper)};import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const session=beginReviewSession(${JSON.stringify(f.session)},${JSON.stringify(context)});${modelAdmission ? `session.${phase === "validation" ? "beforeValidation" : "beforeModel"}();` : ""}${worker ? `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});session.workerStarted(child.pid,${JSON.stringify(phase)});writeFileSync(${JSON.stringify(path.join(f.dir, "worker.pid"))},String(child.pid));child.unref();` : ""}process.exit(0);`,
    ],
    { encoding: "utf8" },
  );
  expect(child.status).toBe(0);
}

it("reconciles an inactive interrupted controller only with exact attended approval, retaining unknown usage", () => {
  const f = fixture();
  f.create();
  interrupted(f);
  const planned = f.cli("reconcile");
  expect(planned.status).toBe(0);
  const plan = JSON.parse(planned.stdout);
  expect(plan.incompleteAttempt).not.toBe(null);
  expect(plan.accounting.usage).toBe("partial");
  expect(f.run().status).toBe(1);
  expect(f.cli("reconcile", ["--approve", plan.approvalDigest]).status).toBe(1);
  expect(
    f.cli("reconcile", ["--approve", plan.approvalDigest, "--attended"]).status,
  ).toBe(0);
  const state = JSON.parse(f.cli("status").stdout);
  expect(state).toMatchObject({
    rounds: 1,
    modelTokens: 0,
    usage: "partial",
    blockers: ["token-measurement-unavailable"],
  });
  expect(f.run().stderr).toContain("token-measurement-unavailable");
  expect(
    f.cli("reconcile", ["--approve", plan.approvalDigest, "--attended"]).status,
  ).toBe(1);
});

it("denies live and unknown-owner controller reconciliation without deleting locks", () => {
  const f = fixture();
  f.create();
  mkdirSync(path.join(f.session, "lock"));
  expect(f.cli("reconcile").stderr).toContain("owner");
  writeFileSync(
    path.join(f.session, "lock", "owner.json"),
    JSON.stringify({ version: 1, pid: process.pid, acquiredAt: Date.now() }),
  );
  expect(f.cli("reconcile").stderr).toContain("active");
  expect(
    readFileSync(path.join(f.session, "lock", "owner.json"), "utf8"),
  ).toContain(String(process.pid));
});

it("reports a stale controller lock as a readiness blocker even after a passing result", () => {
  const f = fixture();
  f.create();
  f.run();
  const lock = path.join(f.session, "lock");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(lock)});fs.writeFileSync(${JSON.stringify(path.join(lock, "owner.json"))},JSON.stringify({version:1,pid:process.pid,acquiredAt:Date.now()}));`,
    ],
    { encoding: "utf8" },
  );
  expect(child.status).toBe(0);
  const state = JSON.parse(f.cli("status").stdout);
  expect(state.readyToPush).toBe(false);
  expect(state.blockers).toContain("controller-reconciliation-required");
});

it("retains explicit stable defect identity across source-location changes", () => {
  const f = fixture({ maxRounds: 6, recoveryRounds: 2 });
  f.create();
  f.run([{ ...blocker, defectId: "DEF-boundary" }]);
  f.run([
    {
      ...blocker,
      id: "R7",
      defectId: "DEF-boundary",
      description: "file.txt:3 the same incorrect boundary moved",
    },
  ]);
  const state = JSON.parse(f.cli("status").stdout);
  expect(state.repeatedDefects).toEqual(["DEF-boundary"]);
  expect(state.defects).toHaveLength(1);
  expect(state.defects[0]).toMatchObject({
    occurrences: 2,
    disposition: "blocking",
    status: "active",
  });
});

it("supplies deterministic defect identities to full review history", () => {
  const f = fixture();
  f.create();
  f.run([blocker]);
  const defectId = JSON.parse(f.cli("status").stdout).defects[0].defectId;
  f.run();
  expect(readFileSync(path.join(f.dir, "prompt.txt"), "utf8")).toContain(
    defectId,
  );
});

it("blocks repair handoff from changed retained receipts", () => {
  const f = fixture();
  f.create();
  f.run([blocker]);
  writeFileSync(path.join(f.dir, "receipt-1.json"), "{}\n");
  expect(f.cli("handoff").stderr).toContain("receipt changed");
});

it.each(["reviewer", "validation"])(
  "refuses inactive-controller reconciliation while its %s process group remains active",
  (phase) => {
    const f = fixture();
    f.create();
    interrupted(f, true, true, phase);
    const worker = Number(readFileSync(path.join(f.dir, "worker.pid"), "utf8"));
    try {
      expect(f.cli("reconcile").stderr).toContain("process group");
    } finally {
      process.kill(-worker, "SIGKILL");
    }
  },
);

it("retains an uncertain reviewer launch instead of assuming no model started", () => {
  const f = fixture();
  f.create();
  interrupted(f, true);
  expect(f.cli("reconcile").stderr).toContain("reviewer launch identity");
  expect(JSON.parse(f.cli("status").stdout).blockers).toContain(
    "review-worker-unknown",
  );
});

it("stops only its owned reviewer group on foreground interruption and retains unavailable usage", async () => {
  const f = fixture();
  f.create();
  const marker = path.join(f.dir, "worker.pid");
  writeFileSync(
    path.join(f.bin, "codex"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);\n`,
    { mode: 0o700 },
  );
  const child = spawn(
    process.execPath,
    [
      review,
      "run",
      "--base",
      f.base,
      "--head",
      f.head,
      "--receipt",
      path.join(f.dir, "cancelled.json"),
      "--validation",
      JSON.stringify([process.execPath, "-e", "console.log('validated')"]),
      "--session",
      f.session,
    ],
    {
      cwd: f.root,
      env: {
        ...process.env,
        PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
      },
      stdio: "ignore",
    },
  );
  const closed = new Promise((resolve) =>
    child.on("close", (code) => resolve(code)),
  );
  try {
    for (let i = 0; i < 500 && !existsSync(marker); i++) await setTimeout(10);
    expect(existsSync(marker)).toBe(true);
    const worker = Number(readFileSync(marker, "utf8"));
    child.kill("SIGTERM");
    expect(await closed).toBe(1);
    expect(() => process.kill(-worker, 0)).toThrow();
    expect(JSON.parse(f.cli("status").stdout)).toMatchObject({
      rounds: 1,
      usage: "partial",
      blockers: ["token-measurement-unavailable"],
    });
  } finally {
    child.kill("SIGKILL");
    if (existsSync(marker)) {
      try {
        process.kill(-Number(readFileSync(marker, "utf8")), "SIGKILL");
      } catch {
        /* Already reaped. */
      }
    }
    await closed;
  }
});
