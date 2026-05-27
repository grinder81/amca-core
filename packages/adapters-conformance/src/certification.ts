export type CertificationLevel =
  | "level_0_shape_only"
  | "level_1_proposal_adapter"
  | "level_2_tool_intercepting"
  | "level_3_replay_certified"
  | "level_4_critical_path_certified";

export type CertificationStatus = CertificationLevel | "not_certified";

export type RuntimeMaturity =
  | "shape_only"
  | "proposal_boundary"
  | "tool_intercepting"
  | "replay_certified"
  | "critical_path_certified";

export type AdapterKind =
  | "agent_runtime"
  | "workflow_runtime"
  | "tool_adapter"
  | "model_adapter";

export interface CertificationEvidence {
  readonly phaseReports: readonly string[];
  readonly missionTests: readonly string[];
  readonly focusedCommands: readonly string[];
}

export interface CertificationManifest {
  readonly packageName: string;
  readonly adapterKind: AdapterKind;
  readonly currentLevel: CertificationStatus;
  readonly targetLevel?: CertificationLevel | undefined;
  readonly allowedAuthority: readonly string[];
  readonly forbiddenAuthority: readonly string[];
  readonly evidence: CertificationEvidence;
}

export interface CertificationValidationIssue {
  readonly code:
    | "invalid_manifest"
    | "ambiguous_certification_level"
    | "invalid_certification_level"
    | "target_level_regresses"
    | "receipt_admission_forbidden_missing"
    | "release_authority_forbidden_missing"
    | "proof_authority_forbidden_missing"
    | "tool_interception_evidence_missing"
    | "replay_certification_evidence_missing"
    | "critical_path_evidence_missing";
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export type CertificationValidationResult =
  | {
      readonly success: true;
      readonly data: CertificationManifest;
    }
  | {
      readonly success: false;
      readonly issues: readonly CertificationValidationIssue[];
    };

export class CertificationManifestError extends Error {
  readonly issues: readonly CertificationValidationIssue[];

  constructor(issues: readonly CertificationValidationIssue[]) {
    super("Adapter certification manifest validation failed");
    this.name = "CertificationManifestError";
    this.issues = issues;
  }
}

export const ADAPTERS_CONFORMANCE_CERTIFICATION: CertificationManifest = {
  packageName: "@amca/adapters-conformance",
  adapterKind: "tool_adapter",
  currentLevel: "level_0_shape_only",
  targetLevel: "level_1_proposal_adapter",
  allowedAuthority: [
    "declare adapter boundary contracts",
    "evaluate substrate emissions for conformance",
  ],
  forbiddenAuthority: [
    "runtime execution",
    "receipt admission",
    "release decision",
    "proof authority",
  ],
  evidence: {
    phaseReports: ["docs/adapters.md#adapters-conformance"],
    missionTests: [
      "packages/testing/src/mission/substrate-containment.mission.test.ts",
    ],
    focusedCommands: [
      "pnpm exec vitest run packages/adapters-conformance/src/conformance.test.ts",
    ],
  },
};

const certificationLevels = [
  "level_0_shape_only",
  "level_1_proposal_adapter",
  "level_2_tool_intercepting",
  "level_3_replay_certified",
  "level_4_critical_path_certified",
] as const satisfies readonly CertificationLevel[];

const certificationStatusValues = [
  "not_certified",
  ...certificationLevels,
] as const satisfies readonly CertificationStatus[];

const adapterKinds = [
  "agent_runtime",
  "workflow_runtime",
  "tool_adapter",
  "model_adapter",
] as const satisfies readonly AdapterKind[];

const levelRank: Record<CertificationStatus, number> = {
  not_certified: -1,
  level_0_shape_only: 0,
  level_1_proposal_adapter: 1,
  level_2_tool_intercepting: 2,
  level_3_replay_certified: 3,
  level_4_critical_path_certified: 4,
};

const requiredForbiddenAuthorities = [
  {
    code: "receipt_admission_forbidden_missing",
    pattern: /\breceipt\s+admission\b|\bdirect\s+(effect\s+)?receipt\b/iu,
    message:
      "Adapter certification must explicitly forbid direct receipt admission.",
  },
  {
    code: "release_authority_forbidden_missing",
    pattern: /\brelease\s+(decision|authority)\b/iu,
    message: "Adapter certification must explicitly forbid release authority.",
  },
  {
    code: "proof_authority_forbidden_missing",
    pattern: /\bproof\s+authority\b/iu,
    message: "Adapter certification must explicitly forbid proof authority.",
  },
] as const satisfies readonly {
  readonly code: CertificationValidationIssue["code"];
  readonly pattern: RegExp;
  readonly message: string;
}[];

export function validateCertificationManifest(
  input: unknown,
): CertificationValidationResult {
  const issues: CertificationValidationIssue[] = [];

  if (!isRecord(input)) {
    return {
      success: false,
      issues: [
        {
          code: "invalid_manifest",
          path: [],
          message: "Certification manifest must be an object.",
        },
      ],
    };
  }

  const manifest = input;
  validateString(manifest.packageName, ["packageName"], issues);
  validateEnum(manifest.adapterKind, adapterKinds, ["adapterKind"], issues);
  validateLevel(manifest.currentLevel, ["currentLevel"], issues, {
    allowNotCertified: true,
  });
  if (manifest.targetLevel !== undefined) {
    validateLevel(manifest.targetLevel, ["targetLevel"], issues, {
      allowNotCertified: false,
    });
  }
  validateStringArray(manifest.allowedAuthority, ["allowedAuthority"], issues);
  validateStringArray(
    manifest.forbiddenAuthority,
    ["forbiddenAuthority"],
    issues,
  );
  validateEvidence(manifest.evidence, ["evidence"], issues);

  if (issues.length > 0) {
    return { success: false, issues };
  }

  const parsed = manifest as unknown as CertificationManifest;
  if (
    parsed.targetLevel !== undefined &&
    levelRank[parsed.targetLevel] < levelRank[parsed.currentLevel]
  ) {
    issues.push({
      code: "target_level_regresses",
      path: ["targetLevel"],
      message: "Certification targetLevel must not be lower than currentLevel.",
    });
  }

  issues.push(...authorityIssues(parsed));
  issues.push(...evidenceIssues(parsed));

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return { success: true, data: parsed };
}

export function assertCertificationManifest(
  input: unknown,
): CertificationManifest {
  const result = validateCertificationManifest(input);
  if (result.success) {
    return result.data;
  }

  throw new CertificationManifestError(result.issues);
}

export function certificationLevelRank(level: CertificationStatus): number {
  return levelRank[level];
}

function evidenceIssues(
  manifest: CertificationManifest,
): CertificationValidationIssue[] {
  const issues: CertificationValidationIssue[] = [];
  const rank = levelRank[manifest.currentLevel];
  const namedEvidence = namedEvidenceText(manifest.evidence);

  if (
    rank >= 2 &&
    !matchesEvidence(
      namedEvidence,
      /tool.*intercept|intercept.*tool|tool[_ -]?call|tool[_ -]?command/iu,
    )
  ) {
    issues.push({
      code: "tool_interception_evidence_missing",
      path: ["evidence"],
      message:
        "Level 2 or higher adapter certification requires named tool interception evidence.",
    });
  }

  if (rank >= 3 && !matchesEvidence(namedEvidence, /replay/iu)) {
    issues.push({
      code: "replay_certification_evidence_missing",
      path: ["evidence"],
      message:
        "Level 3 or higher adapter certification requires replay certification evidence.",
    });
  }

  if (
    rank >= 4 &&
    !matchesEvidence(namedEvidence, /critical|critical[_ -]?path/iu)
  ) {
    issues.push({
      code: "critical_path_evidence_missing",
      path: ["evidence"],
      message: "Level 4 adapter certification requires critical-path evidence.",
    });
  }

  return issues;
}

function authorityIssues(
  manifest: CertificationManifest,
): CertificationValidationIssue[] {
  const forbiddenAuthority = manifest.forbiddenAuthority;
  return requiredForbiddenAuthorities.flatMap((requirement) =>
    matchesEvidence(forbiddenAuthority, requirement.pattern)
      ? []
      : [
          {
            code: requirement.code,
            path: ["forbiddenAuthority"],
            message: requirement.message,
          },
        ],
  );
}

function validateEvidence(
  value: unknown,
  path: readonly PropertyKey[],
  issues: CertificationValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({
      code: "invalid_manifest",
      path,
      message: "Certification evidence must be an object.",
    });
    return;
  }

