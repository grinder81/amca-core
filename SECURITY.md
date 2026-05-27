# Security Policy

AMCA Core is an alpha framework for proof-gated semantic governance in agentic
systems.

## Reporting Security Issues

Please do not open public issues for suspected vulnerabilities.

Report security issues through GitHub private vulnerability reporting when
available for this repository, or contact the maintainers through the security
contact listed in the repository profile.

## Security Scope

In scope:

- proof or release bypass;
- direct receipt, mutation, approval, or release authority bypass;
- adapter boundary bypass;
- tenant or RBAC isolation bypass;
- secret leakage in telemetry, audit, errors, or provider artifacts;
- replay or eval output being treated as proof;
- current-state freshness bypass.

Out of scope:

- live cloud provider certification unless explicitly configured;
- production deployment hardening for a specific organization;
- third-party service vulnerabilities outside AMCA code;
- misuse of AMCA APIs contrary to documented guardrails.

## Secret Handling

Do not commit provider keys, database URLs, broker credentials, API tokens, or
local run artifacts. Local demo and certification artifacts should remain under
ignored local directories such as `.amca/`.
