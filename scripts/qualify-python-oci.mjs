import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, cp, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers";
import { promisify } from "node:util";
import { cleanupCanaryDirectories } from "./canary-cleanup.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const registryImage =
  "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33";
const workspace = await mkdtemp(path.join(tmpdir(), "mill-python-oci-"));
const state = await mkdtemp(path.join(tmpdir(), "mill-python-oci-state-"));
const registryContainer = `mill-python-oci-registry-${randomUUID()}`;
let registryStarted = false;
let completed = false;

async function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() =>
          reject(new Error("could not allocate a loopback port")),
        );
        return;
      }
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function startLoopbackRegistry() {
  const port = await availableLoopbackPort();
  await execute("docker", ["pull", registryImage], { cwd: root });
  await execute(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--network",
      "host",
      "--pull",
      "never",
      "--name",
      registryContainer,
      "--env",
      `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`,
      registryImage,
    ],
    { cwd: root },
  );
  registryStarted = true;
  const registry = `127.0.0.1:${port}`;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const running = (
    await execute(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", registryContainer],
      { cwd: root },
    )
  ).stdout.trim();
  if (running !== "true") {
    throw new Error("Python OCI canary registry did not remain running");
  }
  return registry;
}

async function pushCanaryImage(imageTag) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await execute("docker", ["push", imageTag], { cwd: root });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

