import { describe, expect, it } from "vitest";

import {
  ADAPTERS_CONFORMANCE_CERTIFICATION,
  assertCertificationManifest,
  validateCertificationManifest,
  type CertificationManifest,
} from "./index.js";

const baseManifest: CertificationManifest = {
  packageName: "@amca/adapters-test",
  adapterKind: "agent_runtime",
  currentLevel: "level_1_proposal_adapter",
  targetLevel: "level_2_tool_intercepting",
  allowedAuthority: ["proposal translation"],
  forbiddenAuthority: [
    "runtime execution",
    "receipt admission",
    "release decision",
    "proof authority",
  ],
  evidence: {
    phaseReports: [],
    missionTests: [],
    focusedCommands: [],
  },
};

describe("adapter certification manifests", () => {
  it("accepts the adapters-conformance package manifest", () => {
    expect(
      assertCertificationManifest(ADAPTERS_CONFORMANCE_CERTIFICATION),
    ).toBe(ADAPTERS_CONFORMANCE_CERTIFICATION);
  });

  it("does not accept ambiguous slash-level certification", () => {
    const result = validateCertificationManifest({
      ...baseManifest,
      currentLevel: "level_1_proposal_adapter/level_2_tool_intercepting",
    });

    expect(issueCodes(result)).toContain("ambiguous_certification_level");
  });

  it("does not allow adapters to claim Level 2+ without tool-interception evidence", () => {
    const result = validateCertificationManifest({
      ...baseManifest,
      currentLevel: "level_2_tool_intercepting",
      evidence: emptyEvidence(),
    });

    expect(issueCodes(result)).toContain("tool_interception_evidence_missing");
  });

  it("requires named Level 2+ evidence instead of generic phase prose", () => {
    const result = validateCertificationManifest({
      ...baseManifest,
      currentLevel: "level_2_tool_intercepting",
      evidence: {
        ...emptyEvidence(),
        phaseReports: ["docs/certification/tool-interception.md"],
      },
    });

    expect(issueCodes(result)).toContain("tool_interception_evidence_missing");
  });

  it("does not allow Level 3+ without replay certification evidence", () => {
    const result = validateCertificationManifest({
      ...baseManifest,
      currentLevel: "level_3_replay_certified",
      evidence: {
        ...emptyEvidence(),
        focusedCommands: ["adapter tool interception test"],
      },
    });

    expect(issueCodes(result)).toContain(
      "replay_certification_evidence_missing",
    );
  });

  it("does not allow Level 4 without critical-path evidence", () => {
    const result = validateCertificationManifest({
      ...baseManifest,
      currentLevel: "level_4_critical_path_certified",
      targetLevel: "level_4_critical_path_certified",
      evidence: {
        ...emptyEvidence(),
        focusedCommands: [
          "adapter tool interception test",
          "adapter replay certification test",
        ],
      },
    });

    expect(issueCodes(result)).toContain("critical_path_evidence_missing");
  });

  it("accepts promotion claims only when every required evidence gate is named", () => {
    const result = validateCertificationManifest({
      ...baseManifest,
      currentLevel: "level_4_critical_path_certified",
      targetLevel: "level_4_critical_path_certified",
      evidence: {
        phaseReports: ["docs/certification/runtime-certification.md"],
        missionTests: [
          "packages/testing/src/mission/substrate-containment.mission.test.ts#langgraph-tool-call-bypass-blocked",
          "packages/testing/src/mission/replay-causality.mission.test.ts#runtime-replay-certification",
        ],
        focusedCommands: [
          "pnpm exec vitest run packages/testing/src/mission/substrate-containment.mission.test.ts -t critical-path-runtime-bridge-certification",
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it("requires certification manifests to forbid receipt, release, and proof authority", () => {
    const result = validateCertificationManifest({
      ...baseManifest,
      forbiddenAuthority: ["runtime execution"],
    });

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        "receipt_admission_forbidden_missing",
        "release_authority_forbidden_missing",
        "proof_authority_forbidden_missing",
      ]),
    );
  });
});

function emptyEvidence(): CertificationManifest["evidence"] {
  return {
    phaseReports: [],
    missionTests: [],
    focusedCommands: [],
  };
}

function issueCodes(
  result: ReturnType<typeof validateCertificationManifest>,
): readonly string[] {
  return result.success ? [] : result.issues.map((issue) => issue.code);
}
