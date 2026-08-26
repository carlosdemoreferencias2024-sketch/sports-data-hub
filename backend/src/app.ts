import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { ZodError } from "zod";
import { checkRedis, redis } from "./cache/redis.js";
import { env } from "./config/env.js";
import { checkDatabase } from "./db/index.js";
import { catalogRoutes } from "./modules/catalog/catalog.routes.js";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { ingestionRoutes } from "./modules/ingestion/ingestion.routes.js";
import { liveRoutes } from "./modules/live/live.routes.js";
import { liveWebsocketRoutes } from "./modules/live/live.websocket.js";
import { matchRoutes } from "./modules/matches/match.routes.js";
import { mappingRoutes } from "./modules/mappings/mapping.routes.js";
import { modelQuoteRoutes } from "./modules/model-quotes/model-quote.routes.js";
import { paperTradeRoutes } from "./modules/paper-trades/paper-trade.routes.js";
import { quoteRoutes } from "./modules/quotes/quote.routes.js";
import { apiKeyHook } from "./shared/api-key.js";
import { AppError } from "./shared/http-errors.js";
import { analyticsRoutes } from "./modules/analytics/analytics.routes.js";
import { footballNearStartCaptureRoutes } from "./modules/analytics/football-near-start-capture.routes.js";

export function buildApp() {
  const app = Fastify({ logger: true });
  const allowedOrigins = new Set(
    env.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );

  app.register(websocket);
  app.register(swagger, {
    openapi: {
      info: {
        title: "Sports API",
        description: "API deportiva multideporte con datos historicos, live cache y scrapers propios.",
        version: "0.1.0"
      },
      tags: [
        { name: "health", description: "Estado del sistema" },
        { name: "catalog", description: "Deportes, ligas y equipos" },
        { name: "matches", description: "Partidos, live state y analiticas" },
        { name: "internal", description: "Ingesta protegida para workers" }
      ]
    }
  });
  app.register(swaggerUi, {
    routePrefix: "/docs"
  });
  app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    redis,
    allowList: (request) =>
      request.url.startsWith("/api/v1/internal") ||
      request.url.startsWith("/internal") ||
      request.url.startsWith("/ws") ||
      request.url.startsWith("/docs")
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return reply.status(403).send({ error: "origin_not_allowed" });
    }

    if (request.method === "OPTIONS") {
      if (origin) {
        reply.header("Access-Control-Allow-Origin", origin);
        reply.header("Vary", "Origin");
      }
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Key,X-Internal-API-Key");
      return reply.status(204).send();
    }
  });

  app.addHook("onRequest", apiKeyHook);

  app.addHook("onSend", async (request, reply, payload) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
    }
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Key,X-Internal-API-Key");
    return payload;
  });

  app.get("/health", async () => {
    await Promise.all([checkDatabase(), checkRedis()]);
    return {
      status: "ok",
      services: {
        postgres: "ok",
        redis: "ok"
      }
    };
  });

  app.register(catalogRoutes);
  app.register(analyticsRoutes);
  app.register(footballNearStartCaptureRoutes);
  app.register(dashboardRoutes);
  app.register(matchRoutes);
  app.register(mappingRoutes);
  app.register(modelQuoteRoutes);
  app.register(paperTradeRoutes);
  app.register(quoteRoutes);
  app.register(ingestionRoutes);
  app.register(liveRoutes);
  app.register(liveWebsocketRoutes);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        message: "Datos invalidos",
        issues: error.flatten()
      });
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ message: error.message });
    }

    const httpError = error as { statusCode?: number; message?: string };
    if (
      typeof httpError.statusCode === "number" &&
      httpError.statusCode >= 400 &&
      httpError.statusCode < 500
    ) {
      return reply.status(httpError.statusCode).send({
        message: httpError.message ?? "Solicitud invalida"
      });
    }

    app.log.error(error);
    return reply.status(500).send({ message: "Error interno del servidor" });
  });

  return app;
}
