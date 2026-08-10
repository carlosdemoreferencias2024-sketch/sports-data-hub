import { tradingLocalDate, tradingLocalDateWindow } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type MatchPreflightInput = {
  date?: string;
  sport?: string;
  limit?: number;
  include_backlog?: boolean;
  current_slate_only?: boolean;
  include_legacy?: boolean;
};

type MissingDiagnostic = {
  missing_field: string;
  source_needed: string;
  resolver_module: string;
  blocking_level: "HARD_BLOCK" | "SOFT_BLOCK" | "WAITING_WINDOW" | "SOURCE_MISSING" | "MANUAL_VERIFICATION_NEEDED" | "POST_KICKOFF_TOO_LATE";
  why_stuck: string;
  next_run_window: string;
  data_status: "MISSING" | "STALE" | "EXISTS_NOT_READ" | "MATCH_ID_MISMATCH" | "SOURCE_BLOCKED" | "CAPTURED_TOO_EARLY" | "CAPTURED_LATE" | "WAITING_VALID_WINDOW" | "READY";
  recommended_action: string;
  can_be_manual_verified: boolean;
  can_be_automated: boolean;
  priority: number;
};

function localDate(date?: string) {
  return date || tradingLocalDate();
}

function localDateWindow(date?: string) {
  return tradingLocalDateWindow(date);
}

function normalizeSport(input?: string) {
  const sport = String(input || "all").toLowerCase();
  if (["football", "soccer", "futbol", "fútbol"].includes(sport)) return "soccer";
  if (["baseball", "mlb"].includes(sport)) return "baseball";
  return "all";
}

function isClosedStatus(status: unknown) {
  return ["WIN", "LOSS", "PUSH", "VOID", "SETTLED", "ARCHIVED"].includes(String(status || "").toUpperCase());
}

function isNonPlayable(status: unknown) {
  const value = String(status || "").toLowerCase();
  return value.includes("postpon") || value.includes("cancel") || value.includes("suspend") || value === "void";
}

function isFinalStatus(status: unknown, homeScore: unknown, awayScore: unknown) {
  const value = String(status || "").toLowerCase();
  return value.includes("final") || value.includes("finished") || (
    homeScore !== null && homeScore !== undefined && awayScore !== null && awayScore !== undefined
  );
}

function finalResultStatus(status: unknown) {
  return ["final", "finished", "ft"].includes(String(status || "").trim().toLowerCase());
}

function numberReady(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric);
}

function firstPresent(raw: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key];
    if (value !== null && value !== undefined && String(value).trim() !== "") return value;
  }
  return null;
}

function isAffirmative(value: unknown) {
  return value === true || ["true", "1", "yes", "confirmed", "complete", "present", "ok"].includes(String(value || "").toLowerCase());
}

