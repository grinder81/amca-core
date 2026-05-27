# Getting Started

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Run the gate:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:mission
```

Run the CLI:

```bash
pnpm amca --help
```

Run the local proof/release demo. It does not require a provider, network,
database, or credentials:

```bash
pnpm demo:proof-release
```

The demo writes local ignored artifacts under:

```text
.amca/demo-runs/proof-release/
```

Run the local provider recorder with an OpenAI-compatible local provider:

```bash
AMCA_PROVIDER_LIVE=1 \
AMCA_PROVIDER_BASE_URL=http://localhost:11434/v1 \
AMCA_PROVIDER_MODEL=code \
AMCA_PROVIDER_API_KEY=<local-placeholder> \
pnpm demo:flight-recorder
```

The recorder writes local ignored artifacts under:

```text
.amca/demo-runs/flight-recorder/
```

See [Runnable Demos](runnable-demos.md) for the exact files to inspect.
