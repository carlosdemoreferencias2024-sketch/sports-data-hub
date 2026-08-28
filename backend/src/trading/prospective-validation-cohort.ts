import { db } from "../db/index.js";

export type ProspectiveSampleClass =
  | "REPLAY_RESEARCH"
  | "PROSPECTIVE_INCOMPLETE"
  | "PROSPECTIVE_CLEAN";

export type LeagueValidationPolicy = {
  researchAllowed: boolean;
  shadowAllowed: boolean;
  paperAllowed: boolean;
  realAllowed: boolean;
  reason: string;
};

const DEFAULT_POLICY: LeagueValidationPolicy = Object.freeze({
  researchAllowed: true,
  shadowAllowed: true,
  paperAllowed: false,
  realAllowed: false,
  reason: "PROSPECTIVE_VALIDATION_ONLY"
});

const LIGA_MX_POLICY: LeagueValidationPolicy = Object.freeze({
  researchAllowed: true,
  shadowAllowed: true,
  paperAllowed: false,
  realAllowed: false,
  reason: "LIGA_MX_REQUIRES_PROSPECTIVE_CALIBRATION"
});

export function getLeagueValidationPolicy(leagueSlug: string): LeagueValidationPolicy {
  return leagueSlug.trim().toLowerCase() === "liga-mx" ? LIGA_MX_POLICY : DEFAULT_POLICY;
}

export function prospectiveMilestone(cleanSampleSize: number) {
  if (cleanSampleSize >= 250) return { current: 250, next: null, label: "SEGMENTATION_READY" };
  if (cleanSampleSize >= 100) return { current: 100, next: 250, label: "CALIBRATION_REVIEW" };
  if (cleanSampleSize >= 50) return { current: 50, next: 100, label: "STABILITY_REVIEW" };
  if (cleanSampleSize >= 20) return { current: 20, next: 50, label: "PIPELINE_SIGNAL" };
  return { current: cleanSampleSize, next: 20, label: "BUILD_FIRST_CLEAN_CHAINS" };
}

export async function getProspectiveValidationCohort(limit = 100) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const [counts, rows] = await Promise.all([
    db.query(`
      SELECT sample_class, count(*)::int AS count
      FROM forecast_prospective_validation_cohort_v1
      GROUP BY sample_class
      ORDER BY sample_class
    `),
    db.query(`
      SELECT *
      FROM forecast_prospective_validation_cohort_v1
      ORDER BY kickoff DESC, forecast_id
      LIMIT $1
    `, [boundedLimit])
  ]);
  const byClass = Object.fromEntries(counts.rows.map((row) => [row.sample_class, Number(row.count)]));
  const clean = Number(byClass.PROSPECTIVE_CLEAN ?? 0);
  return {
    system_status: "PROSPECTIVE_VALIDATION_COHORT_V1",
    counts: {
      replay_research: Number(byClass.REPLAY_RESEARCH ?? 0),
      prospective_incomplete: Number(byClass.PROSPECTIVE_INCOMPLETE ?? 0),
      prospective_clean: clean
    },
    milestone: prospectiveMilestone(clean),
    metric_priority: ["calibration", "brier_log_loss", "clv", "roi_yield", "realized_vs_expected_ev", "accuracy"],
    operational_metrics_source: "forecast_operational_metrics_dataset_v1",
    liga_mx_policy: getLeagueValidationPolicy("liga-mx"),
    rows: rows.rows,
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      autopost_enabled: false,
      kill_switch_enabled: true
    }
  };
}
