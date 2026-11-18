import { createHash } from "node:crypto";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalDigest } from "../contracts/canonical.js";
import { MILL_PACKAGE, MILL_VERSION } from "../version.js";

const controllerDirectory = fileURLToPath(new URL("../", import.meta.url));
const packageDirectory = path.resolve(controllerDirectory, "..");
const runtimeScripts = [
  "maintainer-review.mjs",
  "promotion-readiness.mjs",
  "review-session.mjs",
];

async function fileDigest(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** Fingerprint the distributed runtime, excluding host paths and build timestamps. */
export async function controllerArtifactDigest(): Promise<string> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const files: string[] = [];
  for await (const file of glob(`**/*.${extension}`, {
    cwd: controllerDirectory,
    exclude: ["**/*.d.ts"],
  })) {
    files.push(file.split(path.sep).join("/"));
  }
  if (!files.includes(`cli.${extension}`))
    throw new Error("The Mill controller installation is incomplete.");
  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  return canonicalDigest({
    schemaVersion: "1",
    package: MILL_PACKAGE,
    version: MILL_VERSION,
    dependencies: manifest.dependencies,
    files: await Promise.all(
      files.sort().map(async (file) => ({
        file,
        digest: await fileDigest(path.join(controllerDirectory, file)),
      })),
    ),
    scripts: await Promise.all(
      runtimeScripts.map(async (file) => ({
        file,
        digest: await fileDigest(path.join(packageDirectory, "scripts", file)),
      })),
    ),
  });
}

export async function sourceControllerPin() {
  return {
    package: MILL_PACKAGE,
    version: MILL_VERSION,
    controllerDigest: await controllerArtifactDigest(),
  };
}
