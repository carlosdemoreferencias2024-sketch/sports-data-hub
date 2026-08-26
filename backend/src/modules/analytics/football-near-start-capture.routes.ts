import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import {
  captureFootballOfficialNearStartContext
} from "../../trading/football-data-gateway.js";
import { getFootballNearStartCaptureTarget } from "../../trading/football-near-start-capture-target.js";

export async function footballNearStartCaptureRoutes(app: FastifyInstance) {
  app.get("/api/v1/internal/analytics/football/near-start-capture/target", async (request) =>
    getFootballNearStartCaptureTarget(db, (request.query ?? {}) as Record<string, unknown>)
  );

  app.post("/api/v1/internal/analytics/football/near-start-capture/official-context", async (request) =>
    captureFootballOfficialNearStartContext(db, request.body)
  );
}
