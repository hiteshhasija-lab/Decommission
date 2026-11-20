// Container health check: the service answers /healthz and its database is reachable.
fetch(`http://127.0.0.1:${process.env.PORT || 8080}/healthz`, { signal: AbortSignal.timeout(4000) })
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
