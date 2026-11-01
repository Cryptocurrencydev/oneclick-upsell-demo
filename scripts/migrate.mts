import { readFileSync } from "node:fs";
import { Client } from "pg";
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const c = new Client({ connectionString: url, ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: false } : undefined });
await c.connect();
await c.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
await c.end();
console.log("schema applied");
