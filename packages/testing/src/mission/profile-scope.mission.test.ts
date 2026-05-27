import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scenarioFixtures } from "../index.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("Mission P10 risk-adaptive scope", () => {
  it("keeps Core v0 scenarios on the Standard profile without adding profile systems early", () => {
    expect(
      new Set(scenarioFixtures.map((scenario) => scenario.profile)),
    ).toEqual(new Set(["standard"]));
  });

  it("does not introduce deferred architecture before its phase gate", () => {
    expect(existsSync(`${repoRoot}/packages/domain-packs`)).toBe(false);
    expect(existsSync(`${repoRoot}/packages/graph-factory`)).toBe(false);
    expect(existsSync(`${repoRoot}/packages/mutation-kernel`)).toBe(false);
    expect(existsSync(`${repoRoot}/services`)).toBe(false);
  });
});