function hasObjectData(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function hasAny(raw: Record<string, any>, keys: string[]) {
  return keys.some((key) => hasObjectData(raw[key]));
}

function hasCompleteLineup(value: unknown) {
  if (Array.isArray(value)) return value.length >= 11;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length >= 11;
  return false;
}

function hasValidWeatherContext(raw: Record<string, any>) {
  const weather = raw.weather_context;
  if (weather && typeof weather === "object" && !Array.isArray(weather)) {
    const record = weather as Record<string, unknown>;
    if (record.missing_reason || String(record.status || "").toUpperCase() === "MISSING") return false;
    return Object.keys(record).length > 0;
  }
  return hasAny(raw, ["weather", "temperature", "wind_speed", "weather_temp"]);
}

function rawObject(row: Record<string, any>) {
  return row.raw_data && typeof row.raw_data === "object" ? row.raw_data as Record<string, any> : {};
}

function minutesUntilKickoff(kickoff?: unknown, now = new Date()) {
  if (!kickoff) return null;
  const parsed = new Date(String(kickoff));
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.round((parsed.getTime() - now.getTime()) / 60000);
}

function closingDataStatus(minutesUntil: number | null, closingQuality: string) {
  if (closingQuality === "CAPTURED_TOO_EARLY") return "CAPTURED_TOO_EARLY" as const;
  if (closingQuality === "CAPTURED_LATE") return "CAPTURED_LATE" as const;
  if (minutesUntil !== null && minutesUntil < 3) return "CAPTURED_LATE" as const;
  return "WAITING_VALID_WINDOW" as const;
}

function closingBlockingLevel(minutesUntil: number | null) {
  if (minutesUntil !== null && minutesUntil < 3) return "POST_KICKOFF_TOO_LATE" as const;
  return "WAITING_WINDOW" as const;
}

function missingDiagnostic(
  sport: string,
  missingField: string,
  row: Record<string, any>,
  closingReady: boolean,
  closingQuality: string,
  now = new Date()
): MissingDiagnostic {
  const raw = rawObject(row);
  const minutesUntil = minutesUntilKickoff(row.kickoff, now);
  const isBaseball = sport === "baseball";
  const closingWindow = isBaseball ? "10 a 3 min before first pitch" : "10 a 3 min before kickoff";
  const nearStartWindow = isBaseball ? "90 a 20 min before first pitch" : "60 a 30 min before kickoff";
  const defaults: MissingDiagnostic = {
    missing_field: missingField,
    source_needed: "verified source observation",
    resolver_module: "match-data-harvester",
    blocking_level: "SOFT_BLOCK",
    why_stuck: "Preflight did not find a usable verified observation for this field.",
    next_run_window: nearStartWindow,
    data_status: "MISSING",
    recommended_action: "Load a verified observation and rebuild affected preflight rows.",
    can_be_manual_verified: true,
    can_be_automated: false,
    priority: 70
  };

  const byField: Record<string, Partial<MissingDiagnostic>> = {
    odds_model_ev: {
      source_needed: isBaseball ? "verified market odds + MLB model probability" : "verified market quote + owned fair odds/model probability",
      resolver_module: isBaseball ? "MLB odds/model quote bridge" : "football-owned-signals / market-quotes bridge",
      blocking_level: "HARD_BLOCK",
      why_stuck: "No usable odds, model_probability and EV triplet was found.",
      next_run_window: "early slate refresh, then before near-start",
      recommended_action: isBaseball ? "Run MLB odds/model flow before near-start; keep moneyline paper only." : "Run football owned fair odds + market quote bridge with verified odds.",
      can_be_automated: true,
      priority: 15
    },
    entry_verified_evidence: {
      source_needed: "allowed sportsbook source + evidence_id + screenshot_sha256",
      resolver_module: "Source Capture Assistant / odds_snapshot_cache",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Odds/model/EV may exist, but the entry is not a fresh, evidenced pregame snapshot.",
      next_run_window: "before near-start and strictly before kickoff",
      recommended_action: "Capture a fresh entry/current quote with visible evidence; legacy or unaudited quotes stay audit-only.",
      can_be_automated: false,
      priority: 14
    },
    ticket: {
      source_needed: "paper/shadow ticket registry",
      resolver_module: isBaseball ? "MLB real paper snapshot runner" : "football shadow review register",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Signal exists without an auditable paper/shadow ticket.",
      next_run_window: "after EV bridge marks the signal reviewable",
      recommended_action: isBaseball ? "Register MLB paper snapshot only if chain allows paper." : "Run football shadow review register after bridge marks READY_FOR_SHADOW_REVIEW.",
      can_be_automated: true,
      priority: 18
    },
    team_intelligence: {
      source_needed: "football intelligence/context",
      resolver_module: "football-intelligence / match-data-harvester",
      blocking_level: "SOFT_BLOCK",
      why_stuck: "Team context is not visible to this preflight row; it may be missing or not joined from football intelligence tables.",
      data_status: "EXISTS_NOT_READ",
      next_run_window: "24h to 6h before kickoff, refresh near-start if lineup changes",
      recommended_action: "Join/rebuild football intelligence context into the shadow ticket/preflight row.",
      can_be_automated: true,
      priority: 55
    },
    player_intelligence_lineup: {
      source_needed: "official lineup / club / competition / OneFootball / manual_verified",
      resolver_module: "football near-start / match-data-harvester",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Official or verified projected lineup was not attached to the ticket/preflight row.",
      next_run_window: "60 a 30 min before kickoff; official lock 45 a 15 min",
      recommended_action: "Run football near-start; if provider is silent, load manual_verified official lineup only.",
      can_be_automated: true,
      priority: 20
    },
    goalkeeper: {
      source_needed: "official lineup",
      resolver_module: "football near-start",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Starting goalkeeper is not verified.",
      next_run_window: "45 a 15 min before kickoff",
      recommended_action: "Verify official XI and starting goalkeeper before allowing context support.",
      can_be_automated: true,
      priority: 21
    },
    closing_odds_snapshot: {
      source_needed: isBaseball ? "verified market odds" : "verified bookmaker odds",
      resolver_module: isBaseball ? "MLB ForceClosing / closing runner" : "football shadow settlement runner",
      blocking_level: closingBlockingLevel(minutesUntil),
      why_stuck: closingQuality
        ? `Closing exists but quality is ${closingQuality}, not CAPTURED_ON_TIME.${raw.closing_why_invalid ? ` ${raw.closing_why_invalid}` : ""}`
        : "No valid closing snapshot is attached.",
      next_run_window: closingWindow,
      data_status: closingDataStatus(minutesUntil, closingQuality),
      recommended_action: isBaseball ? "Run MLB ForceClosing only inside the 10-to-3-minute window." : "Capture verified bookmaker closing only inside the 10-to-3-minute window.",
      can_be_manual_verified: true,
      can_be_automated: true,
      priority: minutesUntil !== null && minutesUntil < 3 ? 28 : 10
    },
    result: {
      source_needed: isBaseball ? "official final score / MLB Stats API" : "official final score / verified result source",
      resolver_module: isBaseball ? "MLB settlement runner" : "football settlement runner",
      blocking_level: closingReady ? "HARD_BLOCK" : "SOFT_BLOCK",
      why_stuck: closingReady ? "Closing is ready, but final verified result is missing." : "Result should wait until valid closing exists; otherwise settlement/CLV stays blocked.",
      next_run_window: isBaseball ? "after final out" : "after final whistle",
      data_status: minutesUntil !== null && minutesUntil > 0 ? "WAITING_VALID_WINDOW" : "MISSING",
      recommended_action: closingReady ? "Load verified final result, then run settlement." : "Wait for valid closing before settlement; do not force result-only settlement.",
      can_be_manual_verified: true,
      can_be_automated: true,
      priority: closingReady ? 12 : 62
    },
    clv_valid_for_segments: {
      source_needed: "CAPTURED_ON_TIME closing odds + entry odds + settlement result",
      resolver_module: isBaseball ? "MLB closing/settlement + CLV calculator" : "football closing/settlement + segments",
      blocking_level: "SOFT_BLOCK",
      why_stuck: "CLV cannot be trusted until closing quality is CAPTURED_ON_TIME and the ticket has a result.",
      next_run_window: "after valid closing and verified settlement",
      data_status: "WAITING_VALID_WINDOW",
      recommended_action: "Do not count CLV/segments until closing is CAPTURED_ON_TIME and settlement is complete.",
      can_be_manual_verified: false,
      can_be_automated: true,
      priority: 80
    },
    probable_pitcher_home: {
      source_needed: "MLB Stats API",
      resolver_module: "mlb near-start harvester",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Home probable/starting pitcher is missing.",
      next_run_window: "6h to 90m before first pitch; refresh 45 a 20 min",
      recommended_action: "Run scripts\\run_mlb_near_start_context.cmd -Apply during the pitcher refresh window.",
      can_be_automated: true,
      priority: 16
    },
    probable_pitcher_away: {
      source_needed: "MLB Stats API",
      resolver_module: "mlb near-start harvester",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Away probable/starting pitcher is missing.",
      next_run_window: "6h to 90m before first pitch; refresh 45 a 20 min",
      recommended_action: "Run scripts\\run_mlb_near_start_context.cmd -Apply during the pitcher refresh window.",
      can_be_automated: true,
      priority: 16
    },
    home_pitcher_stats: {
      source_needed: "MLB Stats API / model_features",
      resolver_module: "mlb near-start harvester",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Home pitcher stats were not persisted/read in model_features.",
      next_run_window: "6h to 90m before first pitch",
      recommended_action: "Hydrate model_features from MLB Stats API before evaluating paper confirmation.",
      can_be_automated: true,
      priority: 17
    },
    away_pitcher_stats: {
      source_needed: "MLB Stats API / model_features",
      resolver_module: "mlb near-start harvester",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Away pitcher stats were not persisted/read in model_features.",
      next_run_window: "6h to 90m before first pitch",
      recommended_action: "Hydrate model_features from MLB Stats API before evaluating paper confirmation.",
      can_be_automated: true,
      priority: 17
    },
    lineup_batting_order: {
      source_needed: "MLB Stats API / verified lineup source",
      resolver_module: "mlb near-start harvester",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Full MLB lineup and batting-order context are not complete.",
      next_run_window: nearStartWindow,
      recommended_action: "Run MLB near-start context in the 90-to-20-minute window; do not confirm after first pitch.",
      can_be_automated: true,
      priority: 19
    },
    lineup_context: {
      source_needed: "MLB Stats API / verified lineup source",
      resolver_module: "mlb near-start harvester",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Lineup quality/context was not generated into model_features.",
      next_run_window: nearStartWindow,
      recommended_action: "Hydrate lineup quality/context from MLB Stats API or verified lineup source.",
      can_be_automated: true,
      priority: 19
    },
    batting_order_complete: {
      source_needed: "MLB Stats API",
      resolver_module: "mlb near-start harvester",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Batting order is not complete for both teams.",
      next_run_window: "45 a 20 min before first pitch",
      recommended_action: "Refresh official batting orders; require both teams complete.",
      can_be_automated: true,
      priority: 18
    },
    home_lineup: {
      source_needed: "MLB Stats API / verified lineup source",
      resolver_module: "mlb near-start harvester",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Home lineup is not verified.",
      next_run_window: "90 a 20 min before first pitch",
      recommended_action: "Refresh official home lineup via MLB Stats API or verified lineup source.",
      can_be_automated: true,
      priority: 18
    },
    away_lineup: {
      source_needed: "MLB Stats API / verified lineup source",
      resolver_module: "mlb near-start harvester",
      blocking_level: "HARD_BLOCK",
      why_stuck: "Away lineup is not verified.",
      next_run_window: "90 a 20 min before first pitch",
      recommended_action: "Refresh official away lineup via MLB Stats API or verified lineup source.",
      can_be_automated: true,
      priority: 18
    },
    bullpen_context: {
      source_needed: "MLB recent boxscores / bullpen worker",
      resolver_module: "mlb bullpen context",
      blocking_level: "SOFT_BLOCK",
      why_stuck: "Recent bullpen fatigue/usage context is missing.",
      next_run_window: "6h to 30 min before first pitch",
      recommended_action: "Rebuild bullpen fatigue from recent boxscores before closing.",
      can_be_automated: true,
      priority: 35
    },
    park_context: {
      source_needed: "MLB stadium catalog",
      resolver_module: "mlb park-weather-context",
      blocking_level: "SOFT_BLOCK",
      why_stuck: "Static park context is missing from snapshot raw_data.",
      next_run_window: "daily before slate starts",
      recommended_action: "Run MLB park-weather context to attach stadium catalog.",
      can_be_automated: true,
      priority: 50
    },
    weather_context: {
      source_needed: "weather API / manual verified",
      resolver_module: "mlb park-weather-context",
      blocking_level: "SOURCE_MISSING",
      why_stuck: "Park catalog is available, but no verified weather source is configured for game-time conditions.",
      next_run_window: "6h to 30 min before first pitch",
      data_status: "SOURCE_BLOCKED",
      recommended_action: "Configure weather API or load manual_verified game-time weather; park alone is not weather.",
      can_be_manual_verified: true,
      can_be_automated: false,
      priority: 32
    }
  };

  return {
    ...defaults,
    ...(byField[missingField] || {})
  };
}

function computePreflight(row: Record<string, any>, now = new Date()) {
  const raw = rawObject(row);
  const sport = normalizeSport(row.sport);
  const kickoff = row.kickoff ? new Date(row.kickoff) : null;
  const kickoffPassed = !!kickoff && !Number.isNaN(kickoff.getTime()) && kickoff.getTime() <= now.getTime();
  const closingQuality = String(row.closing_quality || raw.closing_quality || "");
  const entryChainReady = isAffirmative(raw.entry_valid)
    || (
      raw.entry_integrity === "ENTRY_VALID"
      && !!raw.entry_evidence_id
      && !!raw.entry_screenshot_sha256
    );
  const closingReady = !!row.closing_odds
    && closingQuality === "CAPTURED_ON_TIME"
    && isAffirmative(raw.closing_safe_for_closing)
    && !!raw.closing_evidence_id
    && !!raw.closing_screenshot_sha256;
  const closingInvalid = !!row.closing_odds && closingQuality !== "CAPTURED_ON_TIME";
  const resultFinal = isFinalStatus(row.match_status, row.home_score, row.away_score)
    || finalResultStatus(raw.result_status)
    || (raw.home_score !== null && raw.home_score !== undefined && raw.away_score !== null && raw.away_score !== undefined);
  const settled = isClosedStatus(row.ticket_status);
  const financialReady = numberReady(row.market_odds)
    && numberReady(row.model_probability)
    && numberReady(row.expected_value)
    && entryChainReady;
  const hasTicket = !!row.paper_trade_id || !!row.real_paper_snapshot_id;
  const footballLineupReady = (hasCompleteLineup(raw.home_lineup) && hasCompleteLineup(raw.away_lineup)) || isAffirmative(raw.lineup_ready);
  const goalkeeperReady = (!!raw.goalkeeper_home && !!raw.goalkeeper_away) || isAffirmative(raw.goalkeeper_ready);
  const mlbPitcherHome = firstPresent(raw, ["probable_pitcher_home", "home_probable_pitcher", "home_starting_pitcher", "probable_home_pitcher"]);
  const mlbPitcherAway = firstPresent(raw, ["probable_pitcher_away", "away_probable_pitcher", "away_starting_pitcher", "probable_away_pitcher"]);
  const mlbHomePitcherStatsReady = hasAny(raw, ["home_pitcher_stats", "home_era", "home_whip", "home_fip", "home_pitcher_recent_starts"]);
  const mlbAwayPitcherStatsReady = hasAny(raw, ["away_pitcher_stats", "away_era", "away_whip", "away_fip", "away_pitcher_recent_starts"]);
  const mlbPitcherReady = !!mlbPitcherHome && !!mlbPitcherAway && mlbHomePitcherStatsReady && mlbAwayPitcherStatsReady;
  const mlbHomeLineupReady = hasObjectData(raw.home_lineup)
    || isAffirmative(raw.home_lineup_confirmed)
    || isAffirmative(raw.home_lineup_status)
    || hasObjectData(raw.home_batting_order);
  const mlbAwayLineupReady = hasObjectData(raw.away_lineup)
    || isAffirmative(raw.away_lineup_confirmed)
    || isAffirmative(raw.away_lineup_status)
    || hasObjectData(raw.away_batting_order);
  const mlbBattingOrderComplete = isAffirmative(raw.batting_order_complete)
    || (isAffirmative(raw.home_batting_order_complete) && isAffirmative(raw.away_batting_order_complete));
  const mlbLineupContextReady = hasAny(raw, ["lineup_context", "home_lineup_ops", "away_lineup_ops", "home_ops", "away_ops"]);
  const mlbLineupReady = mlbHomeLineupReady && mlbAwayLineupReady && mlbBattingOrderComplete && mlbLineupContextReady;
  const mlbBullpenReady = (
    (isAffirmative(raw.home_bullpen_context_fresh) && isAffirmative(raw.away_bullpen_context_fresh))
    || (hasAny(raw, ["home_bullpen_fatigue_score", "home_bullpen_last_72h_innings", "home_bullpen_era", "home_bullpen"])
      && hasAny(raw, ["away_bullpen_fatigue_score", "away_bullpen_last_72h_innings", "away_bullpen_era", "away_bullpen"]))
  );
  const mlbParkReady = hasAny(raw, ["park_context", "park", "ballpark", "venue", "park_factor"]);
  const mlbWeatherReady = hasValidWeatherContext(raw);
  const lineupReady = sport === "baseball" ? mlbLineupReady : footballLineupReady;
  const pitcherReady = sport === "baseball" ? mlbPitcherReady : true;
  const playerContextReady = lineupReady && (sport === "baseball" ? pitcherReady : (goalkeeperReady || raw.goalkeeper_status === "CONFIRMED"));
  const teamContextReady = !!raw.team_context_complete || !!raw.team_context || !!raw.team_intelligence || numberReady(raw.team_context_score);
  const contextReady = sport === "baseball"
    ? Boolean(playerContextReady && mlbBullpenReady && mlbParkReady && mlbWeatherReady)
    : Boolean(teamContextReady && playerContextReady);
  const clvValidForSegments = closingReady && numberReady(row.clv ?? raw.clv);
  const missing: string[] = [];
  const whyYes: string[] = [];
  const whyNo: string[] = [];

  if (row.kickoff) whyYes.push("fixture/kickoff presente");
  else missing.push("kickoff");
  if (financialReady) whyYes.push("entry verificada + odds/modelo/EV presentes");
  else {
    missing.push("odds_model_ev");
    if (!entryChainReady) missing.push("entry_verified_evidence");
  }
  if (hasTicket) whyYes.push("ticket paper/shadow registrado");
  else missing.push("ticket");
  if (sport !== "baseball") {
    if (teamContextReady) whyYes.push("team context presente");
    else missing.push("team_intelligence");
  }
  if (lineupReady) whyYes.push(sport === "baseball" ? "lineup/batting order presente" : "lineup presente");
  else missing.push(sport === "baseball" ? "lineup_batting_order" : "player_intelligence_lineup");
  if (sport === "soccer" && !goalkeeperReady) missing.push("goalkeeper");
  if (sport === "baseball") {
    if (!mlbPitcherHome) missing.push("probable_pitcher_home");
    if (!mlbPitcherAway) missing.push("probable_pitcher_away");
    if (!mlbHomePitcherStatsReady) missing.push("home_pitcher_stats");
    if (!mlbAwayPitcherStatsReady) missing.push("away_pitcher_stats");
    if (!mlbLineupContextReady) missing.push("lineup_context");
    if (!mlbBattingOrderComplete) missing.push("batting_order_complete");
    if (!mlbHomeLineupReady) missing.push("home_lineup");
    if (!mlbAwayLineupReady) missing.push("away_lineup");
    if (!mlbBullpenReady) missing.push("bullpen_context");
    if (!mlbParkReady) missing.push("park_context");
    if (!mlbWeatherReady) missing.push("weather_context");
    if (pitcherReady) whyYes.push("pitchers + pitcher stats presentes");
    if (mlbBullpenReady) whyYes.push("bullpen context presente");
    if (mlbParkReady) whyYes.push("park context presente");
    if (mlbWeatherReady) whyYes.push("weather context presente");
  }
  if (closingReady) whyYes.push("closing valido CAPTURED_ON_TIME");
  else missing.push("closing_odds_snapshot");
  if (resultFinal) whyYes.push("resultado final disponible");
  else missing.push("result");
  if (!clvValidForSegments) missing.push("clv_valid_for_segments");

  let preflightStatus = "OBSERVATION_ONLY";
  let nextAction = "Mantener en observacion; no crear pick.";
  if (isNonPlayable(row.match_status)) {
    preflightStatus = "NO_BET";
    whyNo.push("MATCH_NOT_PLAYABLE");
    nextAction = "No analizar ni liquidar como partido jugado; revisar VOID/ARCHIVE dry-run.";
  } else if (settled) {
    preflightStatus = "SHADOW_SETTLED";
    nextAction = "Revisar CLV/segmentos; no promover sin muestra suficiente.";
  } else if (!financialReady) {
    preflightStatus = "NO_FINANCIAL_BET";
    whyNo.push("Falta cuota real, timestamp, probabilidad del modelo o EV.");
    nextAction = "Cargar market quote verificada y fair odds/model_probability/EV.";
  } else if (sport === "baseball" && !contextReady && !kickoffPassed) {
    preflightStatus = "CONTEXT_GAPS";
    whyNo.push("MLB: EV no basta; faltan pitchers, lineups, batting order, bullpen, park/weather o contexto.");
    nextAction = "Completar probable pitchers, pitcher stats, lineups, batting order, bullpen, park/weather; luego esperar closing.";
  } else if (sport === "soccer" && !contextReady && !kickoffPassed) {
    preflightStatus = "CONTEXT_GAPS";
    whyNo.push("Football: EV no basta; lineup, portero y team/player context son gate duro antes de closing/paper.");
    nextAction = "Completar lineup/portero/bajas con fuente verificada; luego esperar closing valido.";
  } else if (hasTicket && !closingReady) {
    preflightStatus = kickoffPassed ? "POST_KICKOFF_AUDIT_ONLY" : "WAITING_VALID_CLOSING";
    whyNo.push(closingInvalid ? `Closing no valido: ${closingQuality || "UNKNOWN"}` : "Falta closing valido.");
    nextAction = kickoffPassed
      ? "No capturar closing pregame tarde; conservar solo auditoria post-kickoff."
      : "Capturar closing valido en ventana 10 a 3 min antes del kickoff.";
  } else if (closingReady && !resultFinal) {
    preflightStatus = "READY_FOR_SETTLEMENT";
    nextAction = "Esperar marcador final verificado antes de correr settlement.";
  } else if (closingReady && resultFinal && !settled) {
    preflightStatus = "READY_FOR_SETTLEMENT";
    nextAction = "Correr settlement con resultado final verificado.";
  } else if (!contextReady) {
    preflightStatus = "CONTEXT_GAPS";
    whyNo.push("Falta contexto deportivo suficiente.");
    nextAction = sport === "baseball"
      ? "Completar pitchers, lineups, bullpen y travel/rest."
      : "Completar lineup, portero, bajas y team/player context.";
  } else if (financialReady && contextReady && hasTicket) {
    preflightStatus = sport === "baseball" ? "BETTABLE_PAPER" : "READY_FOR_SHADOW_REVIEW";
    nextAction = "Seguir cadena paper; exigir closing/settlement antes de confiar.";
  }

  const confirmedPick = false;
  const realCandidate = false;
  const uniqueMissing = [...new Set(missing)];
  const bottleneckDetails = uniqueMissing.map((field) => missingDiagnostic(sport, field, row, closingReady, closingQuality, now));

  return {
    match_id: row.match_id,
    paper_trade_id: row.paper_trade_id || null,
    real_paper_snapshot_id: row.real_paper_snapshot_id || null,
    match: row.match || `${row.home_team || "Home"} vs ${row.away_team || "Away"}`,
    sport,
    league: row.league,
    kickoff: row.kickoff,
    match_status: row.match_status || "-",
    market: row.market_type || "-",
    pick: row.selection || row.pick || "-",
    entry_odds: row.market_odds ?? null,
    model_probability: row.model_probability ?? null,
    expected_value: row.expected_value ?? null,
    closing_odds: row.closing_odds ?? null,
    closing_quality: closingQuality || null,
    closing_window_start: raw.closing_window_start || null,
    closing_window_end: raw.closing_window_end || null,
    minutes_before_kickoff: raw.minutes_before_kickoff ?? null,
    minutes_from_valid_window: raw.minutes_from_valid_window ?? null,
    closing_why_invalid: raw.closing_why_invalid || null,
    clv: row.clv ?? raw.clv ?? null,
    clv_valid_for_segments: clvValidForSegments,
    ticket_status: row.ticket_status || null,
    preflight_status: preflightStatus,
    financial_ready: financialReady,
    context_ready: contextReady,
    lineup_ready: lineupReady,
    goalkeeper_ready: sport === "soccer" ? goalkeeperReady : null,
    pitcher_ready: sport === "baseball" ? pitcherReady : null,
    pitcher_home: sport === "baseball" ? mlbPitcherHome : null,
    pitcher_away: sport === "baseball" ? mlbPitcherAway : null,
    pitcher_stats_ready: sport === "baseball" ? Boolean(mlbHomePitcherStatsReady && mlbAwayPitcherStatsReady) : null,
    lineup_context_ready: sport === "baseball" ? mlbLineupContextReady : null,
    batting_order_complete: sport === "baseball" ? mlbBattingOrderComplete : null,
    home_lineup_ready: sport === "baseball" ? mlbHomeLineupReady : null,
    away_lineup_ready: sport === "baseball" ? mlbAwayLineupReady : null,
    bullpen_context_ready: sport === "baseball" ? mlbBullpenReady : null,
    weather_context_ready: sport === "baseball" ? mlbWeatherReady : null,
    park_context_ready: sport === "baseball" ? mlbParkReady : null,
    closing_ready: closingReady,
    settlement_ready: closingReady && resultFinal && !settled,
    confirmed_pick: confirmedPick,
    real_candidate: realCandidate,
    missing: uniqueMissing,
    bottleneck_details: bottleneckDetails,
    why_yes: [...new Set(whyYes)].slice(0, 6),
    why_no: [...new Set(whyNo)],
    next_action: nextAction,
    priority: priorityForStatus(preflightStatus, row.kickoff, hasTicket, financialReady)
  };
}

function priorityForStatus(status: string, kickoff: unknown, hasTicket: boolean, financialReady: boolean) {
  const statusWeight: Record<string, number> = {
    READY_FOR_SETTLEMENT: 1,
    WAITING_VALID_CLOSING: 2,
    CONTEXT_GAPS: 3,
    READY_FOR_SHADOW_REVIEW: 4,
    BETTABLE_PAPER: 4,
    NO_FINANCIAL_BET: 6,
    POST_KICKOFF_AUDIT_ONLY: 7,
    SHADOW_SETTLED: 8,
    NO_BET: 9,
    OBSERVATION_ONLY: 10
  };
  const kickoffDate = kickoff ? new Date(String(kickoff)) : null;
  const hoursUntil = kickoffDate && !Number.isNaN(kickoffDate.getTime())
    ? Math.max(-48, Math.min(240, (kickoffDate.getTime() - Date.now()) / 36e5))
    : 240;
  return Number((statusWeight[status] || 20) * 1000 + Math.max(0, hoursUntil) * 10 - (hasTicket ? 100 : 0) - (financialReady ? 50 : 0)).toFixed(2);
}

function summarize(rows: Array<Record<string, any>>) {
  const count = (predicate: (row: Record<string, any>) => boolean) => rows.filter(predicate).length;
  const contextFields = new Set([
    "team_intelligence",
    "player_intelligence_lineup",
    "goalkeeper",
    "lineup_batting_order",
    "lineup_context",
    "batting_order_complete",
    "home_lineup",
    "away_lineup",
    "probable_pitcher_home",
    "probable_pitcher_away",
    "home_pitcher_stats",
    "away_pitcher_stats",
    "bullpen_context",
    "park_context",
    "weather_context"
  ]);
  const lineupFields = new Set([
    "player_intelligence_lineup",
    "goalkeeper",
    "lineup_batting_order",
    "lineup_context",
    "batting_order_complete",
    "home_lineup",
    "away_lineup"
  ]);
  const rowMissing = (row: Record<string, any>) => Array.isArray(row.missing)
    ? row.missing.map((item: unknown) => String(item)).filter(Boolean)
    : [];
  const rowDetails = (row: Record<string, any>) => Array.isArray(row.bottleneck_details)
    ? row.bottleneck_details as Array<Record<string, any>>
    : [];
  const hasMissingField = (row: Record<string, any>, fields: Set<string>) => rowMissing(row).some((field) => fields.has(field))
    || rowDetails(row).some((detail) => fields.has(String(detail.missing_field || "")));
  const hasDetailStatus = (row: Record<string, any>, statuses: string[]) => {
    const normalizedStatuses = new Set(statuses.map((status) => status.toUpperCase()));
    return rowDetails(row).some((detail) => normalizedStatuses.has(String(detail.data_status || detail.blocking_level || "").toUpperCase()));
  };
  const byStatus = rows.reduce<Record<string, number>>((acc, row) => {
    const status = String(row.preflight_status || "UNKNOWN");
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const contextGapsTotal = count((row) => hasMissingField(row, contextFields));
  return {
    scanned: rows.length,
    financial_ready: count((row) => row.financial_ready),
    context_gaps: contextGapsTotal,
    context_gaps_status_only: byStatus.CONTEXT_GAPS || 0,
    context_gaps_total: contextGapsTotal,
    hard_context_gaps: count((row) => hasMissingField(row, contextFields) && hasDetailStatus(row, ["HARD_BLOCK"])),
    soft_context_gaps: count((row) => hasMissingField(row, contextFields) && hasDetailStatus(row, ["SOFT_BLOCK"])),
    source_missing_gaps: count((row) => hasMissingField(row, contextFields) && hasDetailStatus(row, ["SOURCE_MISSING", "MANUAL_VERIFICATION_NEEDED"])),
    lineup_gaps: count((row) => hasMissingField(row, lineupFields)),
    goalkeeper_gaps: count((row) => rowMissing(row).includes("goalkeeper") || rowDetails(row).some((detail) => String(detail.missing_field || "") === "goalkeeper")),
    waiting_valid_closing: byStatus.WAITING_VALID_CLOSING || 0,
    ready_for_settlement: byStatus.READY_FOR_SETTLEMENT || 0,
    post_kickoff_audit_only: byStatus.POST_KICKOFF_AUDIT_ONLY || 0,
    shadow_settled: byStatus.SHADOW_SETTLED || 0,
    confirmed_paper: byStatus.CONFIRMED_PAPER || 0,
    real_candidate: 0,
    by_status: byStatus
  };
}

export async function getMatchPreflightStatus(db: Queryable, input: MatchPreflightInput = {}) {
  const sport = normalizeSport(input.sport);
  const limit = Math.max(1, Math.min(300, Number(input.limit || 120)));
  const window = localDateWindow(input.date);
  const currentSlateOnly = input.current_slate_only !== false;
  const includeBacklog = input.include_backlog === true || !currentSlateOnly;
  const includeLegacy = input.include_legacy === true;
  const values = [window.start, window.end, sport, limit, includeBacklog, includeLegacy];
  const result = await db.query(
    `
      WITH football AS (
        SELECT
          pt.id AS paper_trade_id,
          NULL::uuid AS real_paper_snapshot_id,
          pt.match_id,
          'soccer' AS sport,
          pt.league_slug AS league,
          COALESCE(NULLIF(pt.home_team, ''), 'Home') AS home_team,
          COALESCE(NULLIF(pt.away_team, ''), 'Away') AS away_team,
          COALESCE(NULLIF(pt.home_team, ''), 'Home') || ' vs ' || COALESCE(NULLIF(pt.away_team, ''), 'Away') AS match,
          pt.market_type,
          pt.selection,
          pt.market_odds,
          pt.model_probability,
          pt.expected_value,
          pt.status AS ticket_status,
          m.match_date AS kickoff,
          COALESCE(m.status::text, pt.status) AS match_status,
          m.home_score,
          m.away_score,
          CASE
            WHEN NULLIF(pt.raw_data->>'closing_odds', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN (pt.raw_data->>'closing_odds')::numeric
            ELSE NULL
          END AS closing_odds,
          pt.raw_data->>'closing_quality' AS closing_quality,
          CASE
            WHEN NULLIF(pt.raw_data->>'clv', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN (pt.raw_data->>'clv')::numeric
            ELSE NULL
          END AS clv,
          pt.raw_data,
          pt.placed_at AS sort_timestamp
        FROM paper_trades pt
        LEFT JOIN matches m ON m.id = pt.match_id
        WHERE pt.league_type = 'football_shadow'
          AND (
            (m.match_date >= $1::timestamptz AND m.match_date < $2::timestamptz)
            OR ($5::boolean AND (
              (pt.created_at >= $1::timestamptz AND pt.created_at < $2::timestamptz)
              OR pt.status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
            ))
          )
          AND (
            $6::boolean
            OR pt.status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
            OR COALESCE((pt.raw_data->>'clean_v2_eligible')::boolean, false)
          )
      ),
      latest_features AS (
        SELECT DISTINCT ON (mf.match_id)
          mf.match_id,
          mf.feature_set,
          mf.generated_at AS feature_generated_at
        FROM model_features mf
        ORDER BY mf.match_id, mf.generated_at DESC
      ),
      mlb AS (
        SELECT
          NULL::uuid AS paper_trade_id,
          rps.id AS real_paper_snapshot_id,
          rps.match_id,
          'baseball' AS sport,
          rps.league_slug AS league,
          COALESCE(home_team.name, 'Home') AS home_team,
          COALESCE(away_team.name, 'Away') AS away_team,
          COALESCE(away_team.name, 'Away') || ' @ ' || COALESCE(home_team.name, 'Home') AS match,
          rps.market_type,
          rps.pick AS selection,
          rps.entry_odds AS market_odds,
          rps.model_probability,
          rps.expected_value,
          rps.status AS ticket_status,
          m.match_date AS kickoff,
          COALESCE(m.status::text, rps.status) AS match_status,
          m.home_score,
          m.away_score,
          COALESCE(closing_os.odds, rps.closing_odds) AS closing_odds,
          CASE
            WHEN closing_os.raw_data->>'closing_quality' = 'CAPTURED_ON_TIME'
              AND COALESCE((closing_os.raw_data->>'safe_for_closing')::boolean, false)
              AND NULLIF(closing_os.raw_data->>'evidence_id', '') IS NOT NULL
              AND NULLIF(closing_os.raw_data->>'screenshot_sha256', '') IS NOT NULL
            THEN 'CAPTURED_ON_TIME'
            ELSE rps.raw_data->>'closing_quality'
          END AS closing_quality,
          rps.clv,
          COALESCE(rps.raw_data, '{}'::jsonb)
            || COALESCE(m.raw_data, '{}'::jsonb)
            || COALESCE(lf.feature_set, '{}'::jsonb)
            || jsonb_build_object(
              'feature_generated_at', lf.feature_generated_at,
              'venue', v.name,
              'park', v.name,
              'venue_raw_data', v.raw_data,
              'closing_evidence_id', closing_os.raw_data->>'evidence_id',
              'closing_screenshot_sha256', closing_os.raw_data->>'screenshot_sha256',
              'closing_safe_for_closing', COALESCE((closing_os.raw_data->>'safe_for_closing')::boolean, false)
            ) AS raw_data,
          rps.entry_timestamp AS sort_timestamp
        FROM real_paper_snapshots rps
        LEFT JOIN matches m ON m.id = rps.match_id
        LEFT JOIN latest_features lf ON lf.match_id = rps.match_id
        LEFT JOIN venues v ON v.id = m.venue_id
        LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
        LEFT JOIN LATERAL (
          SELECT os.*
          FROM odds_snapshots os
          WHERE os.match_id = rps.match_id
            AND os.market_type = rps.market_type
            AND os.line IS NOT DISTINCT FROM rps.line
            AND os.selection = rps.pick
            AND COALESCE(os.raw_data->>'snapshot_type', os.snapshot_role) = 'closing'
          ORDER BY os.captured_at DESC
          LIMIT 1
        ) closing_os ON TRUE
        WHERE rps.sport_slug = 'baseball'
          AND rps.league_slug = 'mlb'
          AND (
            (m.match_date >= $1::timestamptz AND m.match_date < $2::timestamptz)
            OR ($5::boolean AND (
              (rps.entry_timestamp >= $1::timestamptz AND rps.entry_timestamp < $2::timestamptz)
              OR rps.status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
            ))
          )
          AND COALESCE(rps.data_state, 'FRESH') = 'FRESH'
          AND rps.duplicate_of_id IS NULL
          AND (
            $6::boolean
            OR rps.status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
            OR COALESCE((rps.raw_data->>'clean_v2_eligible')::boolean, false)
          )
      )
      SELECT * FROM (
        SELECT * FROM football
        UNION ALL
        SELECT * FROM mlb
      ) all_rows
      WHERE ($3::text = 'all' OR sport = $3::text)
      ORDER BY sort_timestamp DESC NULLS LAST
      LIMIT $4
    `,
    values
  );

  const rows = result.rows
    .map((row) => computePreflight(row))
    .sort((a, b) => Number(a.priority || 99999) - Number(b.priority || 99999));
  const summary = summarize(rows);
  return {
    system_status: "MATCH_PREFLIGHT_ENGINE_SAFE_V1",
    date: window.selectedDate,
    sport,
    filters: {
      current_slate_only: currentSlateOnly,
      include_backlog: includeBacklog,
      include_legacy: includeLegacy
    },
    persistence_mode: "READ_ONLY",
    ...summary,
    rows,
    recommendation: summary.ready_for_settlement > 0
      ? "Hay partidos listos para settlement; verificar resultado final antes de aplicar."
      : summary.waiting_valid_closing > 0
        ? "Prioridad: capturar closing valido en ventana 10 a 3 min antes del kickoff."
        : summary.context_gaps > 0
          ? "Completar contexto deportivo antes de confiar en la señal."
          : "Mantener review; no hay partido con cadena completa.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}

export async function runMatchPreflight(db: Queryable, input: MatchPreflightInput = {}) {
  return {
    ...(await getMatchPreflightStatus(db, input)),
    run_mode: "DERIVED_RECALC_ONLY",
    updated: 0,
    applied: false
  };
}

export async function getBottleneckBySource(db: Queryable, input: MatchPreflightInput = {}) {
  const preflight = await getMatchPreflightStatus(db, input);
  const groups = new Map<string, Record<string, any>>();
  const priorityWeight: Record<string, number> = {
    HARD_BLOCK: 10,
    POST_KICKOFF_TOO_LATE: 20,
    WAITING_WINDOW: 30,
    SOURCE_MISSING: 35,
    MANUAL_VERIFICATION_NEEDED: 40,
    SOFT_BLOCK: 60
  };

  for (const row of preflight.rows || []) {
    const details = Array.isArray(row.bottleneck_details) ? row.bottleneck_details : [];
    for (const detail of details) {
      const key = [
        row.sport || "unknown",
        detail.source_needed,
        detail.resolver_module,
        detail.missing_field,
        detail.blocking_level,
        detail.data_status
      ].join("|");
      const current = groups.get(key) || {
        sport: row.sport || "unknown",
        source_needed: detail.source_needed,
        resolver_module: detail.resolver_module,
        missing_field: detail.missing_field,
        blocking_level: detail.blocking_level,
        data_status: detail.data_status,
        count: 0,
        matches_affected: [] as string[],
        match_ids: [] as string[],
        next_run_window: detail.next_run_window,
        recommended_action: detail.recommended_action,
        can_be_manual_verified: Boolean(detail.can_be_manual_verified),
        can_be_automated: Boolean(detail.can_be_automated),
        priority: priorityWeight[detail.blocking_level] ?? detail.priority ?? 99,
        why_stuck: detail.why_stuck
      };
      current.count += 1;
      if (row.match && !current.matches_affected.includes(row.match)) current.matches_affected.push(row.match);
      if (row.match_id && !current.match_ids.includes(row.match_id)) current.match_ids.push(row.match_id);
      current.can_be_manual_verified = current.can_be_manual_verified || Boolean(detail.can_be_manual_verified);
      current.can_be_automated = current.can_be_automated || Boolean(detail.can_be_automated);
      current.priority = Math.min(current.priority, priorityWeight[detail.blocking_level] ?? detail.priority ?? 99);
      groups.set(key, current);
    }
  }

  const rows: Array<Record<string, any>> = [...groups.values()]
    .map((row) => ({
      ...row,
      matches_affected: row.matches_affected.slice(0, 8),
      match_ids: row.match_ids.slice(0, 8),
      priority: Number(row.priority) * 1000 - Number(row.count || 0)
    }))
    .sort((a: Record<string, any>, b: Record<string, any>) => Number(a.priority) - Number(b.priority) || Number(b.count) - Number(a.count));

  const footballRows = rows.filter((row) => row.sport === "soccer");
  const mlbRows = rows.filter((row) => row.sport === "baseball");
  const externalSourceRows = rows.filter((row) => ["SOURCE_MISSING", "MANUAL_VERIFICATION_NEEDED"].includes(String(row.blocking_level))
    || String(row.source_needed || "").toLowerCase().includes("manual")
    || String(row.source_needed || "").toLowerCase().includes("weather api")
    || String(row.source_needed || "").toLowerCase().includes("bookmaker"));
  const ticketsWaitingClosing = rows
    .filter((row) => row.missing_field === "closing_odds_snapshot")
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const mlbPostKickoff = (preflight.rows || []).filter((row: Record<string, any>) => row.sport === "baseball" && row.preflight_status === "POST_KICKOFF_AUDIT_ONLY").length;
  const topFootball = footballRows[0] || null;
  const topMlb = mlbRows[0] || null;

  return {
    system_status: "BOTTLENECK_BY_SOURCE_SAFE_V1",
    date: preflight.date,
    sport: preflight.sport,
    persistence_mode: "READ_ONLY",
    scanned: preflight.scanned,
    rows,
    summary: {
      groups: rows.length,
      principal_football_block: topFootball ? `${topFootball.missing_field} via ${topFootball.source_needed}` : "none",
      principal_mlb_block: topMlb ? `${topMlb.missing_field} via ${topMlb.source_needed}` : "none",
      tickets_waiting_valid_closing: ticketsWaitingClosing,
      mlb_post_kickoff_games: mlbPostKickoff,
      external_source_required: externalSourceRows.reduce((sum, row) => sum + Number(row.count || 0), 0),
      next_exact_action: rows[0]?.recommended_action || preflight.recommendation
    },
    top_5: rows.slice(0, 5),
    recommendation: rows[0]
      ? `Primer bloqueo: ${rows[0].missing_field}. Fuente: ${rows[0].source_needed}. Accion: ${rows[0].recommended_action}`
      : "Sin bloqueos detectados para esta fecha.",
    guardrails: preflight.guardrails
  };
}
