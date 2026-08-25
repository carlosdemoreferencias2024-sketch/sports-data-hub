import crypto from "node:crypto";
import { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";

const publicPrefixes = ["/health", "/api/v1", "/ws", "/docs", "/dashboard"];
const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function safeCompare(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function apiKeyHook(request: FastifyRequest, reply: FastifyReply) {
  if (request.method === "OPTIONS") {
    return;
  }

  const providedInternalKey = request.headers["x-internal-api-key"] ?? request.headers["x-api-key"];
  if (safeCompare(providedInternalKey, env.INTERNAL_API_KEY)) {
    return;
  }

  const isInternal = request.url.startsWith("/api/v1/internal") || request.url.startsWith("/internal");
  if (isInternal) {
    request.log.warn({ ip: request.ip, url: request.url }, "Unauthorized internal request");
    return reply.status(401).send({ error: "unauthorized" });
  }

  const isPublicRead = !writeMethods.has(request.method) && publicPrefixes.some((prefix) => request.url.startsWith(prefix));
  if (isPublicRead) {
    return;
  }

  if (!safeCompare(request.headers["x-api-key"], env.API_KEY)) {
    request.log.warn({ ip: request.ip, method: request.method, url: request.url }, "Unauthorized API request");
    return reply.status(401).send({ error: "unauthorized" });
  }
}
