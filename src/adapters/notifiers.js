// Where chat messages go. "console" writes them to the service log (and `decom log` lists them from
// the outbox); "teams-workflow" posts them to a Teams Workflows webhook ("post to a channel when a
// webhook request is received"), the no-bot design. The bot adapter comes with the Teams integration.
function consoleNotifier(log = console) {
  return { async send({ runId, message }) { log.log(`[notify] run ${runId}: ${message}`); } };
}

function teamsWorkflowNotifier(url, { fetchImpl = fetch } = {}) {
  return {
    async send({ runId, message, data }) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message, runId, ...(data || {}) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const e = new Error(`Teams workflow answered HTTP ${res.status}`);
        // A 4xx will not change by retrying (except timeouts and rate limits): set the message aside.
        e.permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
        throw e;
      }
    },
  };
}

module.exports = { consoleNotifier, teamsWorkflowNotifier };
