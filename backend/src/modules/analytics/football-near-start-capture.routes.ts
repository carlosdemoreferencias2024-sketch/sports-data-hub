import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import {
  captureFootballOfficialNearStartContext
} from "../../trading/football-data-gateway.js";
import { getFootballNearStartCaptureTarget } from "../../trading/football-near-start-capture-target.js";
import {
  acquireFootballOperationalFocus,
  recordAutomatedFootballMarketCapture,
  recordAutomatedFootballNearStartContext,
  reconcileFootballOperationalResults
} from "../../trading/football-operational-automation.js";

export async function footballNearStartCaptureRoutes(app: FastifyInstance) {
  app.get("/api/v1/internal/analytics/football/near-start-capture/target", async (request) =>
    getFootballNearStartCaptureTarget(db, (request.query ?? {}) as Record<string, unknown>)
  );

  app.post("/api/v1/internal/analytics/football/near-start-capture/official-context", async (request) =>
    captureFootballOfficialNearStartContext(db, request.body)
  );

  app.post("/api/v1/internal/analytics/football/near-start-capture/official-context/import", async (request) => {
    const capture = await captureFootballOfficialNearStartContext(db, request.body);
    if (!capture.capture_ready) return capture;
    return recordAutomatedFootballNearStartContext(db, capture);
  });

  app.post("/api/v1/internal/analytics/football/operational-focus/acquire", async (request) =>
    acquireFootballOperationalFocus(db, (request.body ?? {}) as Record<string, unknown>)
  );

  app.post("/api/v1/internal/analytics/football/provider-market-capture", async (request) =>
    recordAutomatedFootballMarketCapture(db, request.body as Record<string, unknown>)
  );

  app.post("/api/v1/internal/analytics/football/provider-near-start-capture", async (request) =>
    recordAutomatedFootballNearStartContext(db, request.body as Record<string, unknown>)
  );

  app.post("/api/v1/internal/analytics/football/operational-results/reconcile", async (request) =>
    reconcileFootballOperationalResults(db, (request.body ?? {}) as Record<string, unknown>)
  );
}
