import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PreparationSessionInput {
  mode:
    | "create"
    | "status"
    | "replan"
    | "hosted"
    | "reconcile"
    | "continue"
    | "handoff";
  session: string;
  request?: string;
  approve?: string;
  attended?: boolean;
}

export interface MaintainerReviewInput {
  mode: "run" | "check";
  base: string;
  head: string;
  receipt: string;
  validation?: readonly string[];
  session?: string;
  purpose?: "candidate" | "acceptance";
}

export interface PreparationOperationResult {
  exitCode: number;
  output: Record<string, unknown>;
}

function insist(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function absolute(value: string, name: string): void {
  insist(
    typeof value === "string" &&
      path.isAbsolute(value) &&
      !value.includes("\0"),
    `${name} must be an absolute path`,
  );
}

function knownKeys(value: object, allowed: readonly string[]): void {
  insist(
    Object.keys(value).every((key) => allowed.includes(key)),
    "Unsupported preparation operation option",
  );
}

async function execute(
  root: string,
  script: "review-session.mjs" | "maintainer-review.mjs",
  args: string[],
): Promise<PreparationOperationResult> {
  absolute(root, "Repository root");
  // src/planning and dist/planning have the same relative relationship to the
  // packaged scripts. The target checkout never selects the executable script.
  const executable = fileURLToPath(
    new URL(`../../scripts/${script}`, import.meta.url),
  );
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [executable, ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: script === "maintainer-review.mjs" ? 65 * 60 * 1000 : 30000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || error.killed)) {
          reject(
            new Error(
              stderr.trim() ||
                "Preparation operation failed or was interrupted",
            ),
          );
          return;
        }
        let output: unknown;
        try {
          output = JSON.parse(stdout);
        } catch {
          reject(
            new Error(
              stderr.trim() || "Malformed preparation operation output",
            ),
          );
          return;
        }
        if (
          output === null ||
          typeof output !== "object" ||
          Array.isArray(output)
        ) {
          reject(new Error("Malformed preparation operation output"));
          return;
        }
        resolve({
          exitCode: error ? Number(error.code) : 0,
          output: output as Record<string, unknown>,
        });
      },
    );
  });
}

export async function executePreparationSession(
  root: string,
  input: PreparationSessionInput,
): Promise<PreparationOperationResult> {
  knownKeys(input, ["mode", "session", "request", "approve", "attended"]);
  insist(
    [
      "create",
      "status",
      "replan",
      "hosted",
      "reconcile",
      "continue",
      "handoff",
    ].includes(input.mode),
    "Unsupported preparation session mode",
  );
  absolute(input.session, "Session");
  const approving = ["reconcile", "continue"].includes(input.mode);
  insist(
    approving || (input.approve === undefined && input.attended === undefined),
    "This operation does not accept approval options",
  );
  insist(
    input.approve === undefined || /^sha256:[a-f0-9]{64}$/u.test(input.approve),
    "Malformed operation approval",
  );
  insist(
    input.attended === undefined || typeof input.attended === "boolean",
    "Malformed attendance",
  );
  const needsRequest = ["create", "replan", "hosted", "continue"].includes(
    input.mode,
  );
  insist(
    needsRequest ? input.request !== undefined : input.request === undefined,
    "Unexpected or missing session request",
  );
  const args = [input.mode, "--session", input.session];
  if (input.request !== undefined) {
    absolute(input.request, "Request");
    args.push("--request", input.request);
  }
  if (input.approve !== undefined) args.push("--approve", input.approve);
  if (input.attended === true) args.push("--attended");
  return execute(root, "review-session.mjs", args);
}

export async function executeMaintainerReview(
  root: string,
  input: MaintainerReviewInput,
): Promise<PreparationOperationResult> {
  knownKeys(input, [
    "mode",
    "base",
    "head",
    "receipt",
    "validation",
    "session",
    "purpose",
  ]);
  insist(
    ["run", "check"].includes(input.mode),
    "Unsupported maintainer review mode",
  );
  insist(
    [input.base, input.head].every(
      (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value),
    ),
    "Exact base and head commit identities are required",
  );
  absolute(input.receipt, "Receipt");
  insist(
    input.mode === "run" ||
      (input.validation === undefined && input.purpose === undefined),
    "Check does not accept validation or purpose overrides",
  );
  insist(
    input.purpose === undefined ||
      ["candidate", "acceptance"].includes(input.purpose),
    "Unknown review purpose",
  );
  const args = [
    input.mode,
    "--base",
    input.base,
    "--head",
    input.head,
    "--receipt",
    input.receipt,
  ];
  if (input.mode === "run") {
    insist(
      Array.isArray(input.validation) &&
        input.validation.length > 0 &&
        input.validation.length <= 50 &&
        input.validation.every(
          (value) =>
            typeof value === "string" &&
            value.length > 0 &&
            value.length < 4096 &&
            !value.includes("\0"),
        ),
      "Validation must be a nonempty argv array",
    );
    args.push("--validation", JSON.stringify(input.validation));
    if (input.purpose !== undefined) args.push("--purpose", input.purpose);
  }
  if (input.session !== undefined) {
    absolute(input.session, "Session");
    args.push("--session", input.session);
  }
  return execute(root, "maintainer-review.mjs", args);
}
