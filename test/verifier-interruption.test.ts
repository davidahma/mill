import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import {
  qualifyBaseline,
  retainedVerifierArtifacts,
  startLocalRun,
  verifyRun,
} from "../src/runtime/lifecycle.js";
import { loadRuntimeInputs } from "../src/runtime/inputs.js";
import { commonGitDirectory } from "../src/runtime/repository.js";
import { StateStore } from "../src/runtime/state.js";
import { runtimeFixture } from "./runtime-fixture.js";

const original = {
  state: process.env.MILL_STATE_HOME,
  codex: process.env.MILL_CODEX_PATH,
  docker: process.env.MILL_DOCKER_PATH,
};
const execFileAsync = promisify(execFile);
afterEach(() => {
  for (const [key, value] of Object.entries({
    MILL_STATE_HOME: original.state,
    MILL_CODEX_PATH: original.codex,
    MILL_DOCKER_PATH: original.docker,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

it.each(["collection", "cleanup", "settlement"] as const)(
  "preserves a killed %s attempt and verifies the unchanged candidate in fresh storage",
  async (phase) => {
    const fixture = await runtimeFixture();
    process.env.MILL_STATE_HOME = fixture.stateHome;
    process.env.MILL_CODEX_PATH = fixture.codexPath;
    process.env.MILL_DOCKER_PATH = fixture.dockerPath;
    let child: ChildProcess | undefined;
    let temporaryDirectories: string[] = [];
    try {
      const configPath = path.join(fixture.root, "mill.yaml");
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8")).replace(
          "    execution: oci\n",
          `    execution: oci
    retainedArtifacts:
      paths: [reports/check.json]
      required: true
      maxFiles: 1
      maxFileBytes: 1024
      maxTotalBytes: 1024
`,
        ),
      );
      await execFileAsync(
        process.env.MILL_GIT_PATH ?? "/usr/bin/git",
        [
          "-c",
          "user.name=Mill Test",
          "-c",
          "user.email=mill-test@example.invalid",
          "add",
          "mill.yaml",
        ],
        { cwd: fixture.root },
      );
      await execFileAsync(
        process.env.MILL_GIT_PATH ?? "/usr/bin/git",
        [
          "-c",
          "user.name=Mill Test",
          "-c",
          "user.email=mill-test@example.invalid",
          "commit",
          "--no-gpg-sign",
          "-m",
          "test: retain interrupted evidence",
        ],
        { cwd: fixture.root },
      );
      const qualified = await qualifyBaseline({
        root: fixture.root,
        taskPath: fixture.taskPath,
      });
      if (qualified.approvalDigest === null) throw new Error("baseline failed");
      const started = await startLocalRun({
        root: fixture.root,
        taskPath: fixture.taskPath,
        approvalDigest: qualified.approvalDigest,
      });
      const inputs = await loadRuntimeInputs(fixture.root, fixture.taskPath);
      const store = await StateStore.open(
        inputs.config.repositoryId,
        await commonGitDirectory(fixture.root),
      );
      const stateDirectory = store.directory;
      const artifactRoot = path.join(
        stateDirectory,
        "artifacts",
        started.run.id,
        started.run.candidateCommit ?? "",
      );
      store.close();
      // The child executes the real source modules. Test-only host hooks pause at
      // durable cut points; SIGKILL prevents exception/finally settlement.
      const source = `
      import fs from "node:fs";
      import {registerHooks,syncBuiltinESMExports} from "node:module";
      registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.endsWith(".js")&&context.parentURL){const candidate=new URL(specifier.replace(/\\.js$/,".ts"),context.parentURL);if(fs.existsSync(candidate))return next(candidate.href,context)}throw error}}});
      const temporaryDirectories=[];
      const originalMkdtemp=fs.promises.mkdtemp;
      fs.promises.mkdtemp=async (...args)=>{const result=await originalMkdtemp(...args);if(result.includes("mill-verifier-"))temporaryDirectories.push(result);return result};
      const cut=()=>{process.stdout.write(JSON.stringify({phase:${JSON.stringify(phase)},temporaryDirectories})+"\\n");setInterval(()=>{},1000);return new Promise(()=>{})};
      const originalWrite=fs.promises.writeFile;
      fs.promises.writeFile=async (...args)=>{const result=await originalWrite(...args);if(${JSON.stringify(phase)}==="collection"&&String(args[0]).startsWith(${JSON.stringify(artifactRoot)})&&String(args[0]).endsWith("reports/check.json"))await cut();return result};
      const originalRm=fs.promises.rm;
      fs.promises.rm=async (...args)=>{if(${JSON.stringify(phase)}==="cleanup"&&String(args[0]).startsWith(${JSON.stringify(path.join(stateDirectory, "oci-resources"))})&&String(args[0]).endsWith(".json"))await cut();return originalRm(...args)};
      syncBuiltinESMExports();
      const {StateStore}=await import(${JSON.stringify(new URL("../src/runtime/state.ts", import.meta.url).href)});
      if(${JSON.stringify(phase)}==="settlement")StateStore.prototype.completeValidation=function(){process.stdout.write(JSON.stringify({phase:${JSON.stringify(phase)},temporaryDirectories})+"\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)};
      const {verifyRun}=await import(${JSON.stringify(new URL("../src/runtime/lifecycle.ts", import.meta.url).href)});
      await verifyRun(${JSON.stringify({ root: fixture.root, taskPath: fixture.taskPath, runId: started.run.id })});
    `;
      child = spawn(process.execPath, ["--input-type=module", "-e", source], {
        cwd: fixture.root,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const controller = child;
      const cut = await new Promise<{ temporaryDirectories: string[] }>(
        (resolve, reject) => {
          let output = "";
          let errors = "";
          controller.stderr?.on("data", (bytes: Buffer) => {
            errors += bytes.toString();
          });
          controller.stdout?.on("data", (bytes: Buffer) => {
            output += bytes.toString();
            if (output.includes("\n"))
              resolve(
                JSON.parse(output.trim()) as { temporaryDirectories: string[] },
              );
          });
          controller.once("exit", () =>
            reject(new Error(`controller exited before cut: ${errors}`)),
          );
        },
      );
      temporaryDirectories = cut.temporaryDirectories;
      child.kill("SIGKILL");
      await once(child, "close");
      child = undefined;
      const attemptDirectories = await readdir(artifactRoot);
      expect(attemptDirectories).toHaveLength(1);
      const priorAttempt = attemptDirectories[0];
      if (priorAttempt === undefined) throw new Error("attempt absent");
      const report = path.join(
        artifactRoot,
        priorAttempt,
        createHash("sha256").update("test").digest("hex"),
        "reports/check.json",
      );
      const priorBytes = await readFile(report);
      const interruptedStore = await StateStore.open(
        inputs.config.repositoryId,
        await commonGitDirectory(fixture.root),
      );
      expect(interruptedStore.getRun(started.run.id)).toMatchObject({
        status: "committed",
        candidateCommit: started.run.candidateCommit,
      });
      expect(
        interruptedStore.getRun(started.run.id).validationJson,
      ).toBeUndefined();
      interruptedStore.close();
      const retry = await verifyRun({
        root: fixture.root,
        taskPath: fixture.taskPath,
        runId: started.run.id,
      });
      expect(retry.evidence.passed).toBe(true);
      expect(retry.evidence.verificationAttemptId).not.toBe(priorAttempt);
      expect(await readdir(artifactRoot)).toHaveLength(2);
      await expect(readFile(report)).resolves.toEqual(priorBytes);
      await expect(
        retainedVerifierArtifacts({
          root: fixture.root,
          runId: started.run.id,
        }),
      ).resolves.toMatchObject({ artifacts: [{ available: true }] });
    } finally {
      if (child !== undefined) {
        child.kill("SIGKILL");
        await once(child, "close");
      }
      await Promise.all(
        temporaryDirectories.map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
      await fixture.cleanup();
    }
  },
  20_000,
);
