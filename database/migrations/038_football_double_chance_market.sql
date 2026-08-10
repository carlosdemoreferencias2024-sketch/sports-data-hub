-- Add football double chance as a safe Shadow Paper market.
-- It stays unavailable for noisy/manual/friendly competitions and never enables real money.

UPDATE football_competition_registry
SET
  markets_enabled = jsonb_set(
    COALESCE(markets_enabled, '{}'::jsonb),
    '{double_chance}',
    CASE
      WHEN enabled = TRUE
       AND trust_status IN ('TRUSTED', 'WATCH')
       AND COALESCE(manual_only, FALSE) = FALSE
       AND COALESCE(is_friendly, FALSE) = FALSE
      THEN 'true'::jsonb
      ELSE 'false'::jsonb
    END,
    TRUE
  ),
  notes = COALESCE(notes, '') || CASE
    WHEN COALESCE(notes, '') LIKE '%double_chance%' THEN ''
    ELSE ' double_chance enabled for Shadow Paper review where trusted/watch.'
  END,
  updated_at = NOW();
