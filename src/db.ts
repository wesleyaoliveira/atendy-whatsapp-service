import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id   text PRIMARY KEY,
      webhook_url  text NOT NULL,
      status       text NOT NULL DEFAULT 'pending',
      phone        text,
      profile_name text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS auth_keys (
      session_id text NOT NULL,
      key        text NOT NULL,
      value      jsonb NOT NULL,
      PRIMARY KEY (session_id, key)
    );
  `);
}
