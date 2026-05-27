import type { CertificationManifest } from "@amca/adapters-conformance";

export const PROVIDER_HARNESS_CERTIFICATION: CertificationManifest = {
  packageName: "@amca/provider-harness",
  adapterKind: "model_adapter",
  currentLevel: "level_1_proposal_adapter",
  targetLevel: "level_2_tool_intercepting",
  allowedAuthority: [
    "build OpenAI-compatible local provider requests",
    "call an explicitly configured provider when the caller invokes the harness",
    "convert provider content into AMCA proposal candidates",
    "convert provider tool-call-shaped output into ToolCommandRequest proposals",
    "emit provider metadata as non-proof substrate state",
  ],
  forbiddenAuthority: [
    "external tool execution",
    "receipt admission",
    "release decision",
    "proof authority",
    "treating provider traces as evidence",
  ],
  evidence: {
    phaseReports: ["docs/provider-harness.md#certification-boundary"],
    missionTests: [
      "packages/testing/src/mission/provider-harness.mission.test.ts",
    ],
    focusedCommands: [
      "pnpm exec vitest run packages/provider-harness/src/provider-harness.test.ts",
    ],
  },
};

export const PROVIDER_HARNESS_MATURITY = {
  status: "implementation_ready_live_certification_pending",
  liveProviderCertified: false,
  productionRuntimeReady: false,
  externalToolExecution: false,
  receiptAdmissionAuthority: false,
  proofAuthority: false,
  releaseAuthority: false,
} as const;
