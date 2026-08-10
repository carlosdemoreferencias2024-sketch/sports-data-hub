DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname
  INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'odds_snapshots'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%selection%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE odds_snapshots DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE odds_snapshots
  ADD CONSTRAINT odds_snapshots_selection_check
  CHECK (selection IN ('home', 'away', 'draw', 'over', 'under', 'yes', 'no', 'home_draw', 'home_away', 'draw_away'));
