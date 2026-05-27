import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import adaptersConformancePackage from "../../../../packages/adapters-conformance/package.json" with { type: "json" };
import adaptersLangGraphPackage from "../../../../packages/adapters-langgraph/package.json" with { type: "json" };
import adaptersTemporalPackage from "../../../../packages/adapters-temporal/package.json" with { type: "json" };
import adaptersToolsPackage from "../../../../packages/adapters-tools/package.json" with { type: "json" };
import capabilitiesPackage from "../../../../packages/capabilities/package.json" with { type: "json" };
import cliPackage from "../../../../packages/cli/package.json" with { type: "json" };
import contractsPackage from "../../../../packages/contracts/package.json" with { type: "json" };
import effectBrokerPackage from "../../../../packages/effect-broker/package.json" with { type: "json" };
import effectSdkPackage from "../../../../packages/effect-sdk/package.json" with { type: "json" };
import evalPackage from "../../../../packages/eval/package.json" with { type: "json" };
import harnessPackage from "../../../../packages/harness/package.json" with { type: "json" };
import kernelPackage from "../../../../packages/kernel/package.json" with { type: "json" };
import ledgerPackage from "../../../../packages/ledger/package.json" with { type: "json" };
import ledgerLocalPackage from "../../../../packages/ledger-local/package.json" with { type: "json" };
import ledgerPostgresPackage from "../../../../packages/ledger-postgres/package.json" with { type: "json" };
import observabilityPackage from "../../../../packages/observability/package.json" with { type: "json" };
import providerHarnessPackage from "../../../../packages/provider-harness/package.json" with { type: "json" };
import proofPackage from "../../../../packages/proof/package.json" with { type: "json" };
import projectionsPackage from "../../../../packages/projections/package.json" with { type: "json" };
import protocolPackage from "../../../../packages/protocol/package.json" with { type: "json" };
import reconciliationPackage from "../../../../packages/reconciliation/package.json" with { type: "json" };
import replayPackage from "../../../../packages/replay/package.json" with { type: "json" };
import securityPackage from "../../../../packages/security/package.json" with { type: "json" };
import servicePackage from "../../../../packages/service/package.json" with { type: "json" };
import testingPackage from "../../../../packages/testing/package.json" with { type: "json" };

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const allowedWorkspaceDependencies = {
  "@amca/protocol": [],
  "@amca/contracts": ["@amca/protocol"],
  "@amca/ledger": ["@amca/contracts", "@amca/protocol"],
  "@amca/ledger-local": ["@amca/contracts", "@amca/ledger", "@amca/protocol"],
  "@amca/ledger-postgres": [
    "@amca/contracts",
    "@amca/ledger",
    "@amca/protocol",
  ],
  "@amca/proof": ["@amca/contracts", "@amca/protocol"],
  "@amca/capabilities": ["@amca/contracts", "@amca/proof", "@amca/protocol"],
  "@amca/effect-sdk": ["@amca/capabilities", "@amca/protocol"],
  "@amca/effect-broker": [
    "@amca/capabilities",
    "@amca/contracts",
    "@amca/effect-sdk",
    "@amca/protocol",
  ],
  "@amca/adapters-conformance": ["@amca/contracts", "@amca/protocol"],
  "@amca/adapters-langgraph": [
    "@amca/adapters-conformance",
    "@amca/contracts",
    "@amca/protocol",
  ],
  "@amca/adapters-temporal": [
    "@amca/adapters-conformance",
    "@amca/contracts",
    "@amca/protocol",
  ],
  "@amca/adapters-tools": [
    "@amca/contracts",
    "@amca/effect-sdk",
    "@amca/protocol",
  ],
  "@amca/eval": [
    "@amca/contracts",
    "@amca/ledger",
    "@amca/projections",
    "@amca/protocol",
    "@amca/replay",
  ],
  "@amca/projections": ["@amca/contracts", "@amca/protocol"],
  "@amca/reconciliation": ["@amca/contracts", "@amca/protocol"],
  "@amca/security": ["@amca/contracts", "@amca/protocol"],
  "@amca/service": [
    "@amca/contracts",
    "@amca/harness",
    "@amca/projections",
    "@amca/protocol",
    "@amca/replay",
    "@amca/security",
  ],
  "@amca/observability": ["@amca/protocol"],
  "@amca/provider-harness": [
    "@amca/adapters-conformance",
    "@amca/contracts",
    "@amca/protocol",
  ],
  "@amca/kernel": [
    "@amca/contracts",
    "@amca/ledger",
    "@amca/proof",
    "@amca/protocol",
  ],
  "@amca/harness": [
    "@amca/contracts",
    "@amca/effect-broker",
    "@amca/kernel",
    "@amca/protocol",
  ],
  "@amca/replay": ["@amca/contracts", "@amca/kernel", "@amca/protocol"],
  "@amca/testing": [
    "@amca/adapters-conformance",
    "@amca/adapters-langgraph",
    "@amca/adapters-temporal",
    "@amca/adapters-tools",
    "@amca/capabilities",
    "@amca/contracts",
    "@amca/effect-broker",
    "@amca/effect-sdk",
    "@amca/eval",
    "@amca/harness",
    "@amca/kernel",
    "@amca/ledger-local",
    "@amca/ledger-postgres",
    "@amca/observability",
    "@amca/provider-harness",
    "@amca/projections",
    "@amca/protocol",
    "@amca/reconciliation",
    "@amca/replay",
    "@amca/security",
    "@amca/service",
  ],
  "@amca/cli": [
    "@amca/capabilities",
    "@amca/contracts",
    "@amca/harness",
    "@amca/kernel",
    "@amca/ledger-local",
    "@amca/protocol",
    "@amca/replay",
    "@amca/testing",
  ],
} satisfies Record<string, readonly string[]>;

