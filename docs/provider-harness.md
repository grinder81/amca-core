# Provider Harness

The provider harness lets an OpenAI-compatible provider participate in AMCA as a
proposal source.

The provider may emit:

- `ToolCommandRequest` candidates;
- `FinalCandidate` candidates;
- provider metadata marked as non-proof substrate state.

The provider may not emit accepted receipts, admitted evidence, proof objects,
release decisions, mutation commits, approval grants, or final released events.

## Certification Boundary

The public provider harness is a proposal-boundary package. It can be used with
explicitly configured provider access, but production cloud-provider
certification is not claimed by default.

Live provider tests are opt-in and require explicit environment variables.
