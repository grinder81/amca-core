import { describe, expect, it } from "vitest";

import {
  renderBenchmarkMarkdown,
  runDeterministicBenchmark,
} from "./benchmark.js";

describe("runDeterministicBenchmark", () => {
  it("returns a deterministic non-proof benchmark report", () => {
    let calls = 0;
    const result = runDeterministicBenchmark({
      benchmarkId: "bench_eval",
      iterations: 3,
      clock: fixedClock([10, 16]),
      task: () => {
        calls += 1;
      },
    });

    expect(calls).toBe(3);
    expect(result).toEqual({
      kind: "benchmark_result",
      benchmarkId: "bench_eval",
      iterations: 3,
      durationMs: 6,
      averageMs: 2,
      proofUsable: false,
    });
    expect(renderBenchmarkMarkdown(result)).toContain("proofUsable: false");
  });

  it("fails closed for invalid iteration counts and non-monotonic clocks", () => {
    expect(() =>
      runDeterministicBenchmark({
        benchmarkId: "bench_bad_iterations",
        iterations: 0,
        clock: fixedClock([0, 1]),
        task: () => undefined,
      }),
    ).toThrow(/positive integer/u);

    expect(() =>
      runDeterministicBenchmark({
        benchmarkId: "bench_bad_clock",
        iterations: 1,
        clock: fixedClock([10, 9]),
        task: () => undefined,
      }),
    ).toThrow(/monotonic/u);
  });
});

function fixedClock(values: readonly number[]) {
  let index = 0;
  return {
    now: (): number => {
      const value = values[index];
      index += 1;
      if (value === undefined) {
        throw new Error("Clock exhausted.");
      }

      return value;
    },
  };
}
