import { hashRunEventPayload } from "@amca/kernel";
import { rebuildRunProjection } from "@amca/projections";
import type { RunEvent } from "@amca/protocol";
import { describe, expect, it } from "vitest";

import { submitReleasedTestClaim } from "./mission-helpers.js";

describe("Mission projection truth boundary litmus", () => {
  it("builds read models from accepted semantic events without owning release authority", () => {
    const { kernel } = submitReleasedTestClaim(
      "mission_projection_read_model_only",
    );

    const projection = rebuildRunProjection(kernel.events());

    expect(projection.summary.status).toBe("released");
    expect(projection.releaseDecision?.status).toBe("released");
    expect(projection.finalReleased).toBe(true);
    expect(projection.proofs).toHaveLength(1);
  });

  it("does not fabricate proof or release state when events are absent", () => {
    const { kernel } = submitReleasedTestClaim(
      "mission_projection_no_fabrication",
    );
    const eventsBeforeFinal = kernel
      .events()
      .filter((event) => event.type !== "ProofGenerated")
      .filter((event) => event.type !== "MismatchDetected")
      .filter((event) => event.type !== "ReleaseDecided")
      .filter((event) => event.type !== "FinalReleased");

    const projection = rebuildRunProjection(eventsBeforeFinal);

    expect(projection.proofs).toEqual([]);
    expect(projection.mismatches).toEqual([]);
    expect(projection.releaseDecision).toBeUndefined();
    expect(projection.finalReleased).toBe(false);
    expect(projection.summary.status).toBe("running");
  });

  it("fails closed when projection input events are reordered or mutated", () => {
    const { kernel } = submitReleasedTestClaim(
      "mission_projection_integrity_closed",
    );
    const events = kernel.events();
    const reordered = [events[1], events[0], ...events.slice(2)].filter(
      (event): event is RunEvent => event !== undefined,
    );
    const mutated = events.map((event, index) =>
      index === 1
        ? {
            ...event,
            payloadHash: hashRunEventPayload({ forged: true }),
          }
        : event,
    );

    expect(() => rebuildRunProjection(reordered)).toThrow();
    expect(() => rebuildRunProjection(mutated)).toThrow();
  });
});
