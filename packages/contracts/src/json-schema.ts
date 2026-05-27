import { z } from "zod";

import { V0ProtocolSchemas } from "./schemas.js";

export type ContractSchemaName = keyof typeof V0ProtocolSchemas;
export type JsonSchemaDocument = Record<string, unknown>;

export function toContractJsonSchema(
  schemaName: ContractSchemaName,
): JsonSchemaDocument {
  return z.toJSONSchema(V0ProtocolSchemas[schemaName], {
    io: "input",
    target: "draft-7",
  });
}

export function generateV0JsonSchemas(): Record<
  ContractSchemaName,
  JsonSchemaDocument
> {
  return Object.fromEntries(
    Object.keys(V0ProtocolSchemas).map((schemaName) => [
      schemaName,
      toContractJsonSchema(schemaName as ContractSchemaName),
    ]),
  ) as Record<ContractSchemaName, JsonSchemaDocument>;
}
