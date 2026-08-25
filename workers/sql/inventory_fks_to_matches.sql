-- Authoritative inventory of direct foreign keys to public.matches(id).
-- This reports the exact FK columns, actions and every unique index on the
-- child table. Expression and partial indexes are preserved via indexdef.
WITH match_fks AS (
  SELECT
    con.oid AS constraint_oid,
    con.conrelid AS child_table_oid,
    ns.nspname AS schema_name,
    rel.relname AS table_name,
    con.conname AS constraint_name,
    con.conkey AS child_attnums,
    array_agg(child_att.attname ORDER BY child_key.ordinality) AS child_columns,
    array_agg(parent_att.attname ORDER BY child_key.ordinality) AS parent_columns,
    CASE con.confdeltype
      WHEN 'a' THEN 'NO ACTION'
      WHEN 'r' THEN 'RESTRICT'
      WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'
      WHEN 'd' THEN 'SET DEFAULT'
      ELSE con.confdeltype::text
    END AS on_delete,
    CASE con.confupdtype
      WHEN 'a' THEN 'NO ACTION'
      WHEN 'r' THEN 'RESTRICT'
      WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'
      WHEN 'd' THEN 'SET DEFAULT'
      ELSE con.confupdtype::text
    END AS on_update
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY child_key(attnum, ordinality)
  JOIN LATERAL unnest(con.confkey) WITH ORDINALITY parent_key(attnum, ordinality)
    ON parent_key.ordinality = child_key.ordinality
  JOIN pg_attribute child_att
    ON child_att.attrelid = con.conrelid
   AND child_att.attnum = child_key.attnum
  JOIN pg_attribute parent_att
    ON parent_att.attrelid = con.confrelid
   AND parent_att.attnum = parent_key.attnum
  WHERE con.contype = 'f'
    AND con.confrelid = 'public.matches'::regclass
  GROUP BY
    con.oid,
    con.conrelid,
    ns.nspname,
    rel.relname,
    con.conname,
    con.conkey,
    con.confdeltype,
    con.confupdtype
), primary_keys AS (
  SELECT
    con.conrelid AS table_oid,
    array_agg(att.attname ORDER BY key.ordinality) AS columns
  FROM pg_constraint con
  CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY key(attnum, ordinality)
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid
   AND att.attnum = key.attnum
  WHERE con.contype = 'p'
  GROUP BY con.conrelid
)
SELECT
  fk.schema_name,
  fk.table_name,
  fk.constraint_name,
  fk.child_columns,
  fk.parent_columns,
  fk.on_update,
  fk.on_delete,
  pk.columns AS primary_key_columns,
  COALESCE(unique_inventory.unique_indexes, '[]'::jsonb) AS unique_indexes,
  COALESCE(unique_inventory.unique_index_includes_fk, false) AS unique_index_includes_fk
FROM match_fks fk
LEFT JOIN primary_keys pk ON pk.table_oid = fk.child_table_oid
LEFT JOIN LATERAL (
  SELECT
    jsonb_agg(
      jsonb_build_object(
        'name', idx.relname,
        'definition', pg_get_indexdef(idx.oid),
        'partial', index_meta.indpred IS NOT NULL,
        'includes_all_fk_columns', fk.child_attnums <@ ARRAY(
          SELECT key_attnum
          FROM unnest(index_meta.indkey::smallint[]) key_attnum
          WHERE key_attnum > 0
        )
      ) ORDER BY idx.relname
    ) AS unique_indexes,
    bool_or(
      fk.child_attnums <@ ARRAY(
        SELECT key_attnum
        FROM unnest(index_meta.indkey::smallint[]) key_attnum
        WHERE key_attnum > 0
      )
    ) AS unique_index_includes_fk
  FROM pg_index index_meta
  JOIN pg_class idx ON idx.oid = index_meta.indexrelid
  WHERE index_meta.indrelid = fk.child_table_oid
    AND index_meta.indisunique
) unique_inventory ON true
ORDER BY fk.schema_name, fk.table_name, fk.constraint_name;
