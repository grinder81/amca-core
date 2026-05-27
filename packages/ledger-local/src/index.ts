import type { LedgerCertificationManifest } from "@amca/ledger";

export const LEDGER_LOCAL_CERTIFICATION: LedgerCertificationManifest = {
  packageName: "@amca/ledger-local",
  currentLevel: "local_artifact_certified",
  allowedAuthority: [
    "append accepted semantic RunEvent objects to local JSONL artifacts",
    "read accepted local semantic RunEvent history",
    "verify local run-event ordering and hashes through the ledger contract",
  ],
  forbiddenAuthority: [
    "proof authority",
    "release decision",
    "effect dispatch",
    "live database durability claim",
  ],
  evidence: {
    phaseReports: ["docs/ledger.md#local-ledger"],
    missionTests: [
      "packages/testing/src/mission/local-ledger-adapter.mission.test.ts",
    ],
    focusedCommands: [
      "pnpm exec vitest run packages/ledger-local/src/local-jsonl-ledger.test.ts",
    ],
    liveIntegrationTests: [],
    durabilityTests: [],
  },
};

export {
  LocalJsonlSemanticLedger,
  localRunEventsPath,
  type LocalJsonlSemanticLedgerOptions,
} from "./local-jsonl-ledger.js";
