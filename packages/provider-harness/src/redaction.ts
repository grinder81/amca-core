import type { JsonObject, JsonValue } from "@amca/protocol";

const redactedSecret = "[REDACTED]";

const urlCredentialsPattern =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/giu;

const secretAssignmentPattern =
  /\b(?:api[-_]?key|openai[-_]?api[-_]?key|access[-_]?token|authorization|bearer|client[-_]?secret|credential|database[-_]?url|db[-_]?url|password|secret|session|token)\s*[=:]\s*[^,\s;]+/giu;

const sensitiveValuePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu,
  secretAssignmentPattern,
] as const;

const sensitiveKeyPattern =
  /(?:^|[-_])(authorization|cookie|credential|secret|session|token|password)(?:$|[-_])|api[-_]?key|access[-_]?key|client[-_]?secret|database[-_]?url|private[-_]?key/iu;

export function redactProviderText(value: string): string {
  const credentialRedacted = value.replace(
    urlCredentialsPattern,
    `$1${redactedSecret}@`,
  );

  return sensitiveValuePatterns.reduce(
    (current, pattern) => current.replace(pattern, redactedSecret),
    credentialRedacted,
  );
}

export function redactProviderValue<TValue extends JsonValue>(
  value: TValue,
): TValue {
  if (typeof value === "string") {
    return redactProviderText(value) as TValue;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactProviderValue(item)) as TValue;
  }

  if (value !== null && typeof value === "object") {
    const redacted: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = sensitiveKeyPattern.test(key)
        ? redactedSecret
        : redactProviderValue(child);
    }
    return redacted as TValue;
  }

  return value;
}

export function redactedHeaders(
  headers: Readonly<Record<string, string>>,
): JsonObject {
  const redacted: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = sensitiveKeyPattern.test(key)
      ? redactedSecret
      : redactProviderText(value);
  }
  return redacted;
}
