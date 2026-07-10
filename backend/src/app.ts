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

export function buildApp() {
  const app = Fastify({ logger: true });

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
    if (request.method === "OPTIONS") {
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Key,X-Internal-API-Key");
      return reply.status(204).send();
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/internal") && !request.url.startsWith("/internal")) {
      return;
    }

    const expectedKey = env.INTERNAL_API_KEY ?? env.API_KEY;
    if (!expectedKey) {
      return;
    }

    const providedKey = request.headers["x-internal-api-key"] ?? request.headers["x-api-key"];
    if (providedKey !== expectedKey) {
      request.log.warn({ ip: request.ip, url: request.url }, "Unauthorized internal request");
      return reply.status(401).send({
        error: "Unauthorized",
        message: "No tienes permisos para interactuar con la ingesta interna."
      });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Key,X-Internal-API-Key");
    return payload;
  });

  app.addHook("onRequest", apiKeyHook);

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
