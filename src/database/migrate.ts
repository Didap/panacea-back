import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadEnv } from '../config/env';

async function main() {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const dir = join(process.cwd(), 'drizzle', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set<string>(
    (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
      (r) => r.filename,
    ),
  );

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = await readFile(join(dir, file), 'utf8');
    process.stdout.write(`applying ${file} ... `);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      process.stdout.write('ok\n');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      process.stdout.write('FAILED\n');
      throw err;
    } finally {
      client.release();
    }
  }

  await pool.end();
  process.stdout.write('migrations complete\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
