import { describe, expect, it } from "vitest";

import { LEDGER_LOCAL_CERTIFICATION } from "@amca/ledger-local";
import {
  LEDGER_POSTGRES_CERTIFICATION,
  validateLedgerCertificationManifest,
} from "@amca/ledger-postgres";

import cliPackage from "../../../packages/cli/package.json" with { type: "json" };
import adaptersConformancePackage from "../../../packages/adapters-conformance/package.json" with { type: "json" };
import adaptersLangGraphPackage from "../../../packages/adapters-langgraph/package.json" with { type: "json" };
import adaptersTemporalPackage from "../../../packages/adapters-temporal/package.json" with { type: "json" };
import adaptersToolsPackage from "../../../packages/adapters-tools/package.json" with { type: "json" };
import capabilitiesPackage from "../../../packages/capabilities/package.json" with { type: "json" };
import contractsPackage from "../../../packages/contracts/package.json" with { type: "json" };
import effectBrokerPackage from "../../../packages/effect-broker/package.json" with { type: "json" };
import effectSdkPackage from "../../../packages/effect-sdk/package.json" with { type: "json" };
import evalPackage from "../../../packages/eval/package.json" with { type: "json" };
import harnessPackage from "../../../packages/harness/package.json" with { type: "json" };
import kernelPackage from "../../../packages/kernel/package.json" with { type: "json" };
import ledgerPackage from "../../../packages/ledger/package.json" with { type: "json" };
import ledgerLocalPackage from "../../../packages/ledger-local/package.json" with { type: "json" };
import ledgerPostgresPackage from "../../../packages/ledger-postgres/package.json" with { type: "json" };
import observabilityPackage from "../../../packages/observability/package.json" with { type: "json" };
import providerHarnessPackage from "../../../packages/provider-harness/package.json" with { type: "json" };
import proofPackage from "../../../packages/proof/package.json" with { type: "json" };
import projectionsPackage from "../../../packages/projections/package.json" with { type: "json" };
import protocolPackage from "../../../packages/protocol/package.json" with { type: "json" };
import reconciliationPackage from "../../../packages/reconciliation/package.json" with { type: "json" };
import replayPackage from "../../../packages/replay/package.json" with { type: "json" };
import securityPackage from "../../../packages/security/package.json" with { type: "json" };
import servicePackage from "../../../packages/service/package.json" with { type: "json" };
import testingPackage from "../../../packages/testing/package.json" with { type: "json" };

interface PackageJson {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
}

const packageJsonByName = {
  "@amca/protocol": protocolPackage,
  "@amca/contracts": contractsPackage,
  "@amca/ledger": ledgerPackage,
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
  "@amca/ledger-local": ledgerLocalPackage,
  "@amca/ledger-postgres": ledgerPostgresPackage,
  "@amca/replay": replayPackage,
  "@amca/testing": testingPackage,
  "@amca/cli": cliPackage,
} satisfies Record<string, unknown>;

const requiredWorkspaceDependencies = {
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
    "@amca/kernel",
    "@amca/ledger-local",
    "@amca/protocol",
    "@amca/replay",
    "@amca/testing",
  ],
} satisfies Record<string, readonly string[]>;

const allowedWorkspaceDependencies = {
  ...requiredWorkspaceDependencies,
  "@amca/cli": [...requiredWorkspaceDependencies["@amca/cli"], "@amca/harness"],
} satisfies Record<string, readonly string[]>;

type AmcaPackageName = keyof typeof requiredWorkspaceDependencies;

const substrateDependencyNames = [
  "@langchain/langgraph",
  "@temporalio/activity",
  "@temporalio/client",
  "@temporalio/common",
  "@temporalio/testing",
  "@temporalio/worker",
  "@temporalio/workflow",
] as const;

const allowedSubstrateDependenciesByPackage = {
  "@amca/adapters-langgraph": ["@langchain/langgraph"],
  "@amca/adapters-temporal": ["@temporalio/common"],
} satisfies Partial<Record<AmcaPackageName, readonly string[]>>;
const allowedSubstrateDependencyMap: Partial<
  Record<AmcaPackageName, readonly string[]>
> = allowedSubstrateDependenciesByPackage;

