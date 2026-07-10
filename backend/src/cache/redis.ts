import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 2
});

export function createRedisSubscriber() {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2
  });
}

export async function checkRedis() {
  const pong = await redis.ping();
  if (pong !== "PONG") {
    throw new Error("Redis ping failed");
  }
}
