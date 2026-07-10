import { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { LiveService } from "./live.service.js";
import { env } from "../../config/env.js";

const liveStateSchema = z.object({
  status: z.enum(["scheduled", "live", "finished", "postponed", "cancelled"]),
  period: z.string().optional().nullable(),
  clock: z.string().optional().nullable(),
  home_score: z.number().int().optional().nullable(),
  away_score: z.number().int().optional().nullable(),
  home_odds: z.number().positive().optional().nullable(),
  away_odds: z.number().positive().optional().nullable(),
  odds_source: z.enum(["market_odds", "simulated_odds", "manual_backfill_odds"]).optional().nullable(),
  payload: z.record(z.unknown()).optional()
});

export async function liveRoutes(app: FastifyInstance) {
  const service = new LiveService();

  app.get<{ Params: { id: string } }>("/api/v1/matches/:id/live", async (request) => {
    return service.get(request.params.id);
  });

  const requireInternalKey = (request: FastifyRequest) => {
    if (!env.API_KEY) {
      return true;
    }

    return request.headers["x-internal-api-key"] === env.API_KEY || request.headers["x-api-key"] === env.API_KEY;
  };

  const updateLiveMatch = async (request: FastifyRequest<{ Params: { id: string } }>, reply: { code: (statusCode: number) => void }) => {
    if (!requireInternalKey(request)) {
      return { statusCode: 401, body: { message: "Internal API key requerida" } };
    }

    const body = liveStateSchema.parse(request.body);
    const state = await service.set(request.params.id, {
      match_id: request.params.id,
      updated_at: new Date().toISOString(),
      ...body
    });

    if (state.status === "finished") {
      await service.persistFinal(request.params.id);
    }

    reply.code(202);
    return { statusCode: 202, body: state };
  };

  app.post<{ Params: { id: string } }>("/api/v1/internal/matches/:id/live", async (request, reply) => {
    const result = await updateLiveMatch(request, reply);
    return reply.status(result.statusCode).send(result.body);
  });

  app.post<{ Params: { id: string } }>("/internal/live/matches/:id", async (request, reply) => {
    const result = await updateLiveMatch(request, reply);
    return reply.status(result.statusCode).send(result.body);
  });
}
