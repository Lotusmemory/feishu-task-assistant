import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../src/json-store.js';
import { createReminderScheduler } from '../src/reminder-scheduler.js';

const NOW = new Date('2026-07-14T09:00:00.000Z');
const task = {
  recordId: 'rec1', name: '首页设计', ownerOpenId: 'ou_a', ownerName: '张三',
  status: '进行中', deadline: 1_784_041_200_000, blocker: '', priority: 'P1',
};

async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'reminder-scheduler-'));
  const path = join(directory, 'state.json');
  const sent = [];
  const errors = [];
  const timers = [];
  const dependencies = {
    clock: () => NOW,
    setTimer(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    store: createJsonStore({ path, defaultValue: { reminderRuns: {}, confirmations: {} } }),
    reminderService: { async buildPlan(window) {
      assert.deepEqual(window, { startMs: 1_783_958_400_000, endMs: 1_784_044_799_999 });
      return {
        owners: [{ openId: 'ou_a', tasks: [task] }],
        leaders: [{ openId: 'ou_l', owners: [{ openId: 'ou_a', name: '张三', tasks: [task] }] }],
        warnings: [],
      };
    } },
    messenger: {
      async sendCard(openId, card, uuid) { sent.push({ type: 'card', openId, card, uuid }); },
      async sendText(openId, text, uuid) { sent.push({ type: 'text', openId, text, uuid }); },
    },
    onConsent: async () => {},
    logger: { error(...args) { errors.push(args); } },
    ...overrides,
  };
  return { dependencies, path, sent, errors, timers };
}

test('persists each successful recipient and does not resend after restart', async () => {
  const { dependencies, path, sent } = await fixture();
  await createReminderScheduler(dependencies).runNow(NOW);

  const restarted = createReminderScheduler({
    ...dependencies,
    store: createJsonStore({ path, defaultValue: { reminderRuns: {}, confirmations: {} } }),
  });
  await restarted.runNow(NOW);

  assert.equal(sent.length, 3);
  assert.deepEqual(await dependencies.store.read(), {
    reminderRuns: {
      '2026-07-14': {
        owner: { ou_a: 'sent' },
        leader: { ou_l: 'sent' },
        consent: { ou_a: 'sent' },
      },
    },
    confirmations: {},
  });
});

test('isolates recipient failures and only persists successful sends', async () => {
  const { dependencies, sent, errors } = await fixture({
    messenger: {
      async sendCard(openId, card, uuid) {
        if (openId === 'ou_a' && uuid.startsWith('owner:')) throw new Error('owner failed');
        sent.push({ type: 'card', openId, card, uuid });
      },
    },
  });
  await createReminderScheduler(dependencies).runNow(NOW);

  assert.deepEqual(sent.map(({ openId }) => openId), ['ou_l', 'ou_a']);
  assert.equal(errors.length, 1);
  assert.deepEqual(await dependencies.store.read(), {
    reminderRuns: {
      '2026-07-14': {
        owner: {}, leader: { ou_l: 'sent' }, consent: { ou_a: 'sent' },
      },
    },
    confirmations: {},
  });
});

test('uses one-shot timers and recalculates the next 18:00 run after execution', async () => {
  const { dependencies, timers } = await fixture();
  const scheduler = createReminderScheduler(dependencies);

  scheduler.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 3_600_000);
  await timers[0].callback();
  assert.equal(timers.length, 2);
  scheduler.stop();
  assert.equal(timers[1].cleared, true);
});

test('accepts an owner action once and rejects a stale or non-owner actor', async () => {
  const handled = [];
  const { dependencies } = await fixture({
    base: { async getTask() { return { ...task, ownerOpenId: 'ou_a' }; } },
    taskService: { async prepare(intent, actorOpenId) { handled.push({ intent, actorOpenId }); return { kind: 'confirmation' }; } },
  });
  const scheduler = createReminderScheduler(dependencies);
  const ownerEvent = {
    operator: { open_id: 'ou_a' },
    context: { open_message_id: 'om_1' },
    action: { value: { action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
  };

  assert.deepEqual(await scheduler.handleCardAction(ownerEvent), { kind: 'confirmation' });
  assert.deepEqual(await scheduler.handleCardAction(ownerEvent), { kind: 'ignored', reason: 'duplicate' });
  assert.deepEqual(await scheduler.handleCardAction({
    ...ownerEvent, operator: { open_id: 'ou_l' }, context: { open_message_id: 'om_2' },
  }), { kind: 'ignored', reason: 'forbidden' });
  assert.deepEqual(handled, [{
    intent: { operation: 'complete_task', selector: { recordId: 'rec1' }, fields: {} },
    actorOpenId: 'ou_a',
  }]);
});
