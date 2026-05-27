-- AMCA Phase 28: accepted semantic events only.
-- Postgres is durable storage for accepted AMCA RunEvent records. Proof,
-- release, and projection semantics remain outside this adapter.

CREATE TABLE IF NOT EXISTS amca_run_events (
  run_id text NOT NULL,
  event_id text NOT NULL,
  sequence integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  causation_id text,
  correlation_id text,
  occurred_at timestamptz NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amca_run_events_pkey PRIMARY KEY (run_id, event_id),
  CONSTRAINT amca_run_events_sequence_unique UNIQUE (run_id, sequence),
  CONSTRAINT amca_run_events_run_id_non_empty CHECK (length(trim(run_id)) > 0),
  CONSTRAINT amca_run_events_event_id_non_empty CHECK (length(trim(event_id)) > 0),
  CONSTRAINT amca_run_events_sequence_positive CHECK (sequence > 0),
  CONSTRAINT amca_run_events_payload_hash_sha256 CHECK (
    payload_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT amca_run_events_type_non_empty CHECK (length(trim(type)) > 0),
  CONSTRAINT amca_run_events_type_allowed CHECK (
    type IN (
      'RunStarted',
      'ProposalReceived',
      'EffectRequested',
      'WritePreflightRequested',
      'WritePreflightDecided',
      'WriteQuarantined',
      'EffectReceiptRecorded',
      'ExternalStateObserved',
      'ProofGenerated',
      'MismatchDetected',
      'ReleaseDecided',
      'FinalReleased'
    )
  ),
  CONSTRAINT amca_run_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT amca_run_events_causation_id_non_empty CHECK (
    causation_id IS NULL OR length(trim(causation_id)) > 0
  ),
  CONSTRAINT amca_run_events_correlation_id_non_empty CHECK (
    correlation_id IS NULL OR length(trim(correlation_id)) > 0
  ),
  CONSTRAINT amca_run_events_reject_projection_snapshot CHECK (
    NOT (
      payload ? 'projection'
      OR payload ? 'projectionSnapshot'
      OR payload ? 'snapshot'
      OR payload ? 'replay'
      OR payload ? 'benchmark'
      OR payload ? 'eval'
    )
  )
);

CREATE INDEX IF NOT EXISTS amca_run_events_run_sequence_idx
  ON amca_run_events (run_id, sequence);

CREATE OR REPLACE FUNCTION amca_reject_run_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'AMCA run events are append-only; % is not permitted',
    TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS amca_run_events_append_only ON amca_run_events;

CREATE TRIGGER amca_run_events_append_only
  BEFORE UPDATE OR DELETE ON amca_run_events
  FOR EACH ROW
  EXECUTE FUNCTION amca_reject_run_event_mutation();
