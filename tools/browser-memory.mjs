import { readFile } from 'node:fs/promises';

/** Sample owned Chromium processes and dedicated-worker heaps without retaining page objects. */
export async function memoryTracker(browser, pid) {
  const cdp = await browser.newBrowserCDPSession();
  const sessions = new Map(), pending = new Map(), workerSamples = [], processSamples = [], targets = [];
  let nextId = 0, stopped = false;
  cdp.on('Target.receivedMessageFromTarget', event => {
    const response = JSON.parse(event.message);
    const key = `${event.sessionId}:${response.id}`, waiter = pending.get(key);
    if (waiter) { pending.delete(key); clearTimeout(waiter.timer); if (response.error) waiter.reject(new Error(response.error.message)); else waiter.resolve(response.result); }
  });
  const call = (sessionId, method) => new Promise((resolve, reject) => {
    const id = ++nextId, key = `${sessionId}:${id}`;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('Worker measurement timed out')); }, 1000);
    pending.set(key, { resolve, reject, timer });
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) }).catch(error => { pending.delete(key); clearTimeout(timer); reject(error); });
  });
  cdp.on('Target.targetCreated', async ({ targetInfo }) => {
    targets.push({ type: targetInfo.type, url: targetInfo.url });
    if (stopped || targetInfo.type !== 'worker') return;
    try { const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: false }); sessions.set(targetInfo.targetId, sessionId); }
    catch { /* A short-lived worker can finish before attachment. */ }
  });
  cdp.on('Target.targetDestroyed', ({ targetId }) => sessions.delete(targetId));
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  async function processes(parent) {
    const rows = [];
    try {
      const [status, command, children] = await Promise.all([
        readFile(`/proc/${parent}/status`, 'utf8'), readFile(`/proc/${parent}/cmdline`, 'utf8'),
        readFile(`/proc/${parent}/task/${parent}/children`, 'utf8'),
      ]);
      rows.push({ pid: parent, role: command.match(/--type=([^\0 ]+)/)?.[1] || 'browser', rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) * 1024, peakRssBytes: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] || 0) * 1024 });
      for (const child of children.trim().split(/\s+/).filter(Boolean)) rows.push(...await processes(Number(child)));
    } catch { /* Processes can exit between samples. */ }
    return rows;
  }
  let timer, inFlight;
  async function sample() {
    if (stopped) return;
    const at = Date.now();
    await Promise.all([...sessions.entries()].map(async ([targetId, sessionId]) => {
      try { workerSamples.push({ at, targetId, ...await call(sessionId, 'Runtime.getHeapUsage') }); } catch { /* Termination closes a pending inspector request. */ }
    }));
    if (pid) processSamples.push({ at, processes: await processes(pid) });
    if (!stopped) timer = setTimeout(() => { inFlight = sample(); }, 25);
  }
  inFlight = sample();
  return {
    async finish() {
      stopped = true; clearTimeout(timer);
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Measurement finished')); }
      pending.clear(); await inFlight; await cdp.detach();
      const byProcess = new Map();
      for (const sample of processSamples) for (const row of sample.processes) {
        const old = byProcess.get(row.pid);
        byProcess.set(row.pid, { ...row, peakRssBytes: Math.max(old?.peakRssBytes || 0, row.peakRssBytes) });
      }
      return { targets, workerSampleCount: workerSamples.length, workerPeakHeapBytes: workerSamples.length ? Math.max(...workerSamples.map(sample => sample.usedSize)) : null, workerPeakBackingBytes: workerSamples.length ? Math.max(...workerSamples.map(sample => sample.backingStorageSize)) : null, processPeakRss: [...byProcess.values()], sampledAggregateRssBytes: Math.max(0, ...processSamples.map(sample => sample.processes.reduce((sum, row) => sum + row.rssBytes, 0))) };
    },
  };
}
