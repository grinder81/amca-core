import type { JsonValue } from "@amca/protocol";

export interface RedactionPolicy {
  readonly redactions?: readonly string[];
}

const redactedSecret = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /(?:^|[-_])(authorization|cookie|credential|secret|session|token|password)(?:$|[-_])|api[-_]?key|access[-_]?key|client[-_]?secret|database[-_]?url|private[-_]?key/iu;

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

export function redactOperationalText(
  value: string,
  policy: RedactionPolicy = {},
): string {
  const customRedacted = (policy.redactions ?? []).reduce(
    (current, secret) =>
      secret.length === 0
        ? current
        : current.split(secret).join(redactedSecret),
    value,
  );

  const credentialRedacted = customRedacted.replace(
    URL_WITH_CREDENTIALS_PATTERN,
    `$1${redactedSecret}@`,
  );

  return SENSITIVE_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, redactedSecret),
    credentialRedacted,
  );
}

export function redactOperationalValue(
  value: JsonValue,
  policy: RedactionPolicy = {},
): JsonValue {
  if (typeof value === "string") {
    return redactOperationalText(value, policy);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactOperationalValue(item, policy));
  }

  if (value !== null && typeof value === "object") {
    const redacted: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? redactedSecret
        : redactOperationalValue(child, policy);
    }
    return redacted;
  }

  return value;
}

export function isSensitiveOperationalKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
