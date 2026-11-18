import type { Command } from "commander";

import type { CliIo } from "./cli-program.js";
import { enforceExactVersion, findRepositoryRoot } from "./config/lock.js";
import { ExitCode, MillError } from "./errors.js";
import { operatorHandoff } from "./planning/handoff.js";
import { loadOperatorManifest, taskReadiness } from "./planning/operator.js";
import { prepareOutcome } from "./planning/preparation.js";
import {
  executeMaintainerReview,
  executePreparationSession,
  type PreparationSessionInput,
} from "./planning/review-session.js";
import { commandResult, formatHuman } from "./result.js";

export function registerOperations(
  program: Command,
  init: Command,
  io: CliIo,
): void {
  async function root(): Promise<string> {
    const selected = await findRepositoryRoot(
      program.opts<{ cwd: string }>().cwd,
    );
    await enforceExactVersion(selected);
    return selected;
  }
  function emit(command: string, data: unknown, ok = true): void {
    const result = commandResult({ command, ok, data });
    io.stdout.write(
      program.opts<{ json?: boolean }>().json
        ? `${JSON.stringify(result)}\n`
        : formatHuman(result),
    );
    if (!ok)
      throw new MillError(
        "PREPARATION_BLOCKED",
        "Preparation operation did not pass.",
        ExitCode.configuration,
        { resultAlreadyEmitted: true },
      );
  }
  init
    .command("prepare")
    .description(
      "draft one outcome and disclose missing decisions without writing authority",
    )
    .requiredOption("--prd <path>", "repository-relative PRD")
    .requiredOption(
      "--request <path>",
      "repository-relative preparation request",
    )
    .action(async (options: { prd: string; request: string }) => {
      emit(
        "init prepare",
        await prepareOutcome({
          root: await root(),
          prdPath: options.prd,
          requestPath: options.request,
        }),
      );
    });

  const sessions = program
    .command("preparation-session")
    .description("operate a retained preparation review session");
  for (const mode of [
    "create",
    "status",
    "replan",
    "hosted",
    "reconcile",
    "continue",
    "handoff",
  ] as const) {
    const command = sessions
      .command(mode)
      .requiredOption("--session <path>", "absolute retained session path");
    if (["create", "replan", "hosted", "continue"].includes(mode))
      command.requiredOption("--request <path>", "absolute request path");
    if (["continue", "reconcile"].includes(mode))
      command
        .option("--approve <digest>", "exact operation approval digest")
        .option("--attended", "owner attends the approved operation");
    command.action(async (options: Omit<PreparationSessionInput, "mode">) => {
      const result = await executePreparationSession(await root(), {
        ...options,
        mode,
      });
      emit(`preparation-session ${mode}`, result.output, result.exitCode === 0);
    });
  }
  const review = program
    .command("maintainer-review")
    .description(
      "review an exact native maintainer candidate or acceptance preparation",
    );
  for (const mode of ["run", "check"] as const) {
    const command = review
      .command(mode)
      .requiredOption("--base <commit>", "exact base commit")
      .requiredOption("--head <commit>", "exact candidate commit")
      .requiredOption("--receipt <path>", "absolute receipt path")
      .option("--session <path>", "absolute retained session path");
    if (mode === "run")
      command
        .requiredOption("--validation <json>", "JSON command argv array")
        .option("--purpose <purpose>", "candidate or acceptance", "candidate");
    command.action(
      async (options: {
        base: string;
        head: string;
        receipt: string;
        session?: string;
        validation?: string;
        purpose?: "candidate" | "acceptance";
      }) => {
        let validation: readonly string[] | undefined;
        if (options.validation !== undefined) {
          try {
            validation = JSON.parse(options.validation) as readonly string[];
          } catch {
            throw new MillError(
              "USAGE_ERROR",
              "--validation must be a JSON argv array.",
              ExitCode.usage,
            );
          }
        }
        const selected = {
          base: options.base,
          head: options.head,
          receipt: options.receipt,
          ...(options.session === undefined
            ? {}
            : { session: options.session }),
          ...(options.purpose === undefined
            ? {}
            : { purpose: options.purpose }),
        };
        const result = await executeMaintainerReview(await root(), {
          ...selected,
          mode,
          ...(validation === undefined ? {} : { validation }),
        });
        emit(`maintainer-review ${mode}`, result.output, result.exitCode === 0);
      },
    );
  }
  program
    .command("readiness")
    .description(
      "inspect task context, spend policy and verifier availability without starting a run",
    )
    .requiredOption("--task <path>", "task packet path")
    .option("--run <id>", "same-task run for recorded prior usage")
    .option(
      "--probe-verifier",
      "inspect the pinned local image without pulling",
    )
    .option("--attended", "operator attends the local image probe")
    .action(
      async (options: {
        task: string;
        probeVerifier?: boolean;
        attended?: boolean;
        run?: string;
      }) => {
        emit(
          "readiness",
          await taskReadiness({
            root: await root(),
            taskPath: options.task,
            ...(options.run === undefined ? {} : { runId: options.run }),
            ...(options.probeVerifier === undefined
              ? {}
              : { probeVerifier: options.probeVerifier }),
            ...(options.attended === undefined
              ? {}
              : { attended: options.attended }),
          }),
        );
      },
    );
  program
    .command("change-evidence")
    .description(
      "summarize declared whole-change evidence without inventing costs or human effort",
    )
    .requiredOption(
      "--file <path>",
      "repository-relative change evidence manifest",
    )
    .action(async (options: { file: string }) =>
      emit(
        "change-evidence",
        await loadOperatorManifest(await root(), options.file, "change"),
      ),
    );
  program
    .command("consumption")
    .description("inspect public artifact and private qualification bindings")
    .command("inspect")
    .requiredOption(
      "--file <path>",
      "repository-relative exact consumption manifest",
    )
    .action(async (options: { file: string }) =>
      emit(
        "consumption inspect",
        await loadOperatorManifest(await root(), options.file, "consumption"),
      ),
    );
  program
    .command("handoff")
    .description(
      "show all recorded blockers, progress freshness and the next safe operation",
    )
    .option("--run <id>", "run id, defaults to latest")
    .option(
      "--task <path>",
      "approved task packet for checking historical run authority",
    )
    .option(
      "--owner-disposition <path>",
      "repository-relative terminal native owner disposition",
    )
    .action(
      async (options: {
        run?: string;
        task?: string;
        ownerDisposition?: string;
      }) =>
        emit(
          "handoff",
          await operatorHandoff({
            root: await root(),
            ...(options.run === undefined ? {} : { runId: options.run }),
            ...(options.task === undefined ? {} : { taskPath: options.task }),
            ...(options.ownerDisposition === undefined
              ? {}
              : { ownerDispositionPath: options.ownerDisposition }),
          }),
        ),
    );
}
