# AMCA Core

AMCA Core, Agentic Mesh Control Architecture, is a proof-gated semantic
governance kernel for agentic systems.

Agent SDKs help agents act. AMCA governs what agents are allowed to claim.

AMCA turns provider, framework, tool, and adapter output into governed
proposals, admits evidence through typed events, verifies structured claims
deterministically, and releases only supported outputs.

## Why AMCA

Modern agent frameworks make it easy to build systems that can call tools,
coordinate workflows, and produce fluent answers. That is useful, but it leaves
an authority problem:

```text
Did the action really happen?
Was the evidence admitted?
Does it belong to this run?
Is it fresh enough for the claim?
Can the final answer be proven before release?
```

AMCA answers those questions with an explicit governance path:

```text
provider or agent proposes
  -> AMCA validates
  -> broker governs effects
  -> ledger anchors accepted events
  -> proof engine verifies structured claims
  -> release gate publishes only supported outputs
```

## Core Concepts

- **Proposal-only agents**: providers and agent runtimes can propose work or
  final claims, but they do not become proof, receipt, mutation, or release
  authority.
- **Evidence admission**: adapter/tool output is a candidate until AMCA records
  an accepted event and produces an admitted evidence reference.
- **Deterministic proof**: durable claims are checked against structured
  predicates and admitted evidence, not provider prose.
- **Release gate**: final output is published only after proof and release
  decision events.
- **Substrate containment**: LangGraph, Temporal, provider traces, telemetry,
  replay output, eval output, and framework state are not proof by themselves.
- **Anti-mission tests**: tests assert that unsupported claims, forged evidence,
  stale observations, direct receipts, trace-as-proof, and authority smuggling
  fail closed.

## What AMCA Is Not

AMCA Core is not:

- a model provider;
- an agent orchestration framework replacement;
- a production certification for every adapter or cloud provider;
- a financial, medical, legal, or compliance decision engine;
- a license to let models execute writes directly.

AMCA can sit beside systems such as OpenAI Agents SDK, LangGraph, Temporal,
Pydantic AI, or custom agent stacks as the admissibility and release-governance
layer.

## Repository Status

This public repository is an alpha release of the AMCA Core framework.

Some packages include optional adapters or live-integration tests. Those tests
are gated behind explicit environment variables and do not imply production
certification.

## Quick Start

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:mission
```

Run the local CLI:

```bash
pnpm amca --help
```

Run the local provider flight recorder if you have an OpenAI-compatible local
provider available:

```bash
AMCA_PROVIDER_LIVE=1 \
AMCA_PROVIDER_BASE_URL=http://localhost:11434/v1 \
AMCA_PROVIDER_MODEL=code \
AMCA_PROVIDER_API_KEY=<local-placeholder> \
pnpm demo:flight-recorder
```

The recorder writes local artifacts under `.amca/demo-runs/`, which is ignored
by git.

## Packages

- `@amca/protocol`: protocol types for proposals, effects, evidence, proof,
  release, mutation, approval, and events.
- `@amca/contracts`: strict parsers and contract validation.
- `@amca/proof`: deterministic proof rules.
- `@amca/kernel`: run kernel, release gate, and event handling.
- `@amca/effect-broker`: governed effect lifecycle.
- `@amca/harness`: local governed run harness.
- `@amca/ledger`, `@amca/ledger-local`, `@amca/ledger-postgres`: semantic ledger
  interfaces and adapters.
- `@amca/adapters-*`: adapter boundary and conformance packages.
- `@amca/provider-harness`: proposal-boundary provider integration.
- `@amca/security`, `@amca/observability`, `@amca/service`: supporting security,
  telemetry, and local service boundaries.
- `@amca/testing`: mission and anti-mission tests.

## Documentation

- [Architecture](docs/architecture.md)
- [Getting Started](docs/getting-started.md)
- [Core Concepts](docs/concepts.md)
- [Adapters](docs/adapters.md)
- [Provider Harness](docs/provider-harness.md)
- [Ledger](docs/ledger.md)
- [Threat Model](docs/threat-model.md)
- [Anti-Mission Tests](docs/anti-mission-tests.md)
- [Package Boundaries](docs/package-boundaries.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
