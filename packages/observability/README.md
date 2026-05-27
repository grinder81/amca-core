# @amca/observability

Redacted operational reporting for AMCA authority events.

This package records metrics, trace spans, and audit entries from accepted AMCA
events. It is intentionally reporting-only:

- It does not admit evidence.
- It does not verify proof.
- It does not issue release decisions.
- It does not execute adapters, tools, services, APIs, or domain workflows.
- Its output is explicitly `proofUsable: false`.

Telemetry may help operate AMCA, but it cannot support a durable claim unless a
future AMCA event separately admits first-class evidence through the normal
evidence path.
