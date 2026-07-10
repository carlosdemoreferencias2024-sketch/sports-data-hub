import { z } from "zod";

export const matchStatusSchema = z.enum([
  "scheduled",
  "live",
  "finished",
  "postponed",
  "cancelled"
]);

export const listMatchesQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  league: z.string().optional(),
  status: matchStatusSchema.optional(),
  team: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50)
});

export type ListMatchesQuery = z.infer<typeof listMatchesQuerySchema>;
