import { FastifyInstance } from "fastify";
import { MatchRepository } from "./match.repository.js";
import { listMatchesQuerySchema } from "./match.schemas.js";
import { SnapshotService } from "./snapshot.service.js";
import { z } from "zod";

export async function matchRoutes(app: FastifyInstance) {
  const repository = new MatchRepository();
  const snapshots = new SnapshotService();

  app.get("/api/v1/matches", async (request) => {
    const query = listMatchesQuerySchema.parse(request.query);
    return repository.list(query);
  });

  app.get<{ Params: { id: string } }>("/api/v1/matches/:id", async (request) => {
    return repository.getById(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/v1/matches/:id/snapshots", async (request) => {
    return snapshots.getForMatch(request.params.id);
  });

  app.post("/api/v1/internal/snapshots/backfill", async (request) => {
    const body = z.object({ limit: z.number().int().min(1).max(5000).default(500) }).parse(request.body ?? {});
    return snapshots.backfill(body.limit);
  });

  app.get<{ Params: { slug: string } }>("/api/v1/leagues/:slug/table", async (request) => {
    return repository.getLeagueTable(request.params.slug);
  });

  app.get<{ Params: { slug: string } }>("/api/v1/teams/:slug/form", async (request) => {
    return repository.getTeamForm(request.params.slug);
  });

  app.get<{ Params: { id: string } }>("/api/v1/teams/:id/stats", async (request) => {
    return repository.getTeamStats(request.params.id);
  });
}
