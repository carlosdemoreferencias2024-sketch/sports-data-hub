import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_KEY: z.string().min(32, "API_KEY debe tener al menos 32 caracteres"),
  INTERNAL_API_KEY: z.string().min(32, "INTERNAL_API_KEY debe tener al menos 32 caracteres"),
  ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:4000,http://localhost:4000"),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW: z.string().default("1 minute")
});

export const env = envSchema.parse(process.env);
