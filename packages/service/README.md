# @amca/service

In-process service/API boundary for local AMCA workflows.

The package exposes typed handlers for run start, governed tool-command dispatch
through the harness, final-candidate submission through the kernel release path,
run inspection, replay, and audit export. It is not a deployed HTTP service, not
a production API gateway, and not an auth provider.

The service intentionally does not expose direct receipt admission, proof
generation, release decision, final publishing, broker bypass, or adapter
execution authority. Requests that try to issue direct release or receipt
authority are rejected at the service boundary.
