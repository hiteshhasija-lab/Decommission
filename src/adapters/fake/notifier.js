function fakeNotifier() {
  const sent = [];
  let failures = 0;
  return {
    sent,
    failTimes(n) { failures = n; },
    async send(msg) {
      if (failures > 0) { failures -= 1; throw new Error('Teams unavailable'); }
      sent.push(msg);
    },
  };
}
module.exports = { fakeNotifier };