  validateStringArray(value.phaseReports, [...path, "phaseReports"], issues);
  validateStringArray(value.missionTests, [...path, "missionTests"], issues);
  validateStringArray(
    value.focusedCommands,
    [...path, "focusedCommands"],
    issues,
  );
}

function validateLevel(
  value: unknown,
  path: readonly PropertyKey[],
  issues: CertificationValidationIssue[],
  options: { readonly allowNotCertified: boolean },
): void {
  if (typeof value === "string" && value.includes("/")) {
    issues.push({
      code: "ambiguous_certification_level",
      path,
      message:
        "Certification levels must use a single machine-readable value; slash levels are forbidden.",
    });
    return;
  }

  const allowed = options.allowNotCertified
    ? certificationStatusValues
    : certificationLevels;
  validateEnum(value, allowed, path, issues, "invalid_certification_level");
}

function validateString(
  value: unknown,
  path: readonly PropertyKey[],
  issues: CertificationValidationIssue[],
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({
      code: "invalid_manifest",
      path,
      message: "Expected a non-empty string.",
    });
  }
}

function validateStringArray(
  value: unknown,
  path: readonly PropertyKey[],
  issues: CertificationValidationIssue[],
): void {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    issues.push({
      code: "invalid_manifest",
      path,
      message: "Expected an array of non-empty strings.",
    });
  }
}

function validateEnum(
  value: unknown,
  allowed: readonly string[],
  path: readonly PropertyKey[],
  issues: CertificationValidationIssue[],
  code: CertificationValidationIssue["code"] = "invalid_manifest",
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.push({
      code,
      path,
      message: `Expected one of: ${allowed.join(", ")}.`,
    });
  }
}

function namedEvidenceText(evidence: CertificationEvidence): readonly string[] {
  return [...evidence.missionTests, ...evidence.focusedCommands];
}

function matchesEvidence(
  evidence: readonly string[],
  pattern: RegExp,
): boolean {
  return evidence.some((entry) => pattern.test(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
