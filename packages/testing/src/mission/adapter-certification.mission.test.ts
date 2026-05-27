import { describe, expect, it } from "vitest";

import type { CapabilityContract } from "@amca/capabilities";
import { EffectBrokerError, InMemoryEffectBroker } from "@amca/effect-broker";
import type { EffectAdapter } from "@amca/effect-sdk";
import { LocalRunHarness } from "@amca/harness";
import type { RunEventType } from "@amca/protocol";

import {
  adapterWithCertificationVariation,
  CERTIFIED_ADAPTER_NOW,
  CERTIFIED_ADAPTER_REEVALUATED_AT,
  CERTIFIED_ADAPTER_STARTED_AT,
  certifiedAdapterEventTypes,
  certifiedObservationAdapterFixture,
  certifiedTestResultAdapterFixture,
  uncertifiedEffectAdapter,
} from "../adapter-certification-helpers.js";

describe("Mission adapter certification conformance", () => {
  it("rejects uncertified adapters before broker execution", () => {
    const fixture = certifiedTestResultAdapterFixture({
      runId: "mission_adapter_uncertified_rejected",
    });

    expectBrokerConstructionRejection(() =>
      brokerFor({
        adapter: uncertifiedEffectAdapter(fixture.certifiedAdapter),
        capability: fixture.capability,
      }),
    );
    expect(fixture.calls).toHaveLength(0);
  });

  it.each([
    [
      "capabilityId",
      {
        capabilityId: "mission.adapter_certification.other_capability",
      },
    ],
    [
      "toolId",
      {
        toolId: "mission.adapter_certification.other_tool",
      },
    ],
    [
      "sideEffectClass",
      {
        sideEffectClass: "read",
      },
    ],
  ] as const)(
    "rejects certified adapter %s mismatches before broker execution",
    async (_field, variation) => {
      const fixture = certifiedTestResultAdapterFixture({
        runId: `mission_adapter_${_field}_mismatch`,
      });
      const adapter = adapterWithCertificationVariation(
        fixture.certifiedAdapter,
        variation,
      );

      if (_field === "sideEffectClass") {
        const broker = brokerFor({
          adapter,
          capability: fixture.capability,
        });
        await expectBrokerRejection(broker.dispatch(fixture.command), {
          code: "adapter_certification_mismatch",
        });
      } else {
        expectBrokerConstructionRejection(
          () =>
            brokerFor({
              adapter,
              capability: fixture.capability,
            }),
          { code: "adapter_certification_mismatch" },
        );
      }
      expect(fixture.calls).toHaveLength(0);
    },
  );

  it("rejects receipts and observations not declared by adapter certification", async () => {
    const receiptFixture = certifiedTestResultAdapterFixture({
      runId: "mission_adapter_undeclared_receipt",
    });
    const receiptBroker = brokerFor({
      adapter: adapterWithCertificationVariation(
        receiptFixture.certifiedAdapter,
        {
          declaredReceiptTypes: ["mission.unrelated_receipt"],
        },
      ),
      capability: receiptFixture.capability,
    });

    await expectBrokerRejection(receiptBroker.dispatch(receiptFixture.command));

    const observationFixture = certifiedObservationAdapterFixture({
      runId: "mission_adapter_undeclared_observation",
    });
    const observationBroker = brokerFor({
      adapter: adapterWithCertificationVariation(
        observationFixture.certifiedAdapter,
        {
          declaredObservationTypes: ["mission.unrelated_observation"],
        },
      ),
      capability: observationFixture.capability,
    });

    await expectBrokerRejection(
      observationBroker.dispatch(observationFixture.command),
    );
  });

  it.each([
    [
      "external_read",
      {
        sideEffectClass: "read",
      },
    ],
    [
      "external_write",
      {
        idempotencyKey: "mission-external-write-001",
        sideEffectClass: "idempotent_write",
      },
    ],
  ] as const)(
    "rejects %s certified adapters by default",
    (adapterKind, options) => {
      const fixture = certifiedTestResultAdapterFixture({
        runId: `mission_adapter_${adapterKind}_default_rejected`,
        adapterKind,
        ...options,
      });

      expectBrokerConstructionRejection(
        () =>
          brokerFor({
            adapter: fixture.adapter,
            capability: fixture.capability,
          }),
        { code: "adapter_certification_kind_forbidden" },
      );
      expect(fixture.calls).toHaveLength(0);
    },
  );

  it("rejects certified critical_write adapters before broker execution", () => {
    const fixture = certifiedTestResultAdapterFixture({
      runId: "mission_adapter_critical_write_rejected",
      idempotencyKey: "mission-critical-write-001",
      sideEffectClass: "critical_write",
    });

    expectBrokerConstructionRejection(
      () =>
        brokerFor({
          adapter: fixture.adapter,
          capability: fixture.capability,
        }),
      { code: "critical_write_requires_approval" },
    );
    expect(fixture.calls).toHaveLength(0);
  });

  it("replays and re-evaluates without redispatching certified adapters", async () => {
    const fixture = certifiedTestResultAdapterFixture({
      runId: "mission_adapter_certified_replay_no_redispatch",
    });
    const harness = new LocalRunHarness({
      runId: fixture.command.runId,
      clock: () => CERTIFIED_ADAPTER_NOW,
      brokerOptions: {
        adapters: [fixture.adapter],
        capabilities: [fixture.capability],
        clock: () => CERTIFIED_ADAPTER_NOW,
      },
    });
    harness.startRun({
      occurredAt: CERTIFIED_ADAPTER_STARTED_AT,
      profile: "standard",
    });

    const released = await harness.runToRelease({
      toolCommand: fixture.command,
      finalCandidate: fixture.finalCandidate,
      options: {
        finalCandidate: {
          generatedAt: CERTIFIED_ADAPTER_NOW,
          occurredAt: CERTIFIED_ADAPTER_NOW,
        },
      },
    });
    const beforeReplay = eventTypes(harness);

    expect(released.finalCandidate.decision.status).toBe("released");
    expect(harness.replay().events.map((event) => event.type)).toEqual(
      beforeReplay,
    );
    expect(fixture.calls).toHaveLength(1);

    const reevaluated = harness.reevaluateFinalCandidate(
      fixture.finalCandidate,
      {
        generatedAt: CERTIFIED_ADAPTER_REEVALUATED_AT,
        occurredAt: CERTIFIED_ADAPTER_REEVALUATED_AT,
      },
    );

    expect(reevaluated.decision.status).toBe("released");
    expect(fixture.calls).toHaveLength(1);
    expect(countEvents(harness, "EffectRequested")).toBe(1);
    expect(countEvents(harness, "EffectReceiptRecorded")).toBe(1);
  });
});

