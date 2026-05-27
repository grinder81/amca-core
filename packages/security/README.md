# @amca/security

Domain-agnostic tenant, RBAC, evidence-redaction, secret-redaction, and audit
export primitives for AMCA service boundaries.

This package is not an authentication provider, identity service, secrets
manager, policy server, or tenancy database. It does not call external systems
and does not decide proof, release, receipt admission, broker dispatch, or
mutation authority.

Audit exports explain accepted AMCA release decisions from semantic events with
redacted evidence and secret fields. Audit exports are review artifacts only:
they are not proof evidence and cannot release claims.
