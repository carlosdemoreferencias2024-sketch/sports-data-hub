import { FastifyInstance } from "fastify";
import { CatalogRepository } from "./catalog.repository.js";
import { listLeaguesQuerySchema, listTeamsQuerySchema } from "./catalog.schemas.js";

export async function catalogRoutes(app: FastifyInstance) {
  const repository = new CatalogRepository();

  app.get("/api/v1/sports", async () => repository.listSports());

  app.get("/api/v1/leagues", async (request) => {
    const query = listLeaguesQuerySchema.parse(request.query);
    return repository.listLeagues(query);
  });

  app.get("/api/v1/teams", async (request) => {
    const query = listTeamsQuerySchema.parse(request.query);
    return repository.listTeams(query);
  });
}
