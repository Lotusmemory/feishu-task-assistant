const OFFSET_MS = 8 * 60 * 60 * 1000;

export function shanghaiDayWindow(now = new Date()) {
  const shifted = new Date(now.getTime() + OFFSET_MS);
  const dateKey = shifted.toISOString().slice(0, 10);
  const startMs = Date.parse(`${dateKey}T00:00:00+08:00`);
  return { dateKey, startSeconds: startMs / 1000, endSeconds: startMs / 1000 + 86_400 - 1 };
}

export function millisecondsUntilNextRun(now = new Date(), hour = 18, minute = 0) {
  const { dateKey } = shanghaiDayWindow(now);
  let target = Date.parse(`${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`);
  if (target <= now.getTime()) target += 86_400_000;
  return target - now.getTime();
}
