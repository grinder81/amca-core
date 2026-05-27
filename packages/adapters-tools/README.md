# @amca/adapters-tools

Deterministic local tool adapters for AMCA-governed effect lifecycles.

## Maturity boundary

This package is not a general tool runtime and not a production external write
broker. The `local_readonly` adapter is certified only for opt-in local file
reads under a configured root.

The `local_readonly` adapter:

- declares `adapterKind: "local_readonly"`;
- declares `sideEffectClass: "read"`;
- declares `idempotency: "not_required"`;
- rejects absolute paths, traversal, symlink escapes, directories, missing
  files, default dotfile paths, and oversized files;
- returns content hashes and metadata only;
- does not expose raw file content in receipts, evidence, observations, logs, or
  release text;
- marks evidence with `adapter_pending_kernel_admission` until the kernel or
  harness admits it through an AMCA event.

The adapter must not admit receipts directly, generate proof objects, issue
release decisions, mutate accepted state, call shell commands, call
GitHub/HTTP/API/LLM runtimes, or perform write behavior.

## HTTP read-only observation adapter

The `http_readonly` adapter is a real governed read-only runtime adapter for
HTTP resource observations. It performs only `GET` and `HEAD` through `fetch`
inside the adapter and returns receipt/observation candidates with hash-only
metadata. It does not admit evidence.

The adapter:

- declares `adapterKind: "external_read"`;
- declares `sideEffectClass: "read"`;
- declares `idempotency: "not_required"`;
- allows only `GET` and `HEAD`;
- rejects write methods, non-HTTP schemes, URLs with embedded credentials, and
  query keys or values that obviously carry credentials;
- rejects private or credential-bearing request headers;
- stores only safe header names, never header values;
- follows only safe same-origin redirects and blocks redirects that change host,
  scheme, or target unsafe URLs;
- bounds response reads and rejects oversized responses before emitting
  observation evidence;
- returns status, content hash, byte size, sanitized content type, and redacted
  resource metadata only;
- emits `ReceiptCandidate` and, for successful reads,
  `ExternalStateObservationCandidate` values with pending evidence;
- never includes `sourceEventId` before AMCA kernel or harness admission.

HTTP/API read-only candidate output cannot support proof or release until AMCA
admits it through an `ExternalStateObserved` event.

## Shell command adapter

The `shell` adapter is a real bounded local process adapter for allowlisted
executable profiles. It is not an arbitrary shell runtime and does not execute
prompt-provided command strings.

The adapter:

- declares `adapterKind: "controlled_compute"`;
- declares `sideEffectClass: "compute"`;
- dispatches only configured profiles with absolute executable paths and static
  arguments;
- rejects request-level command, executable, args, cwd, env, stdio, script, and
  `shell` overrides;
- invokes `child_process.spawn` with `shell: false`;
- does not inherit parent process environment and rejects secret-like profile
  environment keys or values;
- enforces per-profile or adapter-level timeout and max-output limits;
- returns exit status, signal, byte counts, output hashes, truncation/timeout
  status, and `redaction: "output_hash_only"`;
- never returns raw stdout, raw stderr, inherited environment values, or command
  output snippets;
- emits only `ReceiptCandidate` values with pending evidence.

Shell adapter output cannot support proof or release until AMCA admits the
candidate through an `EffectReceiptRecorded` event.

## GitHub REST adapter

The `github_rest` adapter is a governed REST adapter for GitHub-shaped HTTP
reads and write candidate execution. Tests use isolated local HTTP fixtures
unless real credentials and live access are explicitly approved.

The adapter:

- declares `adapterKind: "external_read"` for read mode;
- declares `adapterKind: "external_write"` for write mode;
- requires explicit `allowedBaseUrls` so live GitHub access is never the
  default;
- allows only `GET`/`HEAD` in read mode and only write HTTP verbs in write mode;
- blocks URLs outside the allowlist, embedded URL credentials, credential-like
  query strings, and credential-bearing caller headers;
- sends configured tokens only as transport headers and never includes them in
  receipts, observations, evidence candidates, or errors;
- returns response hashes, byte counts, status, and sanitized resource metadata
  only;
- requires broker-visible idempotency for write mode through effect-broker
  preflight;
- treats uncertain write outcomes as broker quarantine triggers;
- never admits receipts, generates proof, or publishes release decisions.