const packageJsonByName = {
  "@amca/protocol": protocolPackage,
  "@amca/contracts": contractsPackage,
  "@amca/ledger": ledgerPackage,
  "@amca/ledger-local": ledgerLocalPackage,
  "@amca/ledger-postgres": ledgerPostgresPackage,
  "@amca/proof": proofPackage,
  "@amca/capabilities": capabilitiesPackage,
  "@amca/effect-sdk": effectSdkPackage,
  "@amca/effect-broker": effectBrokerPackage,
  "@amca/eval": evalPackage,
  "@amca/adapters-conformance": adaptersConformancePackage,
  "@amca/adapters-langgraph": adaptersLangGraphPackage,
  "@amca/adapters-temporal": adaptersTemporalPackage,
  "@amca/adapters-tools": adaptersToolsPackage,
  "@amca/projections": projectionsPackage,
  "@amca/reconciliation": reconciliationPackage,
  "@amca/security": securityPackage,
  "@amca/service": servicePackage,
  "@amca/observability": observabilityPackage,
  "@amca/provider-harness": providerHarnessPackage,
  "@amca/kernel": kernelPackage,
  "@amca/harness": harnessPackage,
  "@amca/replay": replayPackage,
  "@amca/testing": testingPackage,
  "@amca/cli": cliPackage,
} satisfies Record<string, PackageJson>;

describe("Mission P7 core extensibility boundary", () => {
  it("preserves one-way package dependencies so extensions cannot rewrite core", () => {
    for (const [packageName, expected] of Object.entries(
      allowedWorkspaceDependencies,
    ) as [keyof typeof allowedWorkspaceDependencies, readonly string[]][]) {
      expect(workspaceDependencies(packageJsonByName[packageName])).toEqual(
        [...expected].sort(),
      );
    }
  });

  it("keeps domain concepts out of AMCA authority packages", () => {
    const coreAuthoritySource = coreAuthorityPackageSources().join("\n");

    expect(coreAuthoritySource).not.toMatch(
      /trading|genomics|weather|dna_qc|static_analysis|forecast_validation|risk_analysis/iu,
    );
  });

  it("blocks AMCA authority packages from importing domain extension code", () => {
    const coreAuthoritySource = coreAuthorityPackageSources().join("\n");

    expect(coreAuthoritySource).not.toMatch(
      /from\s+["'][^"']*(?:examples\/|domain-|domain_)/iu,
    );
  });
});

interface PackageJson {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
}

function workspaceDependencies(packageJson: PackageJson): string[] {
  return Object.entries(packageJson.dependencies ?? {})
    .filter(
      ([dependencyName, version]) =>
        dependencyName.startsWith("@amca/") && version === "workspace:*",
    )
    .map(([dependencyName]) => dependencyName)
    .sort();
}

function coreAuthorityPackageSources(): string[] {
  return [
    "packages/protocol/src",
    "packages/contracts/src",
    "packages/proof/src",
    "packages/kernel/src",
    "packages/effect-broker/src",
    "packages/provider-harness/src",
  ].flatMap((directory) => readDirectorySources(`${repoRoot}/${directory}`));
}

function readDirectorySources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = `${directory}/${entry}`;
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
