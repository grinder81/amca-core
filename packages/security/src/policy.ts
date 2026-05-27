import type { EvidenceSensitivity } from "@amca/protocol";

import {
  SecurityError,
  type Principal,
  type PrincipalRole,
  type SecurityCapability,
  type SecurityContext,
} from "./types.js";

const allCapabilities = [
  "run:start",
  "run:execute",
  "run:inspect",
  "run:replay",
  "final:submit",
  "audit:export",
  "evidence:read_public",
  "evidence:read_internal",
  "evidence:read_confidential",
  "evidence:read_restricted",
] as const satisfies readonly SecurityCapability[];

const capabilitiesByRole = {
  viewer: ["run:inspect", "run:replay", "evidence:read_public"],
  operator: [
    "run:start",
    "run:execute",
    "run:inspect",
    "run:replay",
    "final:submit",
    "evidence:read_public",
    "evidence:read_internal",
    "evidence:read_confidential",
  ],
  auditor: [
    "run:inspect",
    "run:replay",
    "audit:export",
    "evidence:read_public",
    "evidence:read_internal",
    "evidence:read_confidential",
  ],
  service_admin: allCapabilities,
} as const satisfies Record<PrincipalRole, readonly SecurityCapability[]>;

const evidenceCapabilityBySensitivity = {
  public: "evidence:read_public",
  internal: "evidence:read_internal",
  confidential: "evidence:read_confidential",
  restricted: "evidence:read_restricted",
} as const satisfies Record<EvidenceSensitivity, SecurityCapability>;

export function principalCapabilities(
  principal: Principal,
): readonly SecurityCapability[] {
  return [
    ...new Set([
      ...principal.roles.flatMap((role) => capabilitiesByRole[role]),
      ...(principal.capabilities ?? []),
    ]),
  ];
}

export function hasCapability(
  context: SecurityContext,
  capability: SecurityCapability,
): boolean {
  return principalCapabilities(context.principal).includes(capability);
}

export function assertCapability(
  context: SecurityContext,
  capability: SecurityCapability,
): void {
  if (context.principal.tenantId !== context.tenantId) {
    throw new SecurityError(
      "tenant_access_denied",
      `Principal ${context.principal.principalId} belongs to tenant ${context.principal.tenantId}, not request tenant ${context.tenantId}.`,
    );
  }

  if (!hasCapability(context, capability)) {
    throw new SecurityError(
      "capability_denied",
      `Principal ${context.principal.principalId} lacks capability ${capability}.`,
    );
  }
}

export function assertTenantAccess(
  context: SecurityContext,
  runTenantId: string,
): void {
  if (context.tenantId !== runTenantId) {
    throw new SecurityError(
      "tenant_access_denied",
      `Tenant ${context.tenantId} cannot access run owned by tenant ${runTenantId}.`,
    );
  }

  if (context.principal.tenantId !== runTenantId) {
    throw new SecurityError(
      "tenant_access_denied",
      `Principal ${context.principal.principalId} cannot access run owned by tenant ${runTenantId}.`,
    );
  }
}

export function canReadEvidence(
  context: SecurityContext,
  sensitivity: EvidenceSensitivity,
): boolean {
  return hasCapability(context, evidenceCapabilityBySensitivity[sensitivity]);
}

export function assertEvidenceAccess(
  context: SecurityContext,
  sensitivity: EvidenceSensitivity,
): void {
  if (!canReadEvidence(context, sensitivity)) {
    throw new SecurityError(
      "evidence_access_denied",
      `Principal ${context.principal.principalId} cannot read ${sensitivity} evidence.`,
    );
  }
}
