import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parse } from "yaml";
import {
  releaseDispatchFailures,
  releaseQualificationInputFailures,
  releasePublicationFailures,
  releaseVerifierPreparationFailures,
} from "./release-workflow-policy.mjs";

const arguments_ = process.argv.slice(2);
const archivedRelease =
  arguments_.length === 1 && arguments_[0] === "--archived-release";
if (arguments_.length !== 0 && !archivedRelease)
  throw new Error("usage: check-workflows.mjs [--archived-release]");
const workflowDirectory = path.resolve(".github/workflows");
const files = (await readdir(workflowDirectory))
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort();
const failures = [];
const expectedFile = archivedRelease ? "release.yml" : "ci.yml";
if (!isDeepStrictEqual(files, [expectedFile]))
  failures.push(`expected only ${expectedFile} in the workflow directory`);

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

const nativeCommands = [
  "npm ci --ignore-scripts",
  "npm run check",
  "npm audit --omit=dev --audit-level=high",
  "npm --prefix recipes/node-typescript-next-web audit --omit=dev --audit-level=high",
  "node dist/cli.js --json --cwd . audit",
];
const ociCommands = [
  "npm ci --ignore-scripts",
  "npm run build",
  "node scripts/qualify-${{ matrix.profile }}-oci.mjs",
];

function inspectSourceWorkflow(workflow, jobs) {
  if (
    workflow.name !== "CI" ||
    !isDeepStrictEqual(workflow.on, {
      pull_request: null,
      push: { branches: ["main"] },
    }) ||
    !isDeepStrictEqual(workflow.permissions, { contents: "read" }) ||
    workflow.concurrency?.["cancel-in-progress"] !== true ||
    workflow.defaults !== undefined ||
    workflow.env !== undefined
  )
    failures.push("ci.yml: CI must use read-only PR and main-push events");

  if (
    !isDeepStrictEqual(Object.keys(jobs).sort(), ["oci", "validate"]) ||
    jobs.validate?.name !== "validate" ||
    jobs.oci?.name !== "${{ matrix.profile }}-oci" ||
    !isDeepStrictEqual(jobs.oci?.strategy, {
      "fail-fast": false,
      matrix: { profile: ["pnpm", "python"] },
    })
  )
    failures.push("ci.yml: required native, pnpm and Python lanes must run");

  for (const [id, commands] of [
    ["validate", nativeCommands],
    ["oci", ociCommands],
  ]) {
    const job = record(jobs[id]);
    const jobSteps = Array.isArray(job?.steps) ? job.steps : [];
    const [checkout, setup, ...steps] = jobSteps;
    if (
      job?.["runs-on"] !== "ubuntu-24.04" ||
      job?.permissions !== undefined ||
      job?.environment !== undefined ||
      job?.defaults !== undefined ||
      job?.env !== undefined ||
      job?.if !== undefined ||
      job?.needs !== undefined ||
      job?.["continue-on-error"] !== undefined ||
      (id === "validate" && job?.strategy !== undefined) ||
      (id === "validate" && checkout?.with?.["fetch-depth"] !== 0) ||
      typeof checkout?.uses !== "string" ||
      !checkout.uses.startsWith("actions/checkout@") ||
      checkout.with?.["persist-credentials"] !== false ||
      checkout.with?.ref !== undefined ||
      checkout.with?.repository !== undefined ||
      checkout.with?.token !== undefined ||
      checkout.with?.["ssh-key"] !== undefined ||
      typeof setup?.uses !== "string" ||
      !setup.uses.startsWith("actions/setup-node@") ||
      setup.with?.["node-version-file"] !== ".node-version" ||
      setup.with?.["node-version"] !== undefined ||
      setup.with?.token !== undefined ||
      !isDeepStrictEqual(
        steps.map((step) => step?.run),
        commands,
      ) ||
      jobSteps.some(
        (step) =>
          step?.if !== undefined ||
          step?.shell !== undefined ||
          step?.["working-directory"] !== undefined ||
          !isDeepStrictEqual(
            step?.env,
            id === "validate" && step?.run === "npm run check"
              ? { MILL_PORTABLE_RECEIPT_PYTHON: "python3" }
              : undefined,
          ) ||
          step?.["continue-on-error"] !== undefined,
      )
    )
      failures.push(
        `ci.yml: ${id} must execute every pinned source check without write credentials or skips`,
      );
  }
}

for (const file of files) {
  const source = await readFile(path.join(workflowDirectory, file), "utf8");
  let workflow;
  try {
    workflow = record(parse(source));
  } catch (error) {
    failures.push(`${file}: invalid YAML: ${String(error)}`);
    continue;
  }
  if (workflow === undefined) {
    failures.push(`${file}: workflow must be a mapping`);
    continue;
  }
  if (!Object.hasOwn(workflow, "permissions")) {
    failures.push(`${file}: missing top-level permissions`);
  }
  if (!Object.hasOwn(workflow, "concurrency")) {
    failures.push(`${file}: missing concurrency control`);
  }
  const jobs = record(workflow.jobs);
  if (jobs === undefined || Object.keys(jobs).length === 0) {
    failures.push(`${file}: jobs must be a non-empty mapping`);
    continue;
  }
  if (archivedRelease && file === "release.yml") {
    failures.push(...releaseDispatchFailures(jobs));
    failures.push(...releaseQualificationInputFailures(jobs));
    failures.push(...releasePublicationFailures(jobs));
    failures.push(...releaseVerifierPreparationFailures(jobs));
  }
  if (!archivedRelease && file === "ci.yml")
    inspectSourceWorkflow(workflow, jobs);
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = record(rawJob);
    if (job === undefined) {
      failures.push(`${file}: job ${jobName} must be a mapping`);
      continue;
    }
    if (
      !Number.isInteger(job["timeout-minutes"]) ||
      job["timeout-minutes"] <= 0 ||
      (!archivedRelease && job["timeout-minutes"] > 30)
    ) {
      failures.push(`${file}: job ${jobName} must declare timeout-minutes`);
    }
    if (!Array.isArray(job.steps)) {
      continue;
    }
    for (const rawStep of job.steps) {
      const step = record(rawStep);
      if (step === undefined || typeof step.uses !== "string") {
        continue;
      }
      if (!/@[a-f0-9]{40}$/u.test(step.uses)) {
        failures.push(
          `${file}: action is not pinned to a full commit: ${step.uses}`,
        );
      }
    }
  }
}

if (files.length === 0) {
  failures.push("no workflows found");
}
if (failures.length > 0) {
  throw new Error(`workflow contract failed:\n${failures.join("\n")}`);
}
process.stdout.write(`workflow contract passed: ${files.join(", ")}\n`);
