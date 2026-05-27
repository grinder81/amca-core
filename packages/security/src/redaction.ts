import type {
  EvidenceSensitivity,
  JsonObject,
  JsonValue,
  RunEvent,
} from "@amca/protocol";

import { canReadEvidence } from "./policy.js";
import type { RedactedEvidenceRef, SecurityContext } from "./types.js";

const redactedSecret = "[REDACTED]";

const URL_WITH_CREDENTIALS_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/giu;

const SECRET_HEADER_PATTERN =
  /\b(?:authorization|cookie|x[-_]?api[-_]?key)\s*:\s*[^,\r\n;]+/giu;

const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[-_]?key|openai[-_]?api[-_]?key|aws[-_]?access[-_]?key[-_]?id|aws[-_]?secret[-_]?access[-_]?key|access[-_]?key(?:[-_]?id)?|access[-_]?token|auth|authorization|client[-_]?secret|credential|database[-_]?url|db[-_]?url|password|secret(?:[-_][A-Za-z0-9]+)*|session(?:[-_][A-Za-z0-9]+)*|token(?:[-_][A-Za-z0-9]+)*)\s*[=:]\s*[^,\s;]+/giu;

const SENSITIVE_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  SECRET_HEADER_PATTERN,
  SECRET_ASSIGNMENT_PATTERN,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu,
];

export function redactSecrets<TValue extends JsonValue>(value: TValue): TValue {
  return redactValue(value) as TValue;
}

export function redactRunEvent(
  event: RunEvent,
  context: SecurityContext,
): JsonObject {
  return redactValue(event as unknown as JsonValue, context) as JsonObject;
}

export function redactRunEvents(
  events: readonly RunEvent[],
  context: SecurityContext,
): readonly JsonObject[] {
  return events.map((event) => redactRunEvent(event, context));
}

function redactValue(value: JsonValue, context?: SecurityContext): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, context));
  }

  if (typeof value === "string") {
    return redactSecretText(value);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (context !== undefined && isEvidenceLike(value)) {
    return redactEvidenceLike(value, context) as unknown as JsonValue;
  }

  const redacted: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = isSecretKey(key)
      ? redactedSecret
      : redactValue(child, context);
  }

  return redacted;
}

function redactEvidenceLike(
  value: JsonObject,
  context: SecurityContext,
): JsonObject | RedactedEvidenceRef {
  const sensitivity = value.sensitivity;
  if (!isEvidenceSensitivity(sensitivity)) {
    return value;
  }

  if (!canReadEvidence(context, sensitivity)) {
    const evidenceId =
      typeof value.evidenceId === "string" ? value.evidenceId : "unknown";
    const kind = typeof value.kind === "string" ? value.kind : "unknown";
    return {
      evidenceId,
      kind,
      sensitivity,
      redacted: true,
      reason: "evidence_access_denied",
    };
  }

  const redacted: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = isSecretKey(key)
      ? redactedSecret
      : redactValue(child, context);
  }
  return redacted;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return [
    "accesskey",
    "apikey",
    "authorization",
    "clientsecret",
    "cookie",
    "credential",
    "databaseurl",
    "password",
    "privatekey",
    "secret",
    "session",
    "token",
  ].some((secretFragment) => normalized.includes(secretFragment));
}

function redactSecretText(value: string): string {
  const credentialRedacted = value.replace(
    URL_WITH_CREDENTIALS_PATTERN,
    `$1${redactedSecret}@`,
  );

  return SENSITIVE_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, redactedSecret),
    credentialRedacted,
  );
}

function isEvidenceLike(value: JsonObject): boolean {
  return (
    typeof value.evidenceId === "string" &&
    typeof value.kind === "string" &&
    typeof value.sensitivity === "string" &&
    typeof value.hash === "string"
  );
}

function isEvidenceSensitivity(value: unknown): value is EvidenceSensitivity {
  return (
    value === "public" ||
    value === "internal" ||
    value === "confidential" ||
    value === "restricted"
  );
}
