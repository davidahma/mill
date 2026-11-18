import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  millConfigSchema,
  taskPacketSchema,
} from "../src/contracts/schemas.js";
import { inspectPythonProfile } from "../src/repository/python-profile.js";
import { loadRuntimeInputs } from "../src/runtime/inputs.js";
import {
  qualifyBaseline,
  resumeRun,
  runStatus,
  startLocalRun,
  verifyRun,
} from "../src/runtime/lifecycle.js";
import { commonGitDirectory } from "../src/runtime/repository.js";
import { StateStore } from "../src/runtime/state.js";
import { verifyDeclaredCommands } from "../src/runtime/verifier.js";
import { runtimeFixture } from "./runtime-fixture.js";

const original = {
  MILL_DOCKER_PATH: process.env.MILL_DOCKER_PATH,
  MILL_CODEX_PATH: process.env.MILL_CODEX_PATH,
  MILL_STATE_HOME: process.env.MILL_STATE_HOME,
};
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

async function fixture(
  pythonExecutionFailure?: "preflight" | "signal" | "missing" | "mismatched",
) {
  const f = await runtimeFixture(
    pythonExecutionFailure === undefined ? {} : { pythonExecutionFailure },
  );
  const config = millConfigSchema.parse(
    parse(await readFile(path.join(f.root, "mill.yaml"), "utf8")),
  );
  config.verifier = {
    image: `python@sha256:${"a".repeat(64)}`,
    network: "none",
    pythonProfile: {
      id: "python-cli-library",
      version: "3.12.14",
      interpreter: "/opt/venv/bin/python",
      manifestPath: "/opt/mill-python-profile.json",
      projectPath: "pyproject.toml",
      lockPath: "uv.lock",
    },
  };
  config.commands = {
    test: {
      argv: ["/opt/venv/bin/python", "src/check.py"],
      cwd: ".",
      controlPaths: ["pyproject.toml", "uv.lock"],
      capability: "test",
      required: true,
      timeoutSeconds: 30,
      execution: "oci",
    },
    package: {
      argv: ["/opt/venv/bin/python", "quality/package.py"],
      cwd: ".",
      controlPaths: ["pyproject.toml", "uv.lock", "quality/package.py"],
      capability: "package",
      required: true,
      timeoutSeconds: 30,
      execution: "oci",
    },
  };
  await writeFile(
    path.join(f.root, "pyproject.toml"),
    '[project]\nname="fixture"\n',
  );
  await writeFile(path.join(f.root, "uv.lock"), "version = 1\n");
  await writeFile(path.join(f.root, "src/check.py"), "print('fixture only')\n");
  await writeFile(
    path.join(f.root, "quality/package.py"),
    "print('fixture only')\n",
  );
  await writeFile(path.join(f.root, "mill.yaml"), stringify(config));
  const task = taskPacketSchema.parse(
    parse(await readFile(path.join(f.root, f.taskPath), "utf8")),
  );
  task.commandIds.push("package");
  task.allowedPaths.push("src/check.py");
  await writeFile(path.join(f.root, f.taskPath), stringify(task));
  return { ...f, config };
}

it("rejects a manually configured writable Python oracle before admission", async () => {
  const f = await fixture();
  try {
    await expect(loadRuntimeInputs(f.root, f.taskPath)).rejects.toMatchObject({
      code: "PYTHON_ADOPTION_COMMAND_INVALID",
    });
    const command = f.config.commands.test;
    if (command === undefined) throw new Error("Missing test command");
    command.controlPaths.push("src/check.py");
    await writeFile(path.join(f.root, "mill.yaml"), stringify(f.config));
    await expect(loadRuntimeInputs(f.root, f.taskPath)).rejects.toMatchObject({
      code: "BOUND_INPUT_SCOPE_OVERLAP",
    });
    command.argv[1] = "quality/check.py";
    command.controlPaths = ["pyproject.toml", "uv.lock", "quality/check.py"];
    await writeFile(
      path.join(f.root, "quality/check.py"),
      "print('fixture only')\n",
    );
    await writeFile(path.join(f.root, "mill.yaml"), stringify(f.config));
    const inputs = await loadRuntimeInputs(f.root, f.taskPath);
    expect(inputs.protectedPaths).toEqual(
      expect.arrayContaining(["quality/check.py", "pyproject.toml", "uv.lock"]),
    );
  } finally {
    await f.cleanup();
  }
});

it.each(["missing-control", "inline-command"])(
  "rejects %s at the direct verifier boundary before creating an OCI lease",
  async (kind) => {
    const f = await fixture();
    process.env.MILL_DOCKER_PATH = f.dockerPath;
    try {
      if (kind === "inline-command") {
        const command = f.config.commands.test;
        if (command === undefined) throw new Error("Missing test command");
        command.argv = ["/opt/venv/bin/python", "-c", "pass"];
      }
      const before = await readdir(f.stateHome);
      const task = taskPacketSchema.parse(
        parse(await readFile(path.join(f.root, f.taskPath), "utf8")),
      );
      await expect(
        verifyDeclaredCommands({
          root: f.root,
          stateDirectory: f.stateHome,
          config: f.config,
          task,
          candidateCommit: "a".repeat(40),
          deadlineMs: Date.now() + 5000,
          maxOutputBytes: 4096,
        }),
      ).rejects.toMatchObject({ code: "PYTHON_ADOPTION_COMMAND_INVALID" });
      expect(await readdir(f.stateHome)).toEqual(before);
    } finally {
      await f.cleanup();
    }
  },
);