function brokerFor(input: {
  readonly adapter: EffectAdapter;
  readonly capability: CapabilityContract;
}): InMemoryEffectBroker {
  return new InMemoryEffectBroker({
    adapters: [input.adapter],
    capabilities: [input.capability],
    clock: () => CERTIFIED_ADAPTER_NOW,
  });
}

async function expectBrokerRejection(
  promise: Promise<unknown>,
  options: { readonly code?: EffectBrokerError["code"] } = {},
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "EffectBrokerError",
    ...(options.code === undefined ? {} : { code: options.code }),
  });
}

function expectBrokerConstructionRejection(
  callback: () => unknown,
  options: { readonly code?: EffectBrokerError["code"] } = {},
): void {
  expect(callback).toThrow(EffectBrokerError);
  try {
    callback();
  } catch (error) {
    expect(error).toMatchObject({
      name: "EffectBrokerError",
      ...(options.code === undefined ? {} : { code: options.code }),
    });
  }
}

function eventTypes(harness: LocalRunHarness): RunEventType[] {
  return certifiedAdapterEventTypes({
    events: () => harness.kernel.events(),
  });
}

function countEvents(harness: LocalRunHarness, type: RunEventType): number {
  return eventTypes(harness).filter((eventType) => eventType === type).length;
}
