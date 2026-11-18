import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify as yaml } from "yaml";
import { millConfigSchema } from "../src/contracts/schemas.js";
import {
  planNativeAdoption,
  applyNativeAdoption,
} from "../src/repository/native-adoption.js";
import { temporaryDirectory } from "./helpers.js";

function command(
  config: ReturnType<typeof millConfigSchema.parse>,
  id: string,
) {
  const value = config.commands[id];
  if (value === undefined) throw new Error("Fixture command missing");
  return value;
}

const exec = promisify(execFile);
async function fixture() {
  const dir = await temporaryDirectory("mill-python-");
  const config = millConfigSchema.parse({
    schemaVersion: "1",
    repositoryId: randomUUID(),
    trustCeiling: "build",
    verifier: {
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
        },
      ]),
    ),
  });
  await mkdir(path.join(dir.path, "quality"));
  await writeFile(
    path.join(dir.path, "pyproject.toml"),
    '[project]\nname = "sample"\nversion = "0.1.0"\n',
  );
  await writeFile(path.join(dir.path, "uv.lock"), "version = 1\n");
  for (const name of ["test", "package"])
    await writeFile(
      path.join(dir.path, "quality", `${name}.py`),
      "print('fixture only')\n",
    );
  await writeFile(path.join(dir.path, "adoption.yaml"), yaml(config));
  const git = (args: string[]) =>
    exec(process.env.MILL_GIT_PATH ?? "/usr/bin/git", args, { cwd: dir.path });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Python Test"]);
  await git(["config", "user.email", "python@example.invalid"]);
  await git(["add", "."]);
  await git(["commit", "-m", "test: fixture"]);
  return {
    dir,
    config,
    git,
    input: { root: dir.path, configPath: "adoption.yaml" },
  };
}
describe("Python image profile adoption", () => {
  it("preserves source, binds lock/project and image and requires exact attended apply", async () => {
    const f = await fixture();
    try {
      const plan = await planNativeAdoption(f.input);
      expect(plan).toMatchObject({
        status: "experimental",
        profile: "python-cli-library",
        qualification: "not_executed",
      });
      expect(await planNativeAdoption(f.input)).toEqual(plan);
      await expect(
        applyNativeAdoption({
          ...f.input,
          approvalDigest: plan.approvalDigest,
          attended: false,
        }),
      ).rejects.toMatchObject({ code: "ATTENDANCE_REQUIRED" });
      await writeFile(
        path.join(f.dir.path, "uv.lock"),
        "version = 1\nrevision = 1\n",
      );
      await f.git(["add", "."]);
      await f.git(["commit", "-m", "test: changed lock"]);
      await expect(
        applyNativeAdoption({
          ...f.input,
          approvalDigest: plan.approvalDigest,
          attended: true,
        }),
      ).rejects.toMatchObject({ code: "NATIVE_ADOPTION_APPROVAL_MISMATCH" });
      expect(
        await readFile(path.join(f.dir.path, "quality/test.py"), "utf8"),
      ).toBe("print('fixture only')\n");
    } finally {
      await f.dir.cleanup();
    }
  });
  it("rejects host execution, missing frozen scripts, unprotected lock and missing package checks", async () => {
    for (const change of [
      (c: ReturnType<typeof millConfigSchema.parse>) => {
        command(c, "test").execution = "host";
      },
      (c: ReturnType<typeof millConfigSchema.parse>) => {
        command(c, "test").argv = [
          "/opt/venv/bin/python",
          "-c",
          "print('bypass')",
        ];
      },
      (c: ReturnType<typeof millConfigSchema.parse>) => {
        command(c, "test").controlPaths = ["quality/test.py"];
      },
      (c: ReturnType<typeof millConfigSchema.parse>) => {
        delete c.commands.package;
      },
    ]) {
      const f = await fixture();
      try {
        change(f.config);
        await writeFile(path.join(f.dir.path, "adoption.yaml"), yaml(f.config));
        await f.git(["add", "."]);
        await f.git(["commit", "-m", "test: bad config"]);
        await expect(planNativeAdoption(f.input)).rejects.toThrow();
      } finally {
        await f.dir.cleanup();
      }
    }
  });
});
