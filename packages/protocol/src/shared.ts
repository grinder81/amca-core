export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export type ISODateTimeString = string;

export type Sha256Hash = `sha256:${string}`;

export type Profile = "light" | "standard" | "critical" | "regulated";

export type Criticality = "low" | "medium" | "high" | "critical";

export type NonEmptyString = string;
