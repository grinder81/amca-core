# @amca/provider-harness

OpenAI-compatible local provider harness for AMCA proposal candidates.

This package is for Phase 62 local LLM/provider certification. It can build
OpenAI-compatible chat-completions requests, parse local provider responses, and
convert structured provider output or tool-call-shaped output into AMCA proposal
boundary objects.

Maturity boundary:

- proposal-boundary implementation exists;
- live provider certification is pending until explicitly run against the local
  provider;
- provider output is not proof evidence;
- provider traces and metadata are not proof evidence;
- provider tool calls are converted to `ToolCommandRequest` proposals only;
- this package does not execute tools;
- this package does not admit receipts;
- this package does not issue proof objects or release decisions.

The live test is gated behind `AMCA_PROVIDER_LIVE=1` and required endpoint/model
environment variables. Normal unit and mission tests do not call a local model.
