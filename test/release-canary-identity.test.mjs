import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { assertRegistryCanaryArtifact } from "../scripts/release-evidence-identity.mjs";

const artifactDigest = `sha256:${createHash("sha256").update("fixture").digest("hex")}`;
const npmIntegrity = `sha512-${createHash("sha512").update("fixture").digest("base64")}`;
const selected = { sha256: artifactDigest, npmIntegrity };
const canary = {
  distribution: "registry-release",
  artifactDigest,
  npmIntegrity,
};

it("binds both registry artifact identities to the installed bytes", () => {
  expect(assertRegistryCanaryArtifact(canary, selected)).toEqual({
    artifactDigest,
    npmIntegrity,
  });
});

it.each([
  { distribution: "source-preview" },
  { artifactDigest: undefined },
  { artifactDigest: `sha256:${"f".repeat(64)}` },
  {
    npmIntegrity: `sha512-${createHash("sha512").update("other").digest("base64")}`,
  },
])("rejects qualification evidence with a replaced binding %j", (change) => {
  expect(() =>
    assertRegistryCanaryArtifact({ ...canary, ...change }, selected),
  ).toThrow(/requires the exact installed artifact/u);
});
