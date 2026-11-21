// The orchestrator service: HTTP API (for the CLI now, for Teams and Copilot later), the scheduler that
// moves runs on and resumes interrupted ones, and the outbox delivery.
const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const { postgres, migrate } = require('./db');
const { createEngine, DecomError } = require('./engine');
const { adapters } = require('./app');
const { extractDecomIntent, extractStatusIntent } = require('./grammar');
const { version } = require('../package.json');

function tokenOk(header, token) {
  const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return token && given.length === want.length && crypto.timingSafeEqual(given, want);
}

function buildApp({ engine, cfg, db }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', async (_req, res) => {
    let dbOk = false;
    try { await db.query('SELECT 1'); dbOk = true; } catch { /* reported below */ }
    const problems = config.problems(cfg);
    // Stuck runs are reported, not a failed health check: the service itself is fine and a restart
    // would not help. A monitoring tool can alert on `stuck` being non-empty.
    let stuck = [];
    if (dbOk) stuck = (await engine.stuckRuns().catch(() => [])).map(({ run, reason }) => ({ id: run.id, server: run.ci ? run.ci.name : run.server, state: run.state, reason }));
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, version, dryRun: cfg.dryRun, soakHours: cfg.soakHours, notifier: cfg.notifier, problems, stuck });
  });

  app.use('/api', (req, res, next) => (tokenOk(req.get('authorization'), cfg.apiToken) ? next() : res.status(401).json({ error: 'Missing or wrong API token.' })));

  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const status = e instanceof DecomError ? e.status : 500;
      if (status === 500) console.error(e);
      res.status(status).json({ error: e.message });
    }
  };

  // A request cannot get anywhere until ServiceNow and vSphere are configured: say so instead of
  // leaving a run that retries for ever.
  const notReady = () => config.problems(cfg).filter((p) => /ServiceNow|vSphere/.test(p));
  const startRun = (server, actor) => {
    const missing = notReady();
    if (missing.length) throw new DecomError(503, `The orchestrator is not configured yet: ${missing.join('; ')}.`);
    return engine.request({ server, actor });
  };

  app.post('/api/requests', wrap((req) => startRun(req.body.server, req.body.actor)));
  app.get('/api/runs', wrap((req) => engine.list({ all: req.query.all === '1' })));
  app.get('/api/status/:query', wrap(async (req) => {
    const s = await engine.status(req.params.query);
    if (!s) throw new DecomError(404, `No decommission found for ${req.params.query}.`);
    return s;
  }));
  app.post('/api/runs/:id/prechecks/:task', wrap((req) => engine.precheck({ runId: req.params.id, task: req.params.task, outcome: req.body.outcome, actor: req.body.actor, reason: req.body.reason })));
  app.post('/api/runs/:id/confirm-destroy', wrap((req) => engine.confirmDestroy({ runId: req.params.id, actor: req.body.actor })));
  app.post('/api/runs/:id/cancel', wrap((req) => engine.cancel({ runId: req.params.id, actor: req.body.actor, reason: req.body.reason })));
  app.post('/api/runs/:id/retry', wrap((req) => engine.retry({ runId: req.params.id, actor: req.body.actor })));
  app.get('/api/messages', wrap((req) => engine.messages(Math.min(500, Number(req.query.limit) || 50))));

  // A typed chat command, read with the deterministic grammar ("decommission X", "status X"). The
  // shape the Teams adapter will call; the identity comes from the caller.
  app.post('/api/command', wrap(async (req) => {
    const { text, actor } = req.body || {};
    const decom = extractDecomIntent(text);
    if (decom) {
      const run = await startRun(decom.hostname, actor);
      return { reply: `Request received: decommission ${decom.hostname} (run ${run.id}). Checking the CMDB and vSphere.`, run };
    }
    const st = extractStatusIntent(text);
    if (st && st.query) {
      const s = await engine.status(st.query);
      return { reply: s ? `${s.run.ci ? s.run.ci.name : s.run.server}${s.run.change_number ? ` (${s.run.change_number})` : ''}: ${s.label}.${s.run.attention ? ` Needs attention: ${s.run.attention}` : ''}${s.run.outcome ? ` ${s.run.outcome}` : ''}` : `No decommission found for ${st.query}.` };
    }
    return { reply: 'Say "decommission <server>", "status <server>" or "status <change number>".' };
  }));

  return app;
}

async function main() {
  const cfg = config.load();
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set.');
  const db = postgres(cfg.databaseUrl);
  for (let i = 0; ; i += 1) { // the database container may still be starting
    try { await migrate(db); break; } catch (e) { if (i >= 30) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
  const { itsm, hypervisor, notifier } = adapters(cfg);
  const engine = createEngine({ db, itsm, hypervisor, notifier, config: cfg });
  const problems = config.problems(cfg);
  console.log(`decom-orchestrator ${version} starting. Dry run: ${cfg.dryRun}. Soak: ${cfg.soakHours} h. Notifier: ${cfg.notifier}.`);
  for (const p of problems) console.warn(`[config] ${p}`);

  // Runs advance in the background, side by side; messages are delivered on their own timer so a long
  // VM step never holds them up.
  const tick = () => engine.tick({ wait: false }).catch((e) => console.error('tick failed:', e.message));
  const deliver = () => engine.deliver().catch((e) => console.error('delivery failed:', e.message));
  setTimeout(tick, 3000); // resume interrupted runs shortly after a start
  setInterval(tick, 15000); // cheap: it only picks runs whose timer is due
  setInterval(deliver, 5000);
  setInterval(() => engine.checkStuck().catch((e) => console.error('stuck check failed:', e.message)), 5 * 60000);

  const server = buildApp({ engine, cfg, db }).listen(cfg.port, () => console.log(`listening on :${cfg.port}`));
  const stop = () => { server.close(); db.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { buildApp };
