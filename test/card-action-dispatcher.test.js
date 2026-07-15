import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardActionDispatcher } from '../src/card-action-dispatcher.js';

test('acknowledges a card callback before running reminder business logic', async () => {
  const calls = [];
  let deferred;
  const handler = createCardActionDispatcher({
    confirmationAction: async () => { calls.push('confirmation'); return { kind: 'ignored' }; },
    reminderAction: async () => { calls.push('reminder'); },
    defer: (callback) => { deferred = callback; },
  });

  assert.deepEqual(handler({ event_id: 'evt-1' }), {
    toast: { type: 'info', content: '已收到，正在处理' },
  });
  assert.deepEqual(calls, []);

  await deferred();
  assert.deepEqual(calls, ['confirmation', 'reminder']);
});

test('does not route a handled confirmation callback to reminder logic', async () => {
  const calls = [];
  let deferred;
  const handler = createCardActionDispatcher({
    confirmationAction: async () => { calls.push('confirmation'); return { kind: 'result' }; },
    reminderAction: async () => { calls.push('reminder'); },
    defer: (callback) => { deferred = callback; },
  });

  handler({ event_id: 'evt-2' });
  await deferred();

  assert.deepEqual(calls, ['confirmation']);
});

test('logs a deferred callback failure without rejecting the acknowledgement', async () => {
  const errors = [];
  let deferred;
  const handler = createCardActionDispatcher({
    confirmationAction: async () => { throw new Error('Base unavailable'); },
    reminderAction: async () => {},
    defer: (callback) => { deferred = callback; },
    logger: { error(...args) { errors.push(args); } },
  });

  assert.doesNotThrow(() => handler({ event_id: 'evt-3' }));
  await deferred();

  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /after acknowledgement/);
});
