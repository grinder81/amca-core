export type LedgerCertificationLevel =
  | "contract_only"
  | "local_artifact_certified"
  | "live_integration_certified"
  | "durable_production_certified";

export interface LedgerCertificationEvidence {
  readonly phaseReports: readonly string[];
  readonly missionTests: readonly string[];
  readonly focusedCommands: readonly string[];
  readonly liveIntegrationTests: readonly string[];
  readonly durabilityTests: readonly string[];
}

export interface LedgerCertificationManifest {
  readonly packageName: string;
  readonly currentLevel: LedgerCertificationLevel;
  readonly targetLevel?: LedgerCertificationLevel | undefined;
  readonly allowedAuthority: readonly string[];
  readonly forbiddenAuthority: readonly string[];
  readonly evidence: LedgerCertificationEvidence;
}

export interface LedgerCertificationValidationIssue {
  readonly code:
    | "invalid_manifest"
    | "ambiguous_certification_level"
    | "invalid_certification_level"
    | "target_level_regresses"
    | "live_integration_evidence_missing"
    | "durable_production_evidence_missing";
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export type LedgerCertificationValidationResult =
  | {
      readonly success: true;
      readonly data: LedgerCertificationManifest;
    }
  | {
      readonly success: false;
      readonly issues: readonly LedgerCertificationValidationIssue[];
    };

export class LedgerCertificationManifestError extends Error {
  readonly issues: readonly LedgerCertificationValidationIssue[];

  constructor(issues: readonly LedgerCertificationValidationIssue[]) {
    super("Ledger certification manifest validation failed");
    this.name = "LedgerCertificationManifestError";
    this.issues = issues;
  }
}

const ledgerCertificationLevels = [
  "contract_only",
  "local_artifact_certified",
  "live_integration_certified",
  "durable_production_certified",
] as const satisfies readonly LedgerCertificationLevel[];

const ledgerLevelRank: Record<LedgerCertificationLevel, number> = {
  contract_only: 0,
  local_artifact_certified: 1,
  live_integration_certified: 2,
  durable_production_certified: 3,
};

export function validateLedgerCertificationManifest(
  input: unknown,
): LedgerCertificationValidationResult {
  const issues: LedgerCertificationValidationIssue[] = [];

  if (!isRecord(input)) {
    return {
      success: false,
      issues: [
        {
          code: "invalid_manifest",
          path: [],
          message: "Ledger certification manifest must be an object.",
        },
      ],
    };
  }

  const manifest = input;
  validateString(manifest.packageName, ["packageName"], issues);
  validateLevel(manifest.currentLevel, ["currentLevel"], issues);
  if (manifest.targetLevel !== undefined) {
    validateLevel(manifest.targetLevel, ["targetLevel"], issues);
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

  const parsed = manifest as unknown as LedgerCertificationManifest;
  if (
    parsed.targetLevel !== undefined &&
    ledgerLevelRank[parsed.targetLevel] < ledgerLevelRank[parsed.currentLevel]
  ) {
    issues.push({
      code: "target_level_regresses",
      path: ["targetLevel"],
      message: "Ledger targetLevel must not be lower than currentLevel.",
    });
  }

  if (
    ledgerLevelRank[parsed.currentLevel] >=
      ledgerLevelRank.live_integration_certified &&
    parsed.evidence.liveIntegrationTests.length === 0
  ) {
    issues.push({
      code: "live_integration_evidence_missing",
      path: ["evidence", "liveIntegrationTests"],
      message:
        "Live ledger certification requires at least one named live integration test.",
    });
  }

  if (
    parsed.currentLevel === "durable_production_certified" &&
    parsed.evidence.durabilityTests.length === 0
  ) {
    issues.push({
      code: "durable_production_evidence_missing",
      path: ["evidence", "durabilityTests"],
      message:
        "Durable production ledger certification requires named durability evidence.",
    });
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return { success: true, data: parsed };
}

export function assertLedgerCertificationManifest(
  input: unknown,
): LedgerCertificationManifest {
  const result = validateLedgerCertificationManifest(input);
  if (result.success) {
    return result.data;
  }

  throw new LedgerCertificationManifestError(result.issues);
}

export function ledgerCertificationLevelRank(
  level: LedgerCertificationLevel,
): number {
  return ledgerLevelRank[level];
}

function validateEvidence(
  value: unknown,
  path: readonly PropertyKey[],
  issues: LedgerCertificationValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({
      code: "invalid_manifest",
      path,
      message: "Ledger certification evidence must be an object.",
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
  validateStringArray(
    value.liveIntegrationTests,
    [...path, "liveIntegrationTests"],
    issues,
  );
  validateStringArray(
    value.durabilityTests,
    [...path, "durabilityTests"],
    issues,
  );
}

function validateLevel(
  value: unknown,
  path: readonly PropertyKey[],
  issues: LedgerCertificationValidationIssue[],
): void {
  if (typeof value === "string" && value.includes("/")) {
    issues.push({
      code: "ambiguous_certification_level",
      path,
      message:
        "Ledger certification levels must use one machine-readable value; slash levels are forbidden.",
    });
    return;
  }

  if (
    typeof value !== "string" ||
    !ledgerCertificationLevels.includes(value as LedgerCertificationLevel)
  ) {
    issues.push({
      code: "invalid_certification_level",
      path,
      message: `Expected one of: ${ledgerCertificationLevels.join(", ")}.`,
    });
  }
}

function validateString(
  value: unknown,
  path: readonly PropertyKey[],
  issues: LedgerCertificationValidationIssue[],
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
  issues: LedgerCertificationValidationIssue[],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
