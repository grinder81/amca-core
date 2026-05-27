import { describe, expect, it } from "vitest";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cliSourceDir = path.join(repoRoot, "packages/cli/src");
const lowerAuthoritySourceDirs = [
  "packages/protocol/src",
  "packages/contracts/src",
  "packages/proof/src",
  "packages/effect-broker/src",
  "packages/kernel/src",
  "packages/replay/src",
].map((relativePath) => path.join(repoRoot, relativePath));

describe("Mission CLI governed harness litmus", () => {
  it("keeps CLI orchestration out of lower-level authority packages", () => {
    for (const sourceFile of sourceFiles(lowerAuthoritySourceDirs)) {
      const source = readFileSync(sourceFile, "utf8");
      expect(
        source,
        `${sourceFile} must not import CLI presentation authority.`,
      ).not.toMatch(amcaImportPattern("@amca/cli"));
      expect(
        source,
        `${sourceFile} must not import governed harness orchestration.`,
      ).not.toMatch(amcaImportPattern("@amca/harness"));
    }
  });

  it("allows CLI to invoke harness without importing broker, effect, or proof authority directly", () => {
    const cliSource = sourceBundle([cliSourceDir]);

    expect(cliSource).not.toMatch(amcaImportPattern("@amca/effect-broker"));
    expect(cliSource).not.toMatch(amcaImportPattern("@amca/effect-sdk"));
    expect(cliSource).not.toMatch(amcaImportPattern("@amca/proof"));
  });

  it("keeps Phase 15 CLI governed runs free of real execution hooks", () => {
    const cliSource = sourceBundle([cliSourceDir]);
    const forbiddenExecutionPattern =
      /(?:node:child_process|child_process|execFile\s*\(|exec\s*\(|spawn\s*\(|fetch\s*\(|@octokit|undici|axios|node:https|node:http)/u;

    expect(cliSource).not.toMatch(forbiddenExecutionPattern);
  });

  it("requires CLI release artifacts to come from kernel proof and release events", () => {
    const cliSource = sourceBundle([cliSourceDir]);

    expect(cliSource).toContain('lastEventOfType(events, "ProofGenerated")');
    expect(cliSource).toContain('lastEventOfType(events, "ReleaseDecided")');
    expect(cliSource).toContain("cannot be serialized without a proof event");
    expect(cliSource).toContain(
      "cannot be serialized without a release decision event",
    );
    expect(cliSource).not.toMatch(
      /finalDecision\s*=\s*\{[^}]*status:\s*["']released["']/u,
    );
    expect(cliSource).not.toMatch(
      /proof\s*=\s*\{[^}]*verdict:\s*["']pass["']/u,
    );
  });

  it("replays from admitted events instead of redispatching adapters", () => {
    const cliSource = sourceBundle([cliSourceDir]);
    const replaySource = optionalFunctionSource(cliSource, "replayArtifacts");

    expect(replaySource).toContain("replayRunEvents");
    expect(replaySource).not.toMatch(
      /\.dispatch(?:ToolCommand)?\s*\(|\.runToRelease\s*\(|\.execute\s*\(|new InMemoryEffectBroker/u,
    );
  });

  it("does not let local artifact decisions substitute for kernel re-evaluation", () => {
    const cliSource = sourceBundle([cliSourceDir]);
    const replaySource = optionalFunctionSource(cliSource, "replayArtifacts");
    const replayPackageSource = sourceBundle([
      path.join(repoRoot, "packages/replay/src"),
    ]);

    expect(replaySource).toContain("replayArtifactsResult(replay)");
    expect(replayPackageSource).toContain("new InMemoryRunKernel");
    expect(replayPackageSource).toContain("kernel.submitFinalCandidate");
    expect(replayPackageSource).toContain("parseEffectReceipt");
    expect(replayPackageSource).toContain("recordEffectReceipt");
    expect(replayPackageSource).toContain("replayDivergenceNotes");
  });
});

function sourceFiles(directories: readonly string[]): string[] {
  return directories
    .filter((directory) => existsSync(directory))
    .flatMap((directory) =>
      readdirSync(directory).flatMap((entry) => {
        const entryPath = path.join(directory, entry);
        const entryStat = statSync(entryPath);

        if (entryStat.isDirectory()) {
          return sourceFiles([entryPath]);
        }

        if (!entryStat.isFile() || entryPath.endsWith(".test.ts")) {
          return [];
        }

        return [entryPath];
      }),
    )
    .sort();
}

function sourceBundle(directories: readonly string[]): string {
  return sourceFiles(directories)
    .map((sourceFile) => readFileSync(sourceFile, "utf8"))
    .join("\n");
}

function amcaImportPattern(packageName: string): RegExp {
  const escapedPackageName = packageName.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );

  return new RegExp(
    `(?:from\\s+["']${escapedPackageName}(?:/[^"']*)?["']|import\\s+["']${escapedPackageName}(?:/[^"']*)?["']|import\\s*\\(\\s*["']${escapedPackageName}(?:/[^"']*)?["'])`,
    "u",
  );
}

function optionalFunctionSource(source: string, functionName: string): string {
  const marker = `function ${functionName}(`;
  const functionStart = source.indexOf(marker);
  if (functionStart < 0) {
    return "";
  }

  const nextFunctionStart = source.indexOf("\nfunction ", functionStart + 1);
  return source.slice(
    functionStart,
    nextFunctionStart < 0 ? source.length : nextFunctionStart,
  );
}
