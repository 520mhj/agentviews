export function planAnswerTiming(question, { difficulty = 0.5, uncertainty = 0, elapsedMs = 0,
  remainingMs = Infinity, minimumMs = 2000, maximumMs = 45000 } = {}) {
  if (typeof question !== 'string' || !question.trim()) throw new Error('Question text is required');
  for (const value of [difficulty, uncertainty]) if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Difficulty and uncertainty must be between 0 and 1');
  if (![elapsedMs, minimumMs, maximumMs].every(Number.isFinite) || elapsedMs < 0 || minimumMs < 0 || maximumMs < minimumMs
    || !(remainingMs === Infinity || Number.isFinite(remainingMs) && remainingMs >= 0)) throw new Error('Invalid timing bounds');
  const readingMs = [...question.trim()].length / 6 * 1000;
  const plannedMs = Math.round(Math.max(minimumMs, Math.min(maximumMs, readingMs + difficulty * 8000 + uncertainty * 12000)));
  const waitMs = Math.max(0, plannedMs - elapsedMs);
  return { plannedMs, elapsedMs, waitMs, fitsDeadline: waitMs <= remainingMs,
    purpose: 'authorized_practice', instruction: '完成真实推理再选择；等待不代表思考，不用于伪装真人或规避验证，最终提交仍由用户执行。' };
}

export function waitForAnswerTiming(plan, { signal } = {}) {
  if (!plan || !Number.isFinite(plan.waitMs) || plan.waitMs < 0 || plan.waitMs > 900000) return Promise.reject(new Error('Invalid wait plan'));
  if (!plan.fitsDeadline) return Promise.reject(new Error('Insufficient remaining time; request a user decision'));
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(signal.reason || new Error('Timing cancelled')); };
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => { cleanup(); resolve({ waitedMs: plan.waitMs }); }, plan.waitMs);
  });
}
