// A thin database layer with one interface over two drivers: node-postgres for the service and
// PGlite (Postgres compiled to WebAssembly) for the tests, so the tests run the real SQL.
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
}

// node-postgres. `exec` runs a multi-statement script (migrations).
function postgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5 });
  return {
    query: (text, params) => pool.query(text, params),
    exec: (text) => pool.query(text),
    // Held for one step of one run, so two processes never run the same step's external calls at once.
    async withRunLock(runId, fn) {
      const client = await pool.connect();
      try {
        const { rows } = await client.query('SELECT pg_try_advisory_lock(4242, $1::int) AS ok', [runId]);
        if (!rows[0].ok) return { skipped: true };
        try {
          return { value: await fn() };
        } finally {
          await client.query('SELECT pg_advisory_unlock(4242, $1::int)', [runId]).catch(() => {});
        }
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// PGlite, in memory. One connection, so the run lock is an in-process set.
async function pglite() {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = new PGlite();
  const held = new Set();
  return {
    query: (text, params) => pg.query(text, params),
    exec: (text) => pg.exec(text),
    async withRunLock(runId, fn) {
      if (held.has(runId)) return { skipped: true };
      held.add(runId);
      try {
        return { value: await fn() };
      } finally {
        held.delete(runId);
      }
    },
    close: () => pg.close(),
  };
}

module.exports = { migrate, postgres, pglite };
