# Threat Model

AMCA focuses on accidental or adversarial authority leakage in agentic systems.

## Main Risks

- provider prose treated as truth;
- tool output treated as proof before admission;
- substrate traces treated as receipts;
- stale observations used for current-state claims;
- cross-run evidence reuse;
- forged evidence references;
- direct mutation or release bypass;
- telemetry or audit output used as proof;
- secrets leaking through logs, receipts, telemetry, or errors.

## AMCA Responses

- proposal-only provider boundaries;
- strict contracts;
- admitted evidence references;
- deterministic proof;
- release gate;
- side-effect broker;
- ledger-anchored accepted events;
- mission and anti-mission tests;
- secret redaction tests.