describe("AMCA package boundaries", () => {
  it("preserves the locked workspace dependency direction", () => {
    for (const packageName of Object.keys(
      requiredWorkspaceDependencies,
    ) as AmcaPackageName[]) {
      const requiredDependencies = requiredWorkspaceDependencies[packageName];
      const allowedDependencies = allowedWorkspaceDependencies[packageName];
      const packageJson = asPackageJson(packageJsonByName[packageName]);
      const actualDependencies = workspaceDependencies(packageJson);

      expect(packageJson.name).toBe(packageName);
      expect(actualDependencies).toEqual([...actualDependencies].sort());
      expect(actualDependencies).toEqual(
        expect.arrayContaining([...requiredDependencies].sort()),
      );
      for (const dependencyName of actualDependencies) {
        expect(
          allowedDependencies,
          `${packageName} must not depend on ${dependencyName}`,
        ).toContain(dependencyName);
      }
    }
  });

  it("keeps lower-level packages free of orchestration and CLI dependencies", () => {
    expect(workspaceDependencies(asPackageJson(protocolPackage))).toEqual([]);
    expect(
      workspaceDependencies(asPackageJson(contractsPackage)),
    ).not.toContain("@amca/kernel");
    expect(workspaceDependencies(asPackageJson(ledgerPackage))).not.toContain(
      "@amca/kernel",
    );
    expect(workspaceDependencies(asPackageJson(ledgerPackage))).not.toContain(
      "@amca/proof",
    );
    expect(workspaceDependencies(asPackageJson(ledgerPackage))).not.toContain(
      "@amca/capabilities",
    );
    expect(workspaceDependencies(asPackageJson(ledgerPackage))).not.toContain(
      "@amca/effect-sdk",
    );
    expect(workspaceDependencies(asPackageJson(ledgerPackage))).not.toContain(
      "@amca/effect-broker",
    );
    expect(workspaceDependencies(asPackageJson(ledgerPackage))).not.toContain(
      "@amca/harness",
    );
    expect(workspaceDependencies(asPackageJson(ledgerPackage))).not.toContain(
      "@amca/testing",
    );
    expect(workspaceDependencies(asPackageJson(ledgerPackage))).not.toContain(
      "@amca/cli",
    );
    expect(
      workspaceDependencies(asPackageJson(ledgerLocalPackage)),
    ).not.toContain("@amca/proof");
    expect(
      workspaceDependencies(asPackageJson(ledgerLocalPackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(ledgerLocalPackage)),
    ).not.toContain("@amca/harness");
    expect(
      workspaceDependencies(asPackageJson(ledgerLocalPackage)),
    ).not.toContain("@amca/cli");
    expect(
      workspaceDependencies(asPackageJson(ledgerPostgresPackage)),
    ).not.toContain("@amca/proof");
    expect(
      workspaceDependencies(asPackageJson(ledgerPostgresPackage)),
    ).not.toContain("@amca/capabilities");
    expect(
      workspaceDependencies(asPackageJson(ledgerPostgresPackage)),
    ).not.toContain("@amca/effect-sdk");
    expect(
      workspaceDependencies(asPackageJson(ledgerPostgresPackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(ledgerPostgresPackage)),
    ).not.toContain("@amca/harness");
    expect(
      workspaceDependencies(asPackageJson(ledgerPostgresPackage)),
    ).not.toContain("@amca/projections");
    expect(
      workspaceDependencies(asPackageJson(ledgerPostgresPackage)),
    ).not.toContain("@amca/replay");
    expect(
      workspaceDependencies(asPackageJson(ledgerPostgresPackage)),
    ).not.toContain("@amca/testing");
    expect(
      workspaceDependencies(asPackageJson(ledgerPostgresPackage)),
    ).not.toContain("@amca/cli");
    expect(workspaceDependencies(asPackageJson(proofPackage))).not.toContain(
      "@amca/kernel",
    );
    expect(workspaceDependencies(asPackageJson(protocolPackage))).not.toContain(
      "@amca/capabilities",
    );
    expect(
      workspaceDependencies(asPackageJson(contractsPackage)),
    ).not.toContain("@amca/capabilities");
    expect(workspaceDependencies(asPackageJson(proofPackage))).not.toContain(
      "@amca/capabilities",
    );
    expect(
      workspaceDependencies(asPackageJson(capabilitiesPackage)),
    ).not.toContain("@amca/effect-sdk");
    expect(
      workspaceDependencies(asPackageJson(capabilitiesPackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(effectSdkPackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(effectSdkPackage)),
    ).not.toContain("@amca/kernel");
    expect(
      workspaceDependencies(asPackageJson(effectBrokerPackage)),
    ).not.toContain("@amca/kernel");
    expect(
      workspaceDependencies(asPackageJson(effectBrokerPackage)),
    ).not.toContain("@amca/harness");
    expect(
      workspaceDependencies(asPackageJson(adaptersConformancePackage)),
    ).not.toContain("@amca/proof");
    expect(
      workspaceDependencies(asPackageJson(adaptersConformancePackage)),
    ).not.toContain("@amca/effect-sdk");
    expect(
      workspaceDependencies(asPackageJson(adaptersConformancePackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(adaptersConformancePackage)),
    ).not.toContain("@amca/kernel");
    expect(
      workspaceDependencies(asPackageJson(adaptersConformancePackage)),
    ).not.toContain("@amca/harness");
    expect(
      workspaceDependencies(asPackageJson(adaptersConformancePackage)),
    ).not.toContain("@amca/cli");
    expect(
      workspaceDependencies(asPackageJson(adaptersLangGraphPackage)),
    ).toEqual([
      "@amca/adapters-conformance",
      "@amca/contracts",
      "@amca/protocol",
    ]);
    expect(
      workspaceDependencies(asPackageJson(adaptersLangGraphPackage)),
    ).not.toContain("@amca/proof");
    expect(
      workspaceDependencies(asPackageJson(adaptersLangGraphPackage)),
    ).not.toContain("@amca/kernel");
    expect(
      workspaceDependencies(asPackageJson(adaptersLangGraphPackage)),
    ).not.toContain("@amca/ledger-local");
    expect(
      workspaceDependencies(asPackageJson(adaptersLangGraphPackage)),
    ).not.toContain("@amca/cli");
    expect(
      workspaceDependencies(asPackageJson(adaptersLangGraphPackage)),
    ).not.toContain("@amca/adapters-temporal");
    expect(
      workspaceDependencies(asPackageJson(adaptersTemporalPackage)),
    ).toEqual([
      "@amca/adapters-conformance",
      "@amca/contracts",
      "@amca/protocol",
    ]);
    expect(
      workspaceDependencies(asPackageJson(adaptersTemporalPackage)),
    ).not.toContain("@amca/proof");
    expect(
      workspaceDependencies(asPackageJson(adaptersTemporalPackage)),
    ).not.toContain("@amca/kernel");
    expect(
      workspaceDependencies(asPackageJson(adaptersTemporalPackage)),
    ).not.toContain("@amca/ledger-local");
    expect(
      workspaceDependencies(asPackageJson(adaptersTemporalPackage)),
    ).not.toContain("@amca/cli");
    expect(
      workspaceDependencies(asPackageJson(adaptersTemporalPackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(adaptersTemporalPackage)),
    ).not.toContain("@amca/harness");
    expect(
      workspaceDependencies(asPackageJson(adaptersToolsPackage)),
    ).not.toContain("@amca/capabilities");
    expect(
      workspaceDependencies(asPackageJson(adaptersToolsPackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(adaptersToolsPackage)),
    ).not.toContain("@amca/kernel");
    expect(
      workspaceDependencies(asPackageJson(adaptersToolsPackage)),
    ).not.toContain("@amca/harness");
    expect(
      workspaceDependencies(asPackageJson(adaptersToolsPackage)),
    ).not.toContain("@amca/cli");
    expect(workspaceDependencies(asPackageJson(evalPackage))).not.toContain(
      "@amca/proof",
    );
    expect(workspaceDependencies(asPackageJson(evalPackage))).not.toContain(
      "@amca/effect-broker",
    );
    expect(workspaceDependencies(asPackageJson(evalPackage))).not.toContain(
      "@amca/effect-sdk",
    );
    expect(workspaceDependencies(asPackageJson(evalPackage))).not.toContain(
      "@amca/harness",
    );
    expect(workspaceDependencies(asPackageJson(evalPackage))).not.toContain(
      "@amca/cli",
    );
    expect(
      workspaceDependencies(asPackageJson(projectionsPackage)),
    ).not.toContain("@amca/proof");
    expect(
      workspaceDependencies(asPackageJson(projectionsPackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(projectionsPackage)),
    ).not.toContain("@amca/kernel");
    expect(
      workspaceDependencies(asPackageJson(projectionsPackage)),
    ).not.toContain("@amca/harness");
    expect(
      workspaceDependencies(asPackageJson(projectionsPackage)),
    ).not.toContain("@amca/cli");
    expect(workspaceDependencies(asPackageJson(reconciliationPackage))).toEqual(
      ["@amca/contracts", "@amca/protocol"],
    );
    expect(
      workspaceDependencies(asPackageJson(reconciliationPackage)),
    ).not.toContain("@amca/proof");
    expect(
      workspaceDependencies(asPackageJson(reconciliationPackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(reconciliationPackage)),
    ).not.toContain("@amca/adapters-tools");
    expect(
      workspaceDependencies(asPackageJson(reconciliationPackage)),
    ).not.toContain("@amca/kernel");
    expect(
      workspaceDependencies(asPackageJson(reconciliationPackage)),
    ).not.toContain("@amca/harness");
    expect(
      workspaceDependencies(asPackageJson(reconciliationPackage)),
    ).not.toContain("@amca/replay");
    expect(
      workspaceDependencies(asPackageJson(reconciliationPackage)),
    ).not.toContain("@amca/eval");
    expect(
      workspaceDependencies(asPackageJson(reconciliationPackage)),
    ).not.toContain("@amca/testing");
    expect(
      workspaceDependencies(asPackageJson(reconciliationPackage)),
    ).not.toContain("@amca/cli");
    expect(workspaceDependencies(asPackageJson(securityPackage))).toEqual([
      "@amca/contracts",
      "@amca/protocol",
    ]);
    expect(workspaceDependencies(asPackageJson(securityPackage))).not.toContain(
      "@amca/proof",
    );
    expect(workspaceDependencies(asPackageJson(securityPackage))).not.toContain(
      "@amca/effect-broker",
    );
    expect(workspaceDependencies(asPackageJson(securityPackage))).not.toContain(
      "@amca/kernel",
    );
    expect(workspaceDependencies(asPackageJson(securityPackage))).not.toContain(
      "@amca/harness",
    );
    expect(workspaceDependencies(asPackageJson(securityPackage))).not.toContain(
      "@amca/testing",
    );
    expect(workspaceDependencies(asPackageJson(securityPackage))).not.toContain(
      "@amca/cli",
    );
    expect(workspaceDependencies(asPackageJson(servicePackage))).toEqual([
      "@amca/contracts",
      "@amca/harness",
      "@amca/projections",
      "@amca/protocol",
      "@amca/replay",
      "@amca/security",
    ]);
    expect(workspaceDependencies(asPackageJson(servicePackage))).not.toContain(
      "@amca/proof",
    );
    expect(workspaceDependencies(asPackageJson(servicePackage))).not.toContain(
      "@amca/effect-broker",
    );
    expect(workspaceDependencies(asPackageJson(servicePackage))).not.toContain(
      "@amca/effect-sdk",
    );
    expect(workspaceDependencies(asPackageJson(servicePackage))).not.toContain(
      "@amca/adapters-tools",
    );
    expect(workspaceDependencies(asPackageJson(servicePackage))).not.toContain(
      "@amca/ledger-postgres",
    );
    expect(workspaceDependencies(asPackageJson(servicePackage))).not.toContain(
      "@amca/testing",
    );
    expect(workspaceDependencies(asPackageJson(servicePackage))).not.toContain(
      "@amca/cli",
    );
    expect(workspaceDependencies(asPackageJson(observabilityPackage))).toEqual([
      "@amca/protocol",
    ]);
    expect(
      workspaceDependencies(asPackageJson(observabilityPackage)),
    ).not.toContain("@amca/proof");
    expect(
      workspaceDependencies(asPackageJson(observabilityPackage)),
    ).not.toContain("@amca/kernel");
    expect(
      workspaceDependencies(asPackageJson(observabilityPackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(observabilityPackage)),
    ).not.toContain("@amca/replay");
    expect(
      workspaceDependencies(asPackageJson(observabilityPackage)),
    ).not.toContain("@amca/testing");
    expect(
      workspaceDependencies(asPackageJson(observabilityPackage)),
    ).not.toContain("@amca/cli");
    expect(
      workspaceDependencies(asPackageJson(providerHarnessPackage)),
    ).toEqual([
      "@amca/adapters-conformance",
      "@amca/contracts",
      "@amca/protocol",
    ]);
    expect(
      workspaceDependencies(asPackageJson(providerHarnessPackage)),
    ).not.toContain("@amca/proof");
    expect(
      workspaceDependencies(asPackageJson(providerHarnessPackage)),
    ).not.toContain("@amca/effect-broker");
    expect(
      workspaceDependencies(asPackageJson(providerHarnessPackage)),
    ).not.toContain("@amca/harness");
    expect(
      workspaceDependencies(asPackageJson(providerHarnessPackage)),
    ).not.toContain("@amca/kernel");
    expect(
      workspaceDependencies(asPackageJson(providerHarnessPackage)),
    ).not.toContain("@amca/service");
    expect(
      workspaceDependencies(asPackageJson(providerHarnessPackage)),
    ).not.toContain("@amca/cli");
    expect(workspaceDependencies(asPackageJson(replayPackage))).not.toContain(
      "@amca/proof",
    );
    expect(workspaceDependencies(asPackageJson(replayPackage))).not.toContain(
      "@amca/effect-broker",
    );
    expect(workspaceDependencies(asPackageJson(replayPackage))).not.toContain(
      "@amca/effect-sdk",
    );
    expect(workspaceDependencies(asPackageJson(replayPackage))).not.toContain(
      "@amca/harness",
    );
    expect(workspaceDependencies(asPackageJson(replayPackage))).not.toContain(
      "@amca/cli",
    );
    expect(workspaceDependencies(asPackageJson(kernelPackage))).not.toContain(
      "@amca/ledger-postgres",
    );
    expect(workspaceDependencies(asPackageJson(kernelPackage))).not.toContain(
      "@amca/ledger-local",
    );
    expect(workspaceDependencies(asPackageJson(kernelPackage))).not.toContain(
      "@amca/capabilities",
    );
    expect(workspaceDependencies(asPackageJson(kernelPackage))).not.toContain(
      "@amca/effect-sdk",
    );
    expect(workspaceDependencies(asPackageJson(kernelPackage))).not.toContain(
      "@amca/effect-broker",
    );
    expect(workspaceDependencies(asPackageJson(kernelPackage))).not.toContain(
      "@amca/harness",
    );
    expect(workspaceDependencies(asPackageJson(kernelPackage))).not.toContain(
      "@amca/cli",
    );
    expect(workspaceDependencies(asPackageJson(harnessPackage))).not.toContain(
      "@amca/capabilities",
    );
    expect(workspaceDependencies(asPackageJson(harnessPackage))).not.toContain(
      "@amca/effect-sdk",
    );
    expect(workspaceDependencies(asPackageJson(harnessPackage))).not.toContain(
      "@amca/proof",
    );
    expect(workspaceDependencies(asPackageJson(harnessPackage))).not.toContain(
      "@amca/testing",
    );
    expect(workspaceDependencies(asPackageJson(harnessPackage))).not.toContain(
      "@amca/cli",
    );
    expect(workspaceDependencies(asPackageJson(testingPackage))).not.toContain(
      "@amca/cli",
    );
    expect(workspaceDependencies(asPackageJson(cliPackage))).not.toContain(
      "@amca/effect-broker",
    );
    expect(workspaceDependencies(asPackageJson(cliPackage))).not.toContain(
      "@amca/effect-sdk",
    );
    expect(workspaceDependencies(asPackageJson(cliPackage))).not.toContain(
      "@amca/proof",
    );
  });

  it("keeps substrate SDK dependencies adapter-local without worker or runtime execution APIs", () => {
    for (const packageName of Object.keys(
      packageJsonByName,
    ) as AmcaPackageName[]) {
      const packageJson = asPackageJson(packageJsonByName[packageName]);
      const actualSubstrateDependencies = dependencyNames(packageJson).filter(
        (dependencyName) =>
          substrateDependencyNames.includes(
            dependencyName as (typeof substrateDependencyNames)[number],
          ),
      );
      const allowedSubstrateDependencies =
        allowedSubstrateDependencyMap[packageName] ?? [];

      for (const dependencyName of actualSubstrateDependencies) {
        expect(
          allowedSubstrateDependencies,
          `${packageName} must not depend on substrate package ${dependencyName}`,
        ).toContain(dependencyName);
      }
    }

    const langGraphDependencies = dependencyNames(
      asPackageJson(adaptersLangGraphPackage),
    );
    for (const forbiddenDependency of [
      "@temporalio/activity",
      "@temporalio/client",
      "@temporalio/testing",
      "@temporalio/worker",
      "@temporalio/workflow",
    ]) {
      expect(langGraphDependencies).not.toContain(forbiddenDependency);
    }

    const temporalDependencies = dependencyNames(
      asPackageJson(adaptersTemporalPackage),
    );
    for (const forbiddenDependency of [
      "@langchain/langgraph",
      "@temporalio/activity",
      "@temporalio/client",
      "@temporalio/testing",
      "@temporalio/worker",
    ]) {
      expect(temporalDependencies).not.toContain(forbiddenDependency);
    }
  });

  it("keeps ledger certification separate from runtime adapter certification", () => {
    expect(
      validateLedgerCertificationManifest(LEDGER_LOCAL_CERTIFICATION).success,
    ).toBe(true);
    expect(
      validateLedgerCertificationManifest(LEDGER_POSTGRES_CERTIFICATION)
        .success,
    ).toBe(true);

    const result = validateLedgerCertificationManifest({
      packageName: "@amca/ledger-postgres",
      currentLevel: "level_2_tool_intercepting",
      allowedAuthority: ["semantic ledger contract"],
      forbiddenAuthority: ["runtime execution"],
      evidence: emptyLedgerCertificationEvidence(),
    });

    expect(ledgerIssueCodes(result)).toContain("invalid_certification_level");
    expect(
      ledgerIssueCodes(
        validateLedgerCertificationManifest({
          packageName: "@amca/ledger-postgres",
          currentLevel: "contract_only/live_integration_certified",
          allowedAuthority: ["semantic ledger contract"],
          forbiddenAuthority: ["runtime execution"],
          evidence: emptyLedgerCertificationEvidence(),
        }),
      ),
    ).toContain("ambiguous_certification_level");
  });

  it("no-ledger-claims-live-certification-without-live-test", () => {
    const result = validateLedgerCertificationManifest({
      packageName: "@amca/ledger-postgres",
      currentLevel: "live_integration_certified",
      targetLevel: "durable_production_certified",
      allowedAuthority: ["semantic ledger contract"],
      forbiddenAuthority: ["proof authority", "release decision"],
      evidence: emptyLedgerCertificationEvidence(),
    });

    expect(ledgerIssueCodes(result)).toContain(
      "live_integration_evidence_missing",
    );
  });
});

function workspaceDependencies(packageJson: PackageJson): string[] {
  return Object.entries(packageJson.dependencies ?? {})
    .filter(
      ([dependencyName, version]) =>
        dependencyName.startsWith("@amca/") && version === "workspace:*",
    )
    .map(([dependencyName]) => dependencyName)
    .sort();
}

function dependencyNames(packageJson: PackageJson): string[] {
  return Object.keys(packageJson.dependencies ?? {}).sort();
}

function asPackageJson(value: unknown): PackageJson {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string"
  ) {
    throw new Error("Expected package.json object with a string name.");
  }

  return value as PackageJson;
}

function emptyLedgerCertificationEvidence() {
  return {
    phaseReports: [],
    missionTests: [],
    focusedCommands: [],
    liveIntegrationTests: [],
    durabilityTests: [],
  };
}

function ledgerIssueCodes(
  result: ReturnType<typeof validateLedgerCertificationManifest>,
): readonly string[] {
  return result.success ? [] : result.issues.map((issue) => issue.code);
}
