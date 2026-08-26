CREATE UNIQUE INDEX IF NOT EXISTS uq_forecast_context_source_capture
  ON forecast_context_snapshots (
    match_id,
    source_payload_hash,
    captured_at,
    COALESCE(notes, '')
  )
  WHERE source_payload_hash IS NOT NULL;
