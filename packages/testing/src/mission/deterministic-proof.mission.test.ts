import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { submitReleasedTestClaim } from "./mission-helpers.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("Mission P9 deterministic proof first", () => {
  it("does not release agent-provided Claim.statement as final text", () => {
    const { decision } = submitReleasedTestClaim(
      "mission_deterministic_rendering",
    );

    expect(decision.status).toBe("released");
    if (decision.status === "released") {
      expect(decision.finalMessage).toBe("Test suite unit passed.");
      expect(decision.finalMessage).not.toContain("Tests passed.");
    }
  });

  it("keeps blocking proof free of LLM and semantic-similarity authority", () => {
    const proofEngine = readFileSync(
      `${repoRoot}/packages/proof/src/proof-engine.ts`,
      "utf8",
    );
    const ruleDescriptor = readFileSync(
      `${repoRoot}/packages/proof/src/rule-descriptor.ts`,
      "utf8",
    );

    expect(`${proofEngine}\n${ruleDescriptor}`).not.toMatch(
      /llm|judge|semanticSimilarity|embedding|callback|function\s*\(/iu,
    );
  });
});
