import { redis } from "./cache/redis.js";
import { env } from "./config/env.js";
import { db } from "./db/index.js";
import { buildApp } from "./app.js";

const app = buildApp();

const start = async () => {
  try {
    await db.query("SELECT 1;");
    await redis.ping();
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

process.on("SIGTERM", async () => {
  await app.close();
  await db.end();
  redis.disconnect();
});

start();
