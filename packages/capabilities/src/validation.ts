import type {
  ContractValidationIssue,
  ContractValidationResult,
} from "@amca/contracts";
import {
  parseContract,
  SideEffectClassSchema,
  validateContract,
} from "@amca/contracts";
import type { SideEffectClass } from "@amca/protocol";

import {
  CapabilityContractSchema,
  CapabilityIdSchema,
  CapabilityJsonSchemaDocumentSchema,
  CapabilityProfileSchema,
} from "./schemas.js";
import type {
  CapabilityContract,
  CapabilityId,
  CapabilityJsonSchemaDocument,
  CapabilityProfile,
} from "./types.js";

export type CapabilityValidationIssue = ContractValidationIssue;

export type CapabilityValidationResult<T> = ContractValidationResult<T>;

export function formatCapabilityValidationIssue(
  issue: CapabilityValidationIssue,
): string {
  const path =
    issue.path.length === 0
      ? "<root>"
      : issue.path.map((segment) => String(segment)).join(".");

  return `${path}: ${issue.message}`;
}

export function validateCapabilityContract(
  input: unknown,
): CapabilityValidationResult<CapabilityContract> {
  return validateContract(CapabilityContractSchema, input);
}

export function parseCapabilityContract(input: unknown): CapabilityContract {
  return parseContract(CapabilityContractSchema, input, "CapabilityContract");
}

export function defineCapability(input: unknown): CapabilityContract {
  return parseCapabilityContract(input);
}

export function validateCapabilityId(
  input: unknown,
): CapabilityValidationResult<CapabilityId> {
  return validateContract(CapabilityIdSchema, input);
}

export function parseCapabilityId(input: unknown): CapabilityId {
  return parseContract(CapabilityIdSchema, input, "CapabilityId");
}

export function validateCapabilityProfile(
  input: unknown,
): CapabilityValidationResult<CapabilityProfile> {
  return validateContract(CapabilityProfileSchema, input);
}

export function parseCapabilityProfile(input: unknown): CapabilityProfile {
  return parseContract(CapabilityProfileSchema, input, "CapabilityProfile");
}

export function validateCapabilitySideEffectClass(
  input: unknown,
): CapabilityValidationResult<SideEffectClass> {
  return validateContract(SideEffectClassSchema, input);
}

export function parseCapabilitySideEffectClass(
  input: unknown,
): SideEffectClass {
  return parseContract(
    SideEffectClassSchema,
    input,
    "CapabilitySideEffectClass",
  );
}

export function validateCapabilityJsonSchemaDocument(
  input: unknown,
): CapabilityValidationResult<CapabilityJsonSchemaDocument> {
  return validateContract(CapabilityJsonSchemaDocumentSchema, input);
}

export function parseCapabilityJsonSchemaDocument(
  input: unknown,
): CapabilityJsonSchemaDocument {
  return parseContract(
    CapabilityJsonSchemaDocumentSchema,
    input,
    "CapabilityJsonSchemaDocument",
  );
}
