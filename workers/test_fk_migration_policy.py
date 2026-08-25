from fk_migration_policy import FK_POLICY, FKPolicy, RepairScope, may_remap, policy_counts


EXPECTED_REFERENCES = {
    "public.alpha_opportunities.match_id",
    "public.football_player_intelligence.match_id",
    "public.football_source_consensus.match_id",
    "public.football_team_intelligence.match_id",
    "public.forecast_matches.match_id",
    "public.intelligence_observations.match_id",
    "public.market_quotes.match_id",
    "public.match_competitors.match_id",
    "public.match_statistics.match_id",
    "public.model_features.match_id",
    "public.model_quotes.match_id",
    "public.odds_snapshots.match_id",
    "public.paper_trades.match_id",
    "public.player_intelligence.match_id",
    "public.provider_event_mappings.hub_match_id",
    "public.real_paper_snapshots.event_id",
    "public.real_paper_snapshots.match_id",
    "public.source_match_refs.match_id",
    "public.team_stat_snapshots.match_id",
}


def test_policy_covers_the_19_catalog_relationships() -> None:
    assert set(FK_POLICY) == EXPECTED_REFERENCES


def test_legacy_source_collision_never_remaps_foreign_keys() -> None:
    assert all(
        not may_remap(reference, RepairScope.LEGACY_SOURCE_COLLISION)
        for reference in FK_POLICY
    )


def test_audit_and_settlement_records_are_immutable() -> None:
    immutable = {
        "public.forecast_matches.match_id",
        "public.market_quotes.match_id",
        "public.match_statistics.match_id",
        "public.model_features.match_id",
        "public.model_quotes.match_id",
        "public.odds_snapshots.match_id",
        "public.paper_trades.match_id",
        "public.real_paper_snapshots.event_id",
        "public.real_paper_snapshots.match_id",
    }
    assert all(FK_POLICY[reference].policy is FKPolicy.NO_TOCAR for reference in immutable)


def test_merge_rules_name_their_collision_indexes() -> None:
    merge_rules = [rule for rule in FK_POLICY.values() if rule.policy is FKPolicy.REMAP_CON_MERGE]
    assert merge_rules
    assert all(rule.collision_indexes for rule in merge_rules)


def test_policy_count_is_complete() -> None:
    assert policy_counts() == {
        "REMAP_LIBRE": 6,
        "REMAP_CON_MERGE": 3,
        "NO_TOCAR": 10,
    }
