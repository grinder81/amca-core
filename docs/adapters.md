# Adapters

Adapters connect AMCA to execution substrates, tools, providers, and external
systems. They are mechanisms, not truth authorities.

## Certification Boundaries

Adapter packages declare machine-readable certification manifests. A manifest
states the adapter kind, current level, target level, allowed authority,
forbidden authority, and evidence paths.

The public repository includes source and tests for these manifests. Live
production certification for any specific environment requires separate operator
approval and configured credentials.

## Adapters Conformance

`@amca/adapters-conformance` validates substrate emissions and certification
manifests.

## LangGraph Boundary Adapter

`@amca/adapters-langgraph` is a boundary adapter for LangGraph-shaped runtime
outputs. LangGraph state is execution-local metadata unless converted into AMCA
semantic events.

## Temporal Boundary Adapter

`@amca/adapters-temporal` is a boundary adapter for Temporal-shaped workflow and
activity data. Temporal history is operational metadata, not AMCA proof.

## Tool Adapters

`@amca/adapters-tools` contains governed tool adapter primitives. Read, write,
shell, HTTP, and GitHub behavior must stay within the package's declared
capability profiles and AMCA admission path.
