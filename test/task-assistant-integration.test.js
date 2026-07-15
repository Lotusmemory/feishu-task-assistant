import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmationStore } from '../src/confirmation-store.js';
import { createTaskService } from '../src/task-service.js';
import { createReminderService } from '../src/reminder-service.js';
import { createReminderScheduler } from '../src/reminder-scheduler.js';
import { createChatHistory, UserAuthorizationRequired } from '../src/chat-history.js';
import { createChatSummary } from '../src/chat-summary.js';

function memoryStore() {
  let state = { confirmations: {}, reminderRuns: {}, reminderSnapshots: {} };
  return {
    async read() { return structuredClone(state); },
    async update(mutator) { state = await mutator(structuredClone(state)); return structuredClone(state); },
  };
}

test('runs task confirmation, idempotent reminders and authorized chat draft confirmation end to end', async () => {
  const store = memoryStore();
  const writes = [];
  const tasks = [];
  const base = {
    async searchTasks() { return []; },
    async createTask(fields) { writes.push(structuredClone(fields)); return { record_id: `r${writes.length}` }; },
    async listDueTasks() { return tasks; },
    async listMembers() { return [
      { openId: 'ou_owner', name: '负责人', leaderOpenIds: ['ou_leader'] },
      { openId: 'ou_leader', name: 'Leader', leaderOpenIds: [] },
    ]; },
  };
  const members = {
    async refresh() { return base.listMembers(); },
    async leadersByOwner() { return ['ou_leader']; },
    async resolveByName() { return []; },
  };
  const confirmations = createConfirmationStore({ store, ttlMs: 86_400_000, idFactory: (() => {
    let id = 0; return () => `c${++id}`;
  })() });
  const taskService = createTaskService({ base, members, confirmations });

  const prepared = await taskService.prepare({
    operation: 'create_task', selector: {}, fields: { 任务名: '首页上线', 负责人: 'ou_owner' },
  }, 'ou_owner');
  assert.equal(writes.length, 0);
  await taskService.confirm(prepared.confirmationId, 'ou_owner');
  await taskService.confirm(prepared.confirmationId, 'ou_owner');
  assert.equal(writes.length, 1);

  tasks.push({ recordId: 'r1', name: '首页上线', ownerOpenId: 'ou_owner', ownerName: '负责人', status: '进行中', deadline: Date.now(), priority: 'P1' });
  const sent = [];
  const scheduler = createReminderScheduler({
    store,
    reminderService: createReminderService({ base, members }),
    messenger: { async sendCard(openId, card) { sent.push({ openId, card }); } },
  });
  const at = new Date('2026-07-15T18:00:00+08:00');
  await scheduler.runNow(at);
  await scheduler.runNow(at);
  assert.equal(sent.filter((item) => item.openId === 'ou_owner').length, 2); // owner + consent
  assert.equal(sent.filter((item) => item.openId === 'ou_leader').length, 1);
  assert.doesNotMatch(JSON.stringify(sent.find((item) => item.openId === 'ou_leader').card), /button|callback/);

  let searches = 0;
  const client = {
    domain: 'https://open.feishu.cn',
    async request(request) {
      searches += Number(request.url.endsWith('/search'));
      if (request.url.endsWith('/search')) return { code: 0, data: { items: [{ message_id: 'm1' }], has_more: false } };
      return { code: 0, data: { items: [{
        message_id: 'm1', chat_id: 'chat', create_time: '1', sender: { id: 'ou_other' },
        msg_type: 'text', body: { content: '{"text":"确认完成设计"}' },
      }] } };
    },
  };
  const window = { startIso: '2026-07-15T00:00:00+08:00', endIso: '2026-07-15T23:59:59+08:00' };
  await assert.rejects(
    createChatHistory({ client, vault: { async get() {} } }).listTextMessages('ou_owner', window),
    UserAuthorizationRequired,
  );
  assert.equal(searches, 0);
  const history = await createChatHistory({
    client, vault: { async get() { return { accessToken: 'user-token' }; } },
  }).listTextMessages('ou_owner', window);
  assert.equal(searches, 1);
  const summary = createChatSummary({
    minimax: { async completeWithSystem() { return JSON.stringify({
      summary: { important: [], decisions: [], todos: ['完成设计'], risks: [], people: [] },
      taskDrafts: [{ 任务名: '完成设计', 优先级: 'P1', 来源摘要: '讨论确认' }],
    }); } },
    taskService,
  });
  const result = await summary.summarize(history.messages, 'ou_owner');
  assert.equal(result.drafts[0].fields['负责人'], 'ou_owner');
  assert.equal(writes.length, 1);
  await taskService.confirm(result.drafts[0].draftId, 'ou_owner');
  assert.equal(writes.length, 2);
});
