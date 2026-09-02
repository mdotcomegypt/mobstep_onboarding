/**
 * Applies every .sql file in migrations/ in filename order, once.
 *
 * Deliberately minimal: the schema is small and the alternative is a migration
 * framework whose failure modes are larger than the schema it manages.
 *
 * Builds its own pool rather than importing db/index.ts, which pulls in env.ts
 * and would refuse to run without every secret the *server* needs. Applying a
 * migration requires a database URL and nothing else, and demanding a WhatsApp
 * token to create a table is how a deploy gets stuck for no reason.
 */

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error(
    "Missing DATABASE_URL.\n" +
      "Set it in .env at the repository root (see .env.example) — the migrate\n" +
      "script loads that file automatically — or export it for this command.",
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS onboarding_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const { rowCount } = await client.query(
        "SELECT 1 FROM onboarding_migrations WHERE name = $1",
        [file],
      );
      if (rowCount) {
        console.log(`= ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO onboarding_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`+ ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
