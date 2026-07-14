import test from 'node:test';
import assert from 'node:assert/strict';
import { millisecondsUntilNextRun, shanghaiDayWindow } from '../src/date-window.js';

test('computes Shanghai day boundaries as epoch seconds', () => {
  assert.deepEqual(shanghaiDayWindow(new Date('2026-07-14T10:30:00Z')), {
    dateKey: '2026-07-14', startSeconds: 1783958400, endSeconds: 1784044799,
  });
});

test('schedules the next 18:00 Shanghai run', () => {
  assert.equal(millisecondsUntilNextRun(new Date('2026-07-14T09:00:00Z'), 18), 3_600_000);
  assert.equal(millisecondsUntilNextRun(new Date('2026-07-14T11:00:00Z'), 18), 82_800_000);
});
