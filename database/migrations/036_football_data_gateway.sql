CREATE TABLE IF NOT EXISTS api_provider_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(80) NOT NULL,
  date_utc date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  endpoint varchar(160) NOT NULL,
  minute_bucket timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  requests_used integer NOT NULL DEFAULT 0,
  requests_limit integer NOT NULL DEFAULT 100,
  rate_limit_per_minute integer NOT NULL DEFAULT 10,
  last_request_at timestamptz,
  status varchar(40) NOT NULL DEFAULT 'OK',
  raw_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, date_utc, endpoint, minute_bucket)
);

CREATE INDEX IF NOT EXISTS idx_api_provider_usage_provider_date
  ON api_provider_usage(provider, date_utc, endpoint);

CREATE TABLE IF NOT EXISTS api_response_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(80) NOT NULL,
  endpoint varchar(160) NOT NULL,
  params_hash varchar(80) NOT NULL,
  cache_key varchar(260) NOT NULL,
  response_json jsonb NOT NULL,
  source_confidence_score numeric(6,3) NOT NULL DEFAULT 0.750,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, cache_key),
  CHECK (source_confidence_score >= 0 AND source_confidence_score <= 1)
);

CREATE INDEX IF NOT EXISTS idx_api_response_cache_valid
  ON api_response_cache(provider, endpoint, expires_at DESC);

CREATE TABLE IF NOT EXISTS football_source_consensus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid REFERENCES matches(id) ON DELETE CASCADE,
  league_id varchar(100) NOT NULL,
  home_team varchar(160) NOT NULL,
  away_team varchar(160) NOT NULL,
  kickoff timestamptz,
  sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  consensus_verified boolean NOT NULL DEFAULT false,
  consensus_score numeric(6,3) NOT NULL DEFAULT 0,
  missing_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation varchar(160) NOT NULL DEFAULT 'SOURCE_CONSENSUS_REQUIRED',
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id),
  CHECK (consensus_score >= 0 AND consensus_score <= 1)
);

CREATE INDEX IF NOT EXISTS idx_football_source_consensus_league
  ON football_source_consensus(league_id, consensus_verified, observed_at DESC);
