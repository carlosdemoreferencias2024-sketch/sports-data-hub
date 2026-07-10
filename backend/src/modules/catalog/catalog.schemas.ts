import { z } from "zod";

export const listLeaguesQuerySchema = z.object({
  sport: z.string().optional()
});

export const listTeamsQuerySchema = z.object({
  league: z.string().optional(),
  search: z.string().optional()
});

export type ListLeaguesQuery = z.infer<typeof listLeaguesQuerySchema>;
export type ListTeamsQuery = z.infer<typeof listTeamsQuerySchema>;
