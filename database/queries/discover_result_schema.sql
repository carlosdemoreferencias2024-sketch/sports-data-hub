-- Read-only schema discovery for model backtesting.
SELECT
  c.table_name,
  c.column_name,
  c.data_type
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (
    c.column_name ILIKE '%score%'
    OR c.column_name ILIKE '%result%'
    OR c.column_name ILIKE '%final%'
    OR c.column_name ILIKE '%points%'
    OR c.column_name ILIKE '%goals%'
  )
ORDER BY c.table_name, c.ordinal_position;

SELECT
  tc.table_name AS table_with_fk,
  kcu.column_name AS fk_column,
  ccu.table_name AS referenced_table,
  ccu.column_name AS referenced_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name
 AND kcu.constraint_schema = tc.constraint_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
 AND ccu.constraint_schema = tc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_name ILIKE '%match%'
ORDER BY tc.table_name, kcu.column_name;
