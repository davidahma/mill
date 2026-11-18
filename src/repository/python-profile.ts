import type { MillConfig } from "../runtime/inputs.js";
import { createHash } from "node:crypto";
import { safeReadBytes, safeReadText } from "../security/safe-path.js";
import { ExitCode, MillError } from "../errors.js";

export async function inspectPythonProfile(
  root: string,
  config: MillConfig,
  candidateCommandIds = Object.keys(config.commands),
) {
  const profile = config.verifier?.pythonProfile;
  if (
    profile === undefined ||
    config.verifier?.dependencies !== undefined ||
    config.trustCeiling !== "build" ||
    config.propose !== undefined
  )
    throw new MillError(
      "PYTHON_ADOPTION_POLICY_INVALID",
      "Python adoption requires a build-only, image-owned environment profile.",
      ExitCode.configuration,
    );
  const [project, lock] = await Promise.all([
    safeReadBytes(root, profile.projectPath),
    safeReadBytes(root, profile.lockPath, 8 * 1024 * 1024),
  ]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let nonempty = false;
  try {
    nonempty =
      decoder.decode(project).trim().length > 0 &&
      decoder.decode(lock).trim().length > 0;
  } catch {
    // Malformed text cannot be reviewed as a Python project or lock file.
  }
  if (!nonempty)
    throw new MillError(
      "PYTHON_ADOPTION_INPUT_INVALID",
      "Project and lock files must be nonempty; native checks validate their syntax and behavior.",
      ExitCode.configuration,
    );
  const requiredCapabilities = new Set(
    candidateCommandIds
      .map((id) => config.commands[id])
      .filter((command) => command?.required)
      .map((command) => command?.capability),
  );
  if (!requiredCapabilities.has("test") || !requiredCapabilities.has("package"))
    throw new MillError(
      "PYTHON_ADOPTION_CHECK_REQUIRED",
      "The Python candidate must select required test and package-install checks.",
      ExitCode.configuration,
    );
  for (const [id, command] of Object.entries(config.commands)) {
    const script = command.argv[1];
    if (
      command.execution !== "oci" ||
      command.cwd !== "." ||
      command.capability === "read" ||
      command.argv[0] !== profile.interpreter ||
      script === undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9_./-]*\.py$/u.test(script) ||
      script.split("/").includes("..") ||
      !command.controlPaths.includes(script) ||
      !command.controlPaths.includes(profile.projectPath) ||
      !command.controlPaths.includes(profile.lockPath)
    )
      throw new MillError(
        "PYTHON_ADOPTION_COMMAND_INVALID",
        "Python checks must execute an existing frozen repository script through the pinned interpreter in offline OCI.",
        ExitCode.configuration,
        { commandId: id },
      );
    await safeReadText(root, script);
  }
  const digest = (bytes: Buffer) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { projectDigest: digest(project), lockDigest: digest(lock) };
}

/** Runs before the declared command inside the same bounded offline container. */
export const pythonEnvironmentPreflight = [
  "import ctypes, json, os, subprocess, sys",
  "m=json.load(open('/opt/mill-python-profile.json'))",
  "expected={'schemaVersion':'1','python':os.environ['MILL_PYTHON_VERSION'],'projectDigest':os.environ['MILL_PYTHON_PROJECT_DIGEST'],'lockDigest':os.environ['MILL_PYTHON_LOCK_DIGEST']}",
  "if '.'.join(map(str,sys.version_info[:3])) != expected['python'] or m != expected:",
  "    raise SystemExit('Python image profile mismatch')",
  "marker=sys.stdin.readline(96).strip()",
  "PR_SET_DUMPABLE=4",
  "if not marker or ctypes.CDLL(None).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:",
  "    raise SystemExit('Python proof channel unavailable')",
  "command=subprocess.Popen([sys.argv[1], '-I', '-B', *sys.argv[2:]], stdin=subprocess.DEVNULL)",
  "sys.stderr.write('\\n'+marker+':started\\n')",
  "sys.stderr.flush()",
  "status=command.wait()",
  "if status >= 0:",
  "    sys.stderr.write('\\n'+marker+':exit:'+str(status)+'\\n')",
  "    sys.stderr.flush()",
  "raise SystemExit(status if status >= 0 else 128-status)",
].join("\n");
