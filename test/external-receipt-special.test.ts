import { execFile } from "node:child_process";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { readExternalReceipt } from "../src/runtime/external-verification.js";
import { temporaryDirectory } from "./helpers.js";

const execute = promisify(execFile);

it("rejects a real FIFO with no writer without hanging receipt import", async () => {
  const temporary = await temporaryDirectory("mill-receipt-fifo-");
  try {
    const fifo = path.join(temporary.path, "receipt.json");
    await execute("/usr/bin/mkfifo", [fifo]);
    // A separate process bounds a regression in open(), including its libuv
    // worker. Load the real source rather than a stale prebuilt artifact.
    const source = `
      import fs from "node:fs";
      import { registerHooks } from "node:module";
      registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.endsWith(".js")&&context.parentURL){const candidate=new URL(specifier.replace(/\\.js$/,".ts"),context.parentURL);if(fs.existsSync(candidate))return next(candidate.href,context)}throw error}}});
      const { readExternalReceipt } = await import(${JSON.stringify(new URL("../src/runtime/external-verification.ts", import.meta.url).href)});
      try {
        await readExternalReceipt(process.argv[1]);
        throw new Error("FIFO was accepted");
      } catch (error) {
        if (error.code !== "EXTERNAL_EVIDENCE_INVALID") throw error;
        process.stdout.write(error.code);
      }
    `;
    const result = await execute(
      process.execPath,
      ["--input-type=module", "-e", source, fifo],
      { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096 },
    );
    expect(result.stdout).toBe("EXTERNAL_EVIDENCE_INVALID");
  } finally {
    await temporary.cleanup();
  }
});

it("reads a real regular file while rejecting symlinks and directories", async () => {
  const temporary = await temporaryDirectory("mill-receipt-regular-");
  try {
    const file = path.join(temporary.path, "receipt.json");
    const link = path.join(temporary.path, "receipt-link.json");
    await writeFile(file, '{"fixture":true}');
    await symlink(file, link);
    await expect(readExternalReceipt(file)).resolves.toEqual({ fixture: true });
    await expect(readExternalReceipt(link)).rejects.toThrow();
    await expect(readExternalReceipt(temporary.path)).rejects.toMatchObject({
      code: "EXTERNAL_EVIDENCE_INVALID",
    });
  } finally {
    await temporary.cleanup();
  }
});

it("reports malformed or missing receipt failures without their private path or content", async () => {
  const temporary = await temporaryDirectory("mill-private-receipt-");
  try {
    const file = path.join(temporary.path, "receipt.json");
    await expect(readExternalReceipt(file)).rejects.toEqual(
      expect.objectContaining({
        code: "EXTERNAL_EVIDENCE_INVALID",
        message: "The receipt could not be safely read.",
      }),
    );
    await writeFile(file, "unquoted private report content");
    await expect(readExternalReceipt(file)).rejects.toEqual(
      expect.objectContaining({
        code: "EXTERNAL_EVIDENCE_INVALID",
        message: "Receipt is not valid UTF-8 JSON.",
      }),
    );
  } finally {
    await temporary.cleanup();
  }
});
