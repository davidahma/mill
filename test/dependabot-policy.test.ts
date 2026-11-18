import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { temporaryDirectory } from "./helpers.js";

const script = path.resolve("scripts/check-dependabot.mjs");
const files = [
  ".github/dependabot.yml",
  "policy-starters/node-npm/.github/dependabot.yml",
];

describe("Dependabot policy", () => {
  it("accepts the repository and distributed starter", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      1,
      "- minor",
      "- version-update:semver-minor",
      "invalid group update-types",
    ],
    [0, "- minor", "- major", "development groups must allow only"],
    [0, "version-update:semver-major", "major", "invalid ignore entry"],
    [0, '"@types/node"', '"another-package"', "missing @types/node"],
    [1, "groups:", "invalid-groups:", "missing bounded development group"],
    [1, "version: 2", "version: 3", "expected version 2"],
    [
      0,
      "directory: /recipes/node-typescript-next-web",
      "directory: /recipes/other",
      "expected one npm update entry for /recipes/node-typescript-next-web",
    ],
    [
      0,
      "applies-to: security-updates",
      "applies-to: version-updates",
      "security updates must remain grouped",
    ],
    [
      0,
      "open-pull-requests-limit: 0",
      "open-pull-requests-limit: 3",
      "recipe version updates must be disabled",
    ],
    [
      0,
      "recipe-security:\n        applies-to: security-updates",
      "recipe-security:\n        applies-to: version-updates",
      "security updates must remain grouped",
    ],
    [
      0,
      'recipe-security:\n        applies-to: security-updates\n        patterns:\n          - "*"',
      'recipe-security:\n        applies-to: security-updates\n        patterns:\n          - "*"\n      development:\n        dependency-type: development\n        update-types:\n          - minor\n          - patch',
      "recipe groups must apply only to security updates",
    ],
  ] as const)(
    "rejects policy regression %s: %s -> %s",
    async (fileIndex, before, after, message) => {
      const temporary = await temporaryDirectory("mill-dependabot-");
      try {
        for (const [index, file] of files.entries()) {
          const destination = path.join(temporary.path, file);
          await mkdir(path.dirname(destination), { recursive: true });
          const source = await readFile(file, "utf8");
          await writeFile(
            destination,
            index === fileIndex ? source.replace(before, after) : source,
          );
        }
        const result = spawnSync(process.execPath, [script], {
          cwd: temporary.path,
          encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
      } finally {
        await temporary.cleanup();
      }
    },
  );
});
