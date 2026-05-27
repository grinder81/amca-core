import { z } from "zod";

import { CapabilityContractSchema } from "./schemas.js";

export type CapabilityJsonSchemaExport = Record<string, unknown>;

export function capabilityContractToJsonSchema(): CapabilityJsonSchemaExport {
  return z.toJSONSchema(CapabilityContractSchema, {
    io: "input",
    target: "draft-7",
  });
}
