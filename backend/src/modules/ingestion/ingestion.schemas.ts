import { z } from "zod";

export const batchMatchSchema = z.object({
  source_slug: z.string().min(1),
  source_match_id: z.string().min(1),
  league_slug: z.string().min(1),
  match_date: z.string().min(1),
  status: z.enum(["scheduled", "live", "finished", "postponed", "cancelled"]),
  home_alias: z.string().min(1),
  away_alias: z.string().min(1),
  home_score: z.number().int().optional().nullable(),
  away_score: z.number().int().optional().nullable(),
  home_odds: z.number().positive().optional().nullable(),
  away_odds: z.number().positive().optional().nullable(),
  odds_source: z.enum(["market_odds", "simulated_odds", "manual_backfill_odds"]).optional().nullable(),
  period: z.string().optional().nullable(),
  raw_data: z.record(z.unknown()).optional()
});

export const batchIngestionSchema = z.object({
  matches: z.array(batchMatchSchema).min(1).max(500)
});

export type BatchMatchInput = z.infer<typeof batchMatchSchema>;
