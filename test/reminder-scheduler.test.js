import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore } from '../src/json-store.js';
import { createConfirmationStore } from '../src/confirmation-store.js';
import { createReminderScheduler } from '../src/reminder-scheduler.js';
import { createTaskService } from '../src/task-service.js';

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
      async updateCardByToken(token, card) { sent.push({ type: 'update', token, card }); },
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
  const state = await dependencies.store.read();
  assert.deepEqual(state.reminderRuns, {
      '2026-07-14': {
        owner: { 'ou_a:1/1': 'sent' },
        leader: { 'ou_l:1/1': 'sent' },
        consent: { ou_a: 'sent' },
      },
  });
  assert.deepEqual(state.confirmations, {});
  assert.equal(state.reminderSnapshots['2026-07-14'].owner.ou_a.length, 1);
  assert.equal(state.reminderSnapshots['2026-07-14'].leader.ou_l.length, 1);
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
  const state = await dependencies.store.read();
  assert.deepEqual(state.reminderRuns, {
      '2026-07-14': {
        owner: {}, leader: { 'ou_l:1/1': 'sent' }, consent: { ou_a: 'sent' },
      },
  });
  assert.deepEqual(state.confirmations, {});
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

test('logs a whole-run timer failure without rejecting and still schedules the next run', async () => {
  const { dependencies, timers, errors } = await fixture({
    reminderService: { async buildPlan() { throw new Error('plan failed'); } },
  });
  createReminderScheduler(dependencies).start();

  await assert.doesNotReject(() => timers[0].callback());
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /run failed/i);
  assert.equal(timers.length, 2);
});

