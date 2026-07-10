import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: env.DATABASE_URL
});

export async function checkDatabase() {
  await db.query("SELECT 1;");
}
