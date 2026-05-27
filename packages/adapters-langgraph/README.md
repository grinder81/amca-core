# @amca/adapters-langgraph

Governed runtime bridge for LangGraph-shaped AMCA boundary output.

## Maturity

This package may invoke deterministic LangGraph graphs whose output is already
shaped for the AMCA proposal boundary. It translates graph-emitted
tool-call-shaped inputs into `ToolCommandRequest` proposals and structured final
outputs into `FinalCandidate` proposals.

It is not a model-calling or tool-executing LangGraph bridge and is not a proof,
receipt, ledger, or release authority.

## Boundaries

- May accept LangGraph-shaped tool-call and final-candidate inputs as
  execution-local proposal data.
- May depend on the official `@langchain/langgraph` package for deterministic
  proposal-boundary graph invocation.
- May expose a Level 2 tool-intercepting bridge only for graph-emitted proposal
  conversion.
- Must not emit receipts, release decisions, proof verdicts, or governed tool
  execution.
- Must not treat LangGraph checkpoint or state as AMCA evidence or truth.
