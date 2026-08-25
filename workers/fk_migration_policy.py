"""Explicit policy for every direct foreign key to ``public.matches``.

The matrix is intentionally conservative. A policy describes what could be
done for a verified same-event identity correction; it does not authorize an
operation by itself. Legacy source-ID collisions are a different repair scope
and are forbidden from remapping any foreign key.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class FKPolicy(str, Enum):
    REMAP_LIBRE = "REMAP_LIBRE"
    REMAP_CON_MERGE = "REMAP_CON_MERGE"
    NO_TOCAR = "NO_TOCAR"


class RepairScope(str, Enum):
    SAME_EVENT_IDENTITY_CORRECTION = "SAME_EVENT_IDENTITY_CORRECTION"
    LEGACY_SOURCE_COLLISION = "LEGACY_SOURCE_COLLISION"


@dataclass(frozen=True)
class FKMigrationRule:
    table: str
    column: str
    policy: FKPolicy
    reason: str
    collision_indexes: tuple[str, ...] = ()

    @property
    def reference(self) -> str:
        return f"public.{self.table}.{self.column}"


def _rule(
    table: str,
    column: str,
    policy: FKPolicy,
    reason: str,
    *collision_indexes: str,
) -> FKMigrationRule:
    return FKMigrationRule(table, column, policy, reason, collision_indexes)


_RULES = (
    _rule("alpha_opportunities", "match_id", FKPolicy.NO_TOCAR,
          "Decision record also bound to model_quote_id and market_quote_id."),
    _rule("football_player_intelligence", "match_id", FKPolicy.REMAP_LIBRE,
          "Timestamped context can follow a verified same-event identity correction."),
    _rule("football_source_consensus", "match_id", FKPolicy.REMAP_CON_MERGE,
          "One consensus row per match.", "football_source_consensus_match_id_key"),
    _rule("football_team_intelligence", "match_id", FKPolicy.REMAP_LIBRE,
          "Timestamped context can follow a verified same-event identity correction."),
    _rule("forecast_matches", "match_id", FKPolicy.NO_TOCAR,
          "Append-only forecast-chain anchor with ON DELETE RESTRICT."),
    _rule("intelligence_observations", "match_id", FKPolicy.REMAP_LIBRE,
          "Source observation can follow a verified same-event identity correction."),
    _rule("market_quotes", "match_id", FKPolicy.NO_TOCAR,
          "Timestamped bookmaker evidence used by decisions and settlement."),
    _rule("match_competitors", "match_id", FKPolicy.REMAP_CON_MERGE,
          "Structural rows collide by side or team.",
          "match_competitors_match_id_home_away_key",
          "match_competitors_match_id_team_id_key"),
    _rule("match_statistics", "match_id", FKPolicy.NO_TOCAR,
          "Result/source snapshot may already support settlement."),
    _rule("model_features", "match_id", FKPolicy.NO_TOCAR,
          "Model input artifact may be referenced by the immutable forecast chain."),
    _rule("model_quotes", "match_id", FKPolicy.NO_TOCAR,
          "Model output artifact may be referenced by the immutable forecast chain."),
    _rule("odds_snapshots", "match_id", FKPolicy.NO_TOCAR,
          "Formal entry/closing evidence can contain evidence_id and SHA-256."),
    _rule("paper_trades", "match_id", FKPolicy.NO_TOCAR,
          "Paper execution and settlement ledger.", "uq_paper_trades_market_signal"),
    _rule("player_intelligence", "match_id", FKPolicy.REMAP_LIBRE,
          "Timestamped source context can follow a verified same-event correction."),
    _rule("provider_event_mappings", "hub_match_id", FKPolicy.REMAP_LIBRE,
          "Provider identity link; unique key does not include hub_match_id."),
    _rule("real_paper_snapshots", "match_id", FKPolicy.NO_TOCAR,
          "Execution, CLV and settlement ledger with open-exposure uniqueness."),
    _rule("real_paper_snapshots", "event_id", FKPolicy.NO_TOCAR,
          "Execution event identity is part of the settlement record."),
    _rule("source_match_refs", "match_id", FKPolicy.REMAP_LIBRE,
          "Canonical source identity link; unique key does not include match_id."),
    _rule("team_stat_snapshots", "match_id", FKPolicy.REMAP_CON_MERGE,
          "One snapshot row per match and team.", "team_stat_snapshots_match_id_team_id_key"),
)

FK_POLICY: dict[str, FKMigrationRule] = {rule.reference: rule for rule in _RULES}


def may_remap(reference: str, scope: RepairScope) -> bool:
    """Return whether a policy permits a remap in the requested repair scope."""
    rule = FK_POLICY[reference]
    if scope is RepairScope.LEGACY_SOURCE_COLLISION:
        return False
    return rule.policy is not FKPolicy.NO_TOCAR


def policy_counts() -> dict[str, int]:
    return {
        policy.value: sum(rule.policy is policy for rule in FK_POLICY.values())
        for policy in FKPolicy
    }
