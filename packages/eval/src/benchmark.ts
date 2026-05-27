export interface BenchmarkClock {
  now(): number;
}

export interface BenchmarkInput {
  readonly benchmarkId: string;
  readonly iterations: number;
  readonly clock: BenchmarkClock;
  readonly task: () => void;
}

export interface BenchmarkResult {
  readonly kind: "benchmark_result";
  readonly benchmarkId: string;
  readonly iterations: number;
  readonly durationMs: number;
  readonly averageMs: number;
  readonly proofUsable: false;
}

export function runDeterministicBenchmark(
  input: BenchmarkInput,
): BenchmarkResult {
  if (!Number.isInteger(input.iterations) || input.iterations <= 0) {
    throw new Error("Benchmark iterations must be a positive integer.");
  }

  const started = input.clock.now();
  for (let index = 0; index < input.iterations; index += 1) {
    input.task();
  }
  const finished = input.clock.now();
  const durationMs = finished - started;
  if (durationMs < 0) {
    throw new Error("Benchmark clock must be monotonic.");
  }

  return {
    kind: "benchmark_result",
    benchmarkId: input.benchmarkId,
    iterations: input.iterations,
    durationMs,
    averageMs: durationMs / input.iterations,
    proofUsable: false,
  };
}

export function renderBenchmarkMarkdown(result: BenchmarkResult): string {
  return [
    "# AMCA Benchmark Report",
    "",
    `- benchmarkId: ${result.benchmarkId}`,
    `- iterations: ${String(result.iterations)}`,
    `- durationMs: ${String(result.durationMs)}`,
    `- averageMs: ${String(result.averageMs)}`,
    `- proofUsable: ${String(result.proofUsable)}`,
    "",
  ].join("\n");
}
