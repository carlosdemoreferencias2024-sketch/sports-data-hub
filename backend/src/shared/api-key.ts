import { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";

const publicPrefixes = ["/health", "/api/v1", "/ws", "/docs", "/dashboard"];

export async function apiKeyHook(request: FastifyRequest, reply: FastifyReply) {
  if (!env.API_KEY || request.method === "OPTIONS") {
    return;
  }

  if (publicPrefixes.some((prefix) => request.url.startsWith(prefix))) {
    return;
  }

  const apiKey = request.headers["x-api-key"];
  if (apiKey !== env.API_KEY) {
    return reply.status(401).send({ message: "API key requerida" });
  }
}
