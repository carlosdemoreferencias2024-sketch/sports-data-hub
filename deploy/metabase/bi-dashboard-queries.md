# Metabase BI starter dashboards

These native SQL questions were created locally in Metabase under:

- Collection: `Sports Data Hub BI`
- Dashboard: `Trading BI Overview`
- Local URL: `http://127.0.0.1:3001/dashboard/2`

Use database connection:

- Engine: PostgreSQL
- Host: `db-postgres`
- Port: `5432`
- Database: `sports_db`
- User/password: from local `.env`

## MLB Real Paper - CLV by Market

```sql
select
  league_slug,
  market_type,
  count(*) filter (where status in ('WIN','LOSS','PUSH','CLOSED')) as closed,
  round(avg(clv)::numeric, 4) as avg_clv,
  round(sum(coalesce(profit_loss, 0))::numeric, 2) as profit_units,
  round(avg(model_probability)::numeric, 4) as avg_model_probability,
  round(avg(entry_odds)::numeric, 4) as avg_entry_odds
from real_paper_snapshots
where sport_slug = 'baseball'
  and league_slug = 'mlb'
  and status in ('WIN','LOSS','PUSH','CLOSED')
group by league_slug, market_type
order by profit_units desc;
```

## MLB Real Paper - Profit by Odds Range

```sql
select
  case
    when entry_odds < 1.61 then '1.30-1.60'
    when entry_odds < 2.01 then '1.61-2.00'
    else '2.01+'
  end as odds_range,
  count(*) filter (where status in ('WIN','LOSS','PUSH','CLOSED')) as closed,
  count(*) filter (where result = 'WIN' or status = 'WIN') as wins,
  count(*) filter (where result = 'LOSS' or status = 'LOSS') as losses,
  round(avg(clv)::numeric, 4) as avg_clv,
  round(sum(coalesce(profit_loss, 0))::numeric, 2) as profit_units
from real_paper_snapshots
where sport_slug = 'baseball'
  and league_slug = 'mlb'
  and status in ('WIN','LOSS','PUSH','CLOSED')
group by 1
order by 1;
```

## Provider Scorecard - Internal Odds Hub

```sql
select
  provider_name,
  bookmaker,
  sport_slug,
  league_slug,
  market_type,
  count(*) as snapshots,
  round(avg(quality_score)::numeric, 2) as avg_quality_score,
  count(*) filter (where quality_score >= 80) as clean_snapshots,
  max(captured_at) as latest_snapshot
from odds_snapshots
group by provider_name, bookmaker, sport_slug, league_slug, market_type
order by avg_quality_score desc nulls last, snapshots desc;
```

## Football Shadow - Market Performance

```sql
select
  league_slug,
  market_type,
  count(*) filter (where status in ('WIN','LOSS','PUSH','CLOSED')) as closed,
  count(*) filter (where status = 'WIN') as wins,
  count(*) filter (where status = 'LOSS') as losses,
  round(sum(coalesce(net_profit, 0))::numeric, 2) as profit_units,
  round(avg(expected_value)::numeric, 4) as avg_ev,
  round(avg(model_probability)::numeric, 4) as avg_model_probability
from paper_trades
where league_type = 'football'
   or league_slug in ('fifa-world-cup-2026','liga-mx','mls','premier-league','la-liga','serie-a','bundesliga')
group by league_slug, market_type
order by closed desc, profit_units desc;
```

## Open Real Paper Monitor

```sql
select
  sport_slug,
  league_slug,
  market_type,
  status,
  count(*) as count,
  min(entry_timestamp) as oldest_entry,
  max(entry_timestamp) as latest_entry
from real_paper_snapshots
group by sport_slug, league_slug, market_type, status
order by latest_entry desc nulls last;
```
