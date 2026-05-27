# Package Boundaries

AMCA preserves one-way authority flow through package boundaries.

General rules:

- protocol packages do not import higher layers;
- proof does not import kernel, broker, harness, service, or CLI;
- adapters do not import proof or kernel authority;
- ledger adapters do not import proof, projections, replay, broker, harness, or
  CLI;
- eval, replay, telemetry, and audit outputs are non-proof unless admitted
  through AMCA evidence rules.

Package-boundary tests live in:

```text
packages/testing/src/package-boundaries.test.ts
```
