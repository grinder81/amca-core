import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  domainGridCapabilities,
  domainGridDomains,
  runDomainGridScenario,
} from "../domain-grid.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("Mission P7/P10 domain integration grid litmus", () => {
  it("domain-grid-no-core-modification", () => {
    const coreSource = [
      ...readDirectorySources(path.join(repoRoot, "packages/protocol/src")),
      ...readDirectorySources(path.join(repoRoot, "packages/contracts/src")),
      ...readDirectorySources(path.join(repoRoot, "packages/kernel/src")),
      ...readDirectorySources(path.join(repoRoot, "packages/proof/src")),
      ...readDirectorySources(
        path.join(repoRoot, "packages/effect-broker/src"),
      ),
      ...readDirectorySources(
        path.join(repoRoot, "packages/provider-harness/src"),
      ),
    ].join("\n");

    expect(coreSource).not.toMatch(
      /trading|genomics|weather|dna_qc|static_analysis|forecast_validation|risk_analysis/iu,
    );
    expect(coreSource).not.toMatch(
      /from\s+["'][^"']*(?:examples\/|domain-|domain_)/iu,
    );
  });

  it("declares domain capabilities without executable hooks", () => {
    expect(domainGridCapabilities).toHaveLength(domainGridDomains.length);
    for (const capability of domainGridCapabilities) {
      expect(capability.metadata).toMatchObject({
        domainGrid: true,
        runtimeImplemented: false,
        coreModificationRequired: false,
      });
      expect(JSON.stringify(capability)).not.toMatch(/function|callback/iu);
    }
  });

  it("each-domain-supported-and-blocked-scenarios", () => {
    for (const domain of domainGridDomains) {
      const supported = runDomainGridScenario(domain, "supported");
      const blocked = runDomainGridScenario(domain, "blocked");

      expect(supported.releaseDecision.status).toBe("released");
      expect(supported.events.map((event) => event.type)).toContain(
        "EffectReceiptRecorded",
      );
      expect(supported.finalCandidate.claims[0]?.predicate.kind).toBe(
        "test_result",
      );

      expect(blocked.releaseDecision.status).toBe("blocked");
      expect(blocked.events.map((event) => event.type)).not.toContain(
        "EffectReceiptRecorded",
      );
      expect(
        blocked.events
          .filter((event) => event.type === "MismatchDetected")
          .map(
            (event) =>
              (
                event.payload as {
                  readonly mismatch: { readonly type: string };
                }
              ).mismatch.type,
          ),
      ).toEqual(["missing_evidence"]);
    }
  });
});

function readDirectorySources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = path.join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      return readDirectorySources(fullPath);
    }
    if (!entry.endsWith(".ts")) {
      return [];
    }
    return [readFileSync(fullPath, "utf8")];
  });
}