test('confirms complete while continue leaves the task unchanged', async () => {
  const calls = [];
  const { dependencies, sent } = await fixture({
    base: { async getTask() { calls.push(['get']); return { ...task, ownerOpenId: 'ou_a' }; } },
    taskService: {
      async prepare(intent, actorOpenId) { calls.push(['prepare', intent, actorOpenId]); return { kind: 'confirmation', confirmationId: 'cfm-1' }; },
      async confirm(id, actorOpenId) { calls.push(['confirm', id, actorOpenId]); return { kind: 'result', text: '操作成功。' }; },
    },
  });
  const scheduler = createReminderScheduler(dependencies);
  const ownerEvent = {
    operator: { open_id: 'ou_a' },
    context: { open_message_id: 'om_1' },
    action: { value: { action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
  };

  assert.deepEqual(await scheduler.handleCardAction({ ...ownerEvent, token: 'token-complete' }), { kind: 'result', text: '操作成功。' });
  assert.deepEqual(await scheduler.handleCardAction(ownerEvent), { kind: 'ignored', reason: 'duplicate' });
  assert.deepEqual(calls, [
    ['get'],
    ['prepare', { operation: 'complete_task', selector: { recordId: 'rec1' }, fields: {} }, 'ou_a'],
    ['get'],
    ['confirm', 'cfm-1', 'ou_a'],
    ['get'],
  ]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].type, 'update');
  assert.deepEqual(sent[0].token, 'token-complete');
  assert.match(JSON.stringify(sent[0].card), /任务操作已确认/);

  calls.length = 0;
  assert.deepEqual(await scheduler.handleCardAction({
    ...ownerEvent,
    context: { open_message_id: 'om_continue' },
    action: { value: { ...ownerEvent.action.value, action: 'continue' } },
  }), { kind: 'result', text: '已继续处理，任务状态未修改。' });
  assert.deepEqual(calls, [['get']]);
});

test('rejects non-owners without preparing, confirming, or messaging', async () => {
  const calls = [];
  const { dependencies } = await fixture({
    base: { async getTask() { calls.push('get'); return { ...task, ownerOpenId: 'ou_a' }; } },
    taskService: { async prepare() { calls.push('prepare'); }, async confirm() { calls.push('confirm'); } },
    messenger: { async sendText() { calls.push('sendText'); } },
  });
  const result = await createReminderScheduler(dependencies).handleCardAction({
    operator: { open_id: 'ou_l' }, context: { open_message_id: 'om_2' },
    action: { value: { action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
  });

  assert.deepEqual(result, { kind: 'ignored', reason: 'forbidden' });
  assert.deepEqual(calls, ['get']);
});

test('rechecks ownership before confirm and releases the callback claim when it changed', async () => {
  let reads = 0;
  const calls = [];
  const { dependencies } = await fixture({
    base: { async getTask() { reads += 1; return { ...task, ownerOpenId: reads === 1 ? 'ou_a' : 'ou_next' }; } },
    taskService: {
      async prepare() { calls.push('prepare'); return { kind: 'confirmation', confirmationId: 'cfm-1' }; },
      async confirm() { calls.push('confirm'); },
    },
  });
  const event = {
    operator: { open_id: 'ou_a' }, context: { open_message_id: 'om_changed' },
    action: { value: { action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
  };

  assert.deepEqual(await createReminderScheduler(dependencies).handleCardAction(event), { kind: 'ignored', reason: 'forbidden' });
  assert.deepEqual(calls, ['prepare']);
  assert.deepEqual((await dependencies.store.read()).confirmations, {});
});

test('sends reason forms for block and postpone without writing immediately', async () => {
  const { dependencies, sent } = await fixture({
    base: { async getTask() { return { ...task, ownerOpenId: 'ou_a' }; } },
    taskService: { async prepare() { assert.fail('must not prepare before reason submit'); } },
  });
  const scheduler = createReminderScheduler(dependencies);

  for (const action of ['block', 'postpone']) {
    await scheduler.handleCardAction({
      operator: { open_id: 'ou_a' }, context: { open_message_id: `om_${action}` },
      action: { value: { action, taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
    });
  }

  assert.equal(sent.length, 2);
  assert.equal(sent.every(({ type }) => type === 'card'), true);
  assert.match(JSON.stringify(sent[0].card), /submit_reason__block__rec1/);
  assert.match(JSON.stringify(sent[1].card), /submit_reason__postpone__rec1/);
  assert.match(sent[0].uuid, /om_block.*block.*rec1/);
  assert.match(sent[1].uuid, /om_postpone.*postpone.*rec1/);
});

test('submitting a reason writes blocked or postponed status and updates the form card', async () => {
  const calls = [];
  const { dependencies, sent } = await fixture({
    base: { async getTask() { return { ...task, ownerOpenId: 'ou_a' }; } },
    taskService: {
      async prepare(intent, actor) { calls.push(['prepare', intent, actor]); return { kind: 'confirmation', confirmationId: `cfm-${calls.length}` }; },
      async confirm(id, actor) { calls.push(['confirm', id, actor]); return { kind: 'result', text: '操作成功。' }; },
    },
  });
  const scheduler = createReminderScheduler(dependencies);

  for (const action of ['block', 'postpone']) {
    await scheduler.handleCardAction({
      operator: { open_id: 'ou_a' }, token: `token-${action}`,
      action: { name: `submit_reason__${action}__rec1`, form_value: { reason: '等待接口' } },
    });
  }

  assert.deepEqual(calls.filter(([type]) => type === 'prepare').map(([, intent]) => intent.fields), [
    { 状态: '阻塞中', 阻塞原因: '等待接口' },
    { 状态: '已延期', 阻塞原因: '等待接口' },
  ]);
  assert.equal(calls.filter(([type]) => type === 'confirm').length, 2);
  assert.deepEqual(sent.filter(({ type }) => type === 'update').map(({ token }) => token), ['token-block', 'token-postpone']);
});

test('releases a failed callback claim so the same event can retry', async () => {
  let confirmations = 0;
  const { dependencies } = await fixture({
    base: { async getTask() { return { ...task, ownerOpenId: 'ou_a' }; } },
    taskService: {
      async prepare() { return { kind: 'confirmation', confirmationId: 'cfm-1' }; },
      async confirm() { confirmations += 1; if (confirmations === 1) throw new Error('transient'); return { kind: 'result' }; },
    },
  });
  const event = {
    operator: { open_id: 'ou_a' }, context: { open_message_id: 'om_retry' },
    action: { value: { action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
  };

  const scheduler = createReminderScheduler(dependencies);
  await assert.rejects(() => scheduler.handleCardAction(event), /transient/);
  assert.deepEqual(await scheduler.handleCardAction(event), { kind: 'result' });
  assert.equal(confirmations, 2);
});

test('uses the real task service to write complete while other buttons do not write before form submit', async () => {
  const writes = [];
  const { dependencies, sent } = await fixture();
  const base = {
    async getTask() { return { ...task, ownerOpenId: 'ou_a' }; },
    async searchTasks() { return [{ ...task, ownerOpenId: 'ou_a' }]; },
    async updateTask(recordId, fields) { writes.push([recordId, fields]); },
  };
  let sequence = 0;
  dependencies.base = base;
  dependencies.taskService = createTaskService({
    base,
    members: { async resolveByName() { return []; } },
    confirmations: createConfirmationStore({
      store: dependencies.store,
      ttlMs: 60_000,
      clock: () => NOW.getTime(),
      idFactory: () => `cfm-${++sequence}`,
    }),
    clock: () => NOW.getTime(),
  });
  const scheduler = createReminderScheduler(dependencies);

  for (const action of ['complete', 'continue', 'block', 'postpone']) {
    await scheduler.handleCardAction({
      operator: { open_id: 'ou_a' }, context: { open_message_id: `om_real_${action}` },
      action: { value: { action, taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
    });
  }

  assert.deepEqual(writes, [
    ['rec1', { 状态: '已完成', 进度: 100, 完成时间: NOW.getTime() }],
  ]);
  assert.equal(sent.filter(({ type }) => type === 'card').length, 2);
});

test('persists split cards independently and restart retries only the failed part', async () => {
  const tasks = Array.from({ length: 17 }, (_, index) => ({ ...task, recordId: `rec${index}`, name: `任务${index}` }));
  const attempts = [];
  const { dependencies, path } = await fixture({
    reminderService: { async buildPlan() { return { owners: [{ openId: 'ou_a', tasks }], leaders: [], warnings: [] }; } },
    messenger: { async sendCard(openId, card, uuid) {
      attempts.push(uuid);
      if (uuid.endsWith(':1/2') && attempts.filter((item) => item === uuid).length === 1) throw new Error('part failed');
    } },
  });
  await createReminderScheduler(dependencies).runNow(NOW);
  await createReminderScheduler({
    ...dependencies,
    store: createJsonStore({ path, defaultValue: { reminderRuns: {}, confirmations: {} } }),
  }).runNow(NOW);

  assert.equal(attempts.filter((uuid) => uuid === 'owner:2026-07-14:ou_a:1/2').length, 2);
  assert.equal(attempts.filter((uuid) => uuid === 'owner:2026-07-14:ou_a:2/2').length, 1);
  assert.equal(attempts.filter((uuid) => uuid.startsWith('consent:')).length, 1);
  assert.deepEqual((await dependencies.store.read()).reminderRuns['2026-07-14'].owner, {
    'ou_a:1/2': 'sent', 'ou_a:2/2': 'sent',
  });
});

test('isolates oversized recipient card construction and continues later recipients and consent', async () => {
  const oversized = { ...task, recordId: 'rec_big', blocker: '阻'.repeat(30_000) };
  const sent = [];
  const { dependencies } = await fixture({
    reminderService: { async buildPlan() {
      return {
        owners: [
          { openId: 'ou_big', tasks: [oversized] },
          { openId: 'ou_good', tasks: [{ ...task, recordId: 'rec_good' }] },
        ],
        leaders: [{
          openId: 'ou_leader',
          owners: [{ openId: 'ou_good', name: '正常负责人', tasks: [{ ...task, recordId: 'rec_good' }] }],
        }],
        warnings: [],
      };
    } },
    messenger: { async sendCard(openId, card, uuid) { sent.push({ openId, card, uuid }); } },
  });

  const result = await createReminderScheduler(dependencies).runNow(NOW);

  assert.deepEqual(result.recipientErrors, []);
  assert.deepEqual(sent.map(({ openId }) => openId), ['ou_big', 'ou_good', 'ou_leader', 'ou_big', 'ou_good']);
  const bigCard = sent.find(({ openId, uuid }) => openId === 'ou_big' && uuid.startsWith('owner:')).card;
  assert.ok(Buffer.byteLength(JSON.stringify(bigCard), 'utf8') <= 28 * 1024);
  assert.match(JSON.stringify(bigCard), /…/);
  assert.doesNotMatch(JSON.stringify(bigCard), new RegExp(`阻{${30_000}}`));
});

test('records a recipient card build failure and continues other recipients', async () => {
  const sent = [];
  const { dependencies } = await fixture({
    reminderService: { async buildPlan() {
      return {
        owners: [
          { openId: 'ou_bad', tasks: [{ ...task, recordId: 'r'.repeat(30_000) }] },
          { openId: 'ou_good', tasks: [{ ...task, recordId: 'rec_good' }] },
        ],
        leaders: [{
          openId: 'ou_leader',
          owners: [{ openId: 'ou_good', name: '正常负责人', tasks: [{ ...task, recordId: 'rec_good' }] }],
        }],
        warnings: [],
      };
    } },
    messenger: { async sendCard(openId, card, uuid) { sent.push({ openId, uuid }); } },
  });

  const result = await createReminderScheduler(dependencies).runNow(NOW);

  assert.equal(result.recipientErrors.length, 1);
  assert.deepEqual(result.recipientErrors[0].category, 'owner');
  assert.deepEqual(result.recipientErrors[0].openId, 'ou_bad');
  assert.deepEqual(sent.map(({ openId }) => openId), ['ou_good', 'ou_leader', 'ou_bad', 'ou_good']);
});

test('restarts from the first daily snapshot even when the plan later changes part count and order', async () => {
  const originalTasks = Array.from({ length: 17 }, (_, index) => ({
    ...task, recordId: `original-${index}`, name: `原任务${index}`,
  }));
  let changed = false;
  const attempts = [];
  const { dependencies, path } = await fixture({
    reminderService: { async buildPlan() {
      return {
        owners: [{
          openId: 'ou_a',
          tasks: changed ? [{ ...task, recordId: 'new-only', name: '新增任务' }] : originalTasks,
        }],
        leaders: [], warnings: [],
      };
    } },
    messenger: { async sendCard(openId, card, uuid) {
      attempts.push({ uuid, serialized: JSON.stringify(card) });
      if (uuid.endsWith(':2/2') && attempts.filter((item) => item.uuid === uuid).length === 1) {
        throw new Error('second part failed');
      }
    } },
  });
  await createReminderScheduler(dependencies).runNow(NOW);
  changed = true;
  await createReminderScheduler({
    ...dependencies,
    store: createJsonStore({ path, defaultValue: { reminderRuns: {}, confirmations: {} } }),
  }).runNow(NOW);

  const firstPart = attempts.filter(({ uuid }) => uuid === 'owner:2026-07-14:ou_a:1/2');
  const secondPart = attempts.filter(({ uuid }) => uuid === 'owner:2026-07-14:ou_a:2/2');
  assert.equal(firstPart.length, 1);
  assert.equal(secondPart.length, 2);
  assert.equal(secondPart[1].serialized, secondPart[0].serialized);
  assert.match(secondPart[1].serialized, /original-/);
  assert.doesNotMatch(secondPart[1].serialized, /new-only|新增任务/);
  const snapshot = (await dependencies.store.read()).reminderSnapshots['2026-07-14'].owner.ou_a;
  assert.deepEqual(snapshot.map(({ key, uuid }) => ({ key, uuid })), [
    { key: 'ou_a:1/2', uuid: 'owner:2026-07-14:ou_a:1/2' },
    { key: 'ou_a:2/2', uuid: 'owner:2026-07-14:ou_a:2/2' },
  ]);
});

test('retries an existing snapshot even when its recipient disappeared from the latest plan', async () => {
  let removed = false;
  const attempts = [];
  const tasks = Array.from({ length: 17 }, (_, index) => ({ ...task, recordId: `removed-${index}` }));
  const { dependencies, path } = await fixture({
    reminderService: { async buildPlan() {
      return { owners: removed ? [] : [{ openId: 'ou_removed', tasks }], leaders: [], warnings: [] };
    } },
    messenger: { async sendCard(openId, card, uuid) {
      attempts.push(uuid);
      if (uuid.endsWith(':2/2') && attempts.filter((item) => item === uuid).length === 1) throw new Error('failed');
    } },
  });
  await createReminderScheduler(dependencies).runNow(NOW);
  removed = true;
  await createReminderScheduler({
    ...dependencies,
    store: createJsonStore({ path, defaultValue: { reminderRuns: {}, confirmations: {} } }),
  }).runNow(NOW);

  assert.equal(attempts.filter((uuid) => uuid === 'owner:2026-07-14:ou_removed:1/2').length, 1);
  assert.equal(attempts.filter((uuid) => uuid === 'owner:2026-07-14:ou_removed:2/2').length, 2);
});