it.each(["test", "package"])(
  "rejects a Python candidate omitting %s before baseline and direct verification",
  async (omitted) => {
    const f = await fixture();
    process.env.MILL_DOCKER_PATH = f.dockerPath;
    try {
      const taskFile = path.join(f.root, f.taskPath);
      const task = taskPacketSchema.parse(
        parse(await readFile(taskFile, "utf8")),
      );
      task.commandIds = task.commandIds.filter((id) => id !== omitted);
      await writeFile(taskFile, stringify(task));
      for (const action of [
        () => loadRuntimeInputs(f.root, f.taskPath),
        () =>
          verifyDeclaredCommands({
            root: f.root,
            stateDirectory: f.stateHome,
            config: f.config,
            task,
            candidateCommit: "a".repeat(40),
            deadlineMs: Date.now() + 5000,
            maxOutputBytes: 4096,
          }),
      ])
        await expect(action()).rejects.toMatchObject({
          code: "PYTHON_ADOPTION_CHECK_REQUIRED",
        });
    } finally {
      await f.cleanup();
    }
  },
);

it("uses exact project and lock bytes and allows a narrower approved baseline", async () => {
  const f = await fixture();
  process.env.MILL_DOCKER_PATH = f.dockerPath;
  try {
    const project = Buffer.from('\ufeff[project]\nname = "fixture"\n', "utf8");
    const lock = Buffer.from("\ufeffversion = 1\n", "utf8");
    await writeFile(path.join(f.root, "pyproject.toml"), project);
    await writeFile(path.join(f.root, "uv.lock"), lock);
    const command = f.config.commands.test;
    if (command === undefined) throw new Error("Missing test command");
    command.controlPaths.push("src/check.py");
    const task = taskPacketSchema.parse(
      parse(await readFile(path.join(f.root, f.taskPath), "utf8")),
    );
    if (task.schemaVersion !== "2") throw new Error("Expected version 2 task");
    task.baselineCommandIds = ["test"];
    const digest = (bytes: Buffer) =>
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    expect(
      await inspectPythonProfile(f.root, f.config, task.commandIds),
    ).toEqual({
      projectDigest: digest(project),
      lockDigest: digest(lock),
    });
    const evidence = await verifyDeclaredCommands({
      root: f.root,
      stateDirectory: f.stateHome,
      config: f.config,
      task,
      baseline: true,
      candidateCommit: "a".repeat(40),
      deadlineMs: Date.now() + 5000,
      maxOutputBytes: 4096,
    });
    expect(evidence.commands.map((result) => result.commandId)).toEqual([
      "test",
    ]);
  } finally {
    await f.cleanup();
  }
});

it.each([
  ["preflight", 1, "PYTHON_ENVIRONMENT_PREFLIGHT_FAILED"],
  ["signal", 137, "PYTHON_COMMAND_COMPLETION_UNPROVEN"],
  ["missing", 0, "PYTHON_COMMAND_COMPLETION_UNPROVEN"],
  ["mismatched", 1, "PYTHON_COMMAND_COMPLETION_UNPROVEN"],
] as const)(
  "blocks a Python %s failure and never starts builder repair",
  async (failure, exitCode, reason) => {
    const f = await fixture(failure);
    process.env.MILL_DOCKER_PATH = f.dockerPath;
    process.env.MILL_CODEX_PATH = f.codexPath;
    process.env.MILL_STATE_HOME = f.stateHome;
    try {
      const command = f.config.commands.test;
      if (command === undefined) throw new Error("Missing test command");
      command.argv[1] = "quality/check.py";
      command.controlPaths.push("quality/check.py");
      await writeFile(
        path.join(f.root, "quality/check.py"),
        "print('fixture only')\n",
      );
      await writeFile(path.join(f.root, "mill.yaml"), stringify(f.config));
      const execute = promisify(execFile);
      const git = process.env.MILL_GIT_PATH ?? "/usr/bin/git";
      await execute(git, ["add", "."], { cwd: f.root });
      await execute(
        git,
        [
          "-c",
          "user.name=Mill Test",
          "-c",
          "user.email=mill-test@example.invalid",
          "commit",
          "-m",
          "test: bind Python verifier",
        ],
        { cwd: f.root },
      );
      const rootTask = { root: f.root, taskPath: f.taskPath };
      const baseline = await qualifyBaseline(rootTask);
      expect(
        baseline.evidence.commands.every(
          (command) => command.status === "passed",
        ),
      ).toBe(true);
      if (baseline.approvalDigest === null)
        throw new Error("Expected baseline approval");
      const started = await startLocalRun({
        ...rootTask,
        approvalDigest: baseline.approvalDigest,
      });
      const input = { ...rootTask, runId: started.run.id };
      const blocked = await verifyRun(input);
      expect(blocked.run).toMatchObject({
        status: "blocked",
        blockCode: "VALIDATION_FAILED",
      });
      expect(blocked.evidence.commands).toMatchObject([
        {
          commandId: "test",
          status: "blocked",
          reason,
          exitCode,
        },
        {
          commandId: "package",
          status: "blocked",
          reason,
          exitCode,
        },
      ]);
      await expect(resumeRun(input)).rejects.toMatchObject({
        code: "RUN_REQUIRES_HUMAN_DISPOSITION",
      });
      const after = (await runStatus(input)).run;
      expect(after).toMatchObject({
        repairCount: 0,
        attemptCount: started.run.attemptCount,
        candidateCommit: started.run.candidateCommit,
      });
      const store = await StateStore.open(
        f.config.repositoryId,
        await commonGitDirectory(f.root),
      );
      try {
        expect(
          store
            .events(input.runId)
            .some((event) => event.type === "repair.started"),
        ).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      await f.cleanup();
    }
  },
);
