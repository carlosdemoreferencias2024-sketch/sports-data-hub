export type ManualVerifiedSource = {
  source_name: string;
  allowed_mode: "manual_verified";
  auto_scrape_allowed: false;
  requires_source_url: true;
  requires_captured_at: true;
  requires_verified_by: true;
  default_confidence_score: number;
  legal_note: string;
};

const LEGAL_NOTE = "manual verification only; no automated scraping without permission";

export const MANUAL_VERIFIED_SOURCES: ManualVerifiedSource[] = [
  "365scores_manual_verified",
  "flashscore_manual_verified",
  "official_club_manual_verified",
  "official_league_manual_verified",
  "espn_manual_verified",
  "foxsports_manual_verified",
  "google_result_manual_verified",
  "sportsbook_manual_verified",
  "bookmaker_manual_verified",
  "sportsdataio_manual_verified",
  "mlb_official_manual_verified",
  "mlb_stats_manual_verified",
  "nfl_official_manual_verified",
  "nfl_inactives_manual_verified",
  "weather_manual_verified"
].map((sourceName) => ({
  source_name: sourceName,
  allowed_mode: "manual_verified",
  auto_scrape_allowed: false,
  requires_source_url: true,
  requires_captured_at: true,
  requires_verified_by: true,
  default_confidence_score: sourceName.includes("official") || sourceName.includes("mlb_stats") || sourceName.includes("mlb_official") ? 90 : 85,
  legal_note: LEGAL_NOTE
}));

const SOURCE_BY_NAME = new Map(MANUAL_VERIFIED_SOURCES.map((source) => [source.source_name, source]));

export function getManualVerifiedSource(sourceName: string) {
  return SOURCE_BY_NAME.get(sourceName);
}

export function getManualVerifiedSourceRegistry() {
  return {
    system_status: "SOURCE_REGISTRY_SAFE_V1",
    persistence_mode: "READ_ONLY",
    sources: MANUAL_VERIFIED_SOURCES,
    allowed_modes: ["manual_verified"],
    auto_scrape_allowed: false,
    blocked_modes: ["scraping", "crawler", "hidden_api", "selenium_automation", "login_bypass"],
    legal_note: LEGAL_NOTE,
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