try {
  const registry = await startLoopbackRegistry();
  const tag = `${registry}/mill-python-oci-canary:3-12-14`;
  await cp(path.join(root, "examples/python-cli-library"), workspace, {
    recursive: true,
  });
  await execute("docker", ["build", "-t", tag, workspace], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  await pushCanaryImage(tag);
  const info = JSON.parse(
    (await execute("docker", ["image", "inspect", tag])).stdout,
  );
  const image = info[0].RepoDigests.find((value) =>
    value.startsWith(`${registry}/mill-python-oci-canary@sha256:`),
  );
  if (image === undefined)
    throw new Error("No immutable image digest after local-registry readback");
  const { millConfigSchema } = await import("../dist/contracts/schemas.js");
  const { planNativeAdoption } =
    await import("../dist/repository/native-adoption.js");
  const { verifyDeclaredCommands } =
    await import("../dist/runtime/verifier.js");
  const { stringify } = await import("yaml");
  const config = millConfigSchema.parse({
    schemaVersion: "1",
    repositoryId: randomUUID(),
    trustCeiling: "build",
    verifier: {
      image,
      network: "none",
      pythonProfile: {
        id: "python-cli-library",
        version: "3.12.14",
        interpreter: "/opt/venv/bin/python",
        manifestPath: "/opt/mill-python-profile.json",
        projectPath: "pyproject.toml",
        lockPath: "uv.lock",
      },
    },
    commands: Object.fromEntries(
      ["test", "package"].map((name) => [
        name,
        {
          argv: ["/opt/venv/bin/python", `quality/${name}.py`],
          cwd: ".",
          controlPaths: ["pyproject.toml", "uv.lock", `quality/${name}.py`],
          capability: name,
          required: true,
          execution: "oci",
          timeoutSeconds: 120,
        },
      ]),
    ),
  });
  await writeFile(path.join(workspace, "adoption.yaml"), stringify(config));
  const git = process.env.MILL_GIT_PATH ?? "git";
  await execute(git, ["init", "-b", "main"], { cwd: workspace });
  await execute(
    git,
    [
      "-c",
      "user.name=Python Canary",
      "-c",
      "user.email=canary@example.invalid",
      "add",
      ".",
    ],
    { cwd: workspace },
  );
  await execute(
    git,
    [
      "-c",
      "user.name=Python Canary",
      "-c",
      "user.email=canary@example.invalid",
      "commit",
      "-m",
      "test: Python fixture",
    ],
    { cwd: workspace },
  );
  const candidateCommit = (
    await execute(git, ["rev-parse", "HEAD"], { cwd: workspace })
  ).stdout.trim();
  const plan = await planNativeAdoption({
    root: workspace,
    configPath: "adoption.yaml",
  });
  const task = {
    id: "python-canary",
    commandIds: ["test", "package"],
    budget: { deadlineSeconds: 300, maxOutputBytes: 1048576 },
  };
  const run = () =>
    verifyDeclaredCommands({
      root: workspace,
      stateDirectory: state,
      candidateCommit,
      config,
      task,
      deadlineMs: Date.now() + 300000,
      maxOutputBytes: 1048576,
    });
  const evidence = await run();
  if (!evidence.passed) throw new Error(JSON.stringify(evidence));
  await writeFile(path.join(workspace, "json.py"), "import os\nos._exit(0)\n");
  const shadowSafe = await run();
  if (shadowSafe.commands[0].status !== "passed")
    throw new Error(
      "Candidate json.py interfered with the isolated native test",
    );
  await writeFile(
    path.join(workspace, "src/mill_python_fixture/__init__.py"),
    "def allocate(available, requested):\n    return requested\n",
  );
  const broken = await run();
  if (
    broken.commands[0].status !== "failed" ||
    broken.commands[0].reason !== "PYTHON_COMMAND_NONZERO_EXIT"
  )
    throw new Error("Seeded allocation defect was not detected");
  await execute(
    git,
    ["checkout", "--", "src/mill_python_fixture/__init__.py"],
    { cwd: workspace },
  );
  await unlink(path.join(workspace, "json.py"));
  const testOracle = path.join(workspace, "quality/test.py");
  const originalTestOracle = await readFile(testOracle, "utf8");
  await writeFile(
    testOracle,
    [
      "import os, signal, sys",
      "if sys.stdin.buffer.read():",
      "    raise SystemExit('unexpected proof bytes in command input')",
      "os.kill(os.getpid(), signal.SIGKILL)",
      "",
    ].join("\n"),
  );
  const interrupted = await run();
  await writeFile(testOracle, originalTestOracle);
  const signalBlocked =
    !interrupted.passed &&
    interrupted.commands[0].status === "blocked" &&
    interrupted.commands[0].reason === "PYTHON_COMMAND_COMPLETION_UNPROVEN" &&
    interrupted.commands[0].exitCode === 137;
  if (!signalBlocked)
    throw new Error(
      "A terminated Python command must lack normal completion proof",
    );
  const packageOracle = path.join(workspace, "quality/package.py");
  const oracle = await readFile(packageOracle, "utf8");
  const wheelSelection = 'wheel = next(Path("/tmp/wheels").glob("*.whl"))';
  if (!oracle.includes(wheelSelection))
    throw new Error("Wheel fixture oracle no longer selects the built wheel");
  const corruptWheel = oracle.replace(
    wheelSelection,
    wheelSelection + '\nwheel.write_bytes(b"invalid synthetic wheel")',
  );
  await writeFile(packageOracle, corruptWheel);
  const brokenWheel = await run();
  if (
    brokenWheel.passed ||
    brokenWheel.commands[0].status !== "passed" ||
    brokenWheel.commands[1].status !== "failed"
  )
    throw new Error(
      "An un-installable wheel did not independently block acceptance",
    );
  await writeFile(packageOracle, oracle);

  await writeFile(
    path.join(workspace, "uv.lock"),
    (await readFile(path.join(workspace, "uv.lock"), "utf8")) +
      "\n# changed lock\n",
  );
  const drift = await run();
  const preflightBlocked =
    !drift.passed &&
    drift.commands.length === 2 &&
    drift.commands.every(
      (command) =>
        command.status === "blocked" &&
        command.reason === "PYTHON_ENVIRONMENT_PREFLIGHT_FAILED",
    );
  if (!preflightBlocked)
    throw new Error(
      "Changed lock did not produce a Python image preflight blocker",
    );
  const sourceCommit = (
    await execute(git, ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const sourceDirty =
    (await execute(git, ["status", "--porcelain"], { cwd: root })).stdout.trim()
      .length > 0;
  process.stdout.write(
    JSON.stringify(
      {
        schemaVersion: "1",
        evidenceClass: "cpu_oci",
        sourceCommit,
        sourceDirty,
        profile: "python-cli-library",
        host: { platform: process.platform, architecture: process.arch },
        candidateCommit,
        image,
        adoptionPlanDigest: plan.approvalDigest,
        checks: {
          nativeTests: evidence.commands[0].status,
          wheelInstall: evidence.commands[1].status,
          seededFaultRejected: broken.commands[0].status === "failed",
          wheelFailureBlocksWithPassingTests:
            brokenWheel.commands[0].status === "passed" &&
            brokenWheel.commands[1].status === "failed",
          lockDriftRejected: !drift.passed,
          optimizedManifestMismatchRejected: preflightBlocked,
          imagePreflightBlocked: preflightBlocked,
          terminatedCommandBlocked: signalBlocked,
          moduleShadowingCannotSkipCheck:
            broken.commands[0].status === "failed" &&
            shadowSafe.commands[0].status === "passed",
        },
        limits:
          "Synthetic Python package on one local Docker tuple; no GPU, CUDA, vLLM, live coding provider or public support qualification.",
      },
      null,
      2,
    ) + "\n",
  );
  completed = true;
} finally {
  let removed = !registryStarted;
  if (registryStarted) {
    await execute("docker", ["rm", "--force", registryContainer], {
      cwd: root,
    });
    removed = true;
  }
  await cleanupCanaryDirectories([workspace, state], completed && removed);
}
