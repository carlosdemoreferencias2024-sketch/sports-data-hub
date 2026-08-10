export type CanonicalSport = "soccer" | "baseball" | "basketball" | "tennis" | "american_football" | "hockey" | "all" | "unknown";

const SPORT_ALIASES = new Map<string, CanonicalSport>([
  ["all", "all"],
  ["*", "all"],
  ["soccer", "soccer"],
  ["football", "soccer"],
  ["futbol", "soccer"],
  ["fútbol", "soccer"],
  ["association football", "soccer"],
  ["baseball", "baseball"],
  ["mlb", "baseball"],
  ["baseball/mlb", "baseball"],
  ["beisbol", "baseball"],
  ["béisbol", "baseball"],
  ["basketball", "basketball"],
  ["nba", "basketball"],
  ["baloncesto", "basketball"],
  ["tennis", "tennis"],
  ["tenis", "tennis"],
  ["nfl", "american_football"],
  ["american football", "american_football"],
  ["football americano", "american_football"],
  ["hockey", "hockey"],
  ["nhl", "hockey"]
]);

export function normalizeSport(value?: unknown): CanonicalSport {
  const raw = String(value ?? "all").trim().toLowerCase();
  if (!raw) return "all";
  return SPORT_ALIASES.get(raw) ?? "unknown";
}

export function normalizeSportForFilter(value?: unknown): "all" | "soccer" | "baseball" | "basketball" | "tennis" | "american_football" | "hockey" {
  const sport = normalizeSport(value);
  return sport === "unknown" ? "all" : sport;
}

export function sportTaxonomyMap() {
  const rows = Array.from(SPORT_ALIASES.entries())
    .filter(([alias]) => alias !== "*")
    .map(([alias, canonical]) => ({ alias, canonical }));
  return {
    system_status: "SPORT_TAXONOMY_SAFE_V1",
    rows,
    canonical_sports: [...new Set(rows.map((row) => row.canonical))].sort(),
    recommendation: "Usar canonical para conteos; no mezclar soccer/football/futbol ni baseball/mlb."
  };
}
