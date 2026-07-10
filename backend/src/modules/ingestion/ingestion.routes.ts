import { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../../config/env.js";
import { batchIngestionSchema } from "./ingestion.schemas.js";
import { IngestionService } from "./ingestion.service.js";

export async function ingestionRoutes(app: FastifyInstance) {
  const service = new IngestionService();

  const hasInternalKey = (request: FastifyRequest) => {
    const expectedKey = env.INTERNAL_API_KEY ?? env.API_KEY;
    if (!expectedKey) {
      return true;
    }

    return request.headers["x-internal-api-key"] === expectedKey || request.headers["x-api-key"] === expectedKey;
  };

  app.post("/api/v1/internal/matches/batch", async (request, reply) => {
    if (!hasInternalKey(request)) {
      request.log.warn({ ip: request.ip, url: request.url }, "Unauthorized internal ingestion attempt");
      return reply.status(401).send({
        error: "Unauthorized",
        message: "No tienes permisos para interactuar con la ingesta interna."
      });
    }

    const body = batchIngestionSchema.parse(request.body);
    const result = await service.ingestBatch(body.matches);
    reply.code(result.errors ? 207 : 202);
    return result;
  });
}
