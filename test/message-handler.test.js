import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeduplicator } from '../src/deduplicator.js';
import { createMessageHandler, createTaskConfirmationActionHandler } from '../src/message-handler.js';

function event(overrides = {}) {
  return { message: { message_id: 'om_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"你好"}', mentions: [], ...overrides }, sender: { sender_type: 'user', sender_id: { open_id: 'ou_actor' } } };
}

test('answers a valid message once', async () => {
  const calls = [];
  const handler = createMessageHandler({
    assistant: { answer: async (prompt) => { calls.push(prompt); return '您好'; } },
    reply: async (messageId, text) => calls.push([messageId, text]),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });
  await handler(event());
  await handler(event());
  assert.deepEqual(calls, ['你好', ['om_1', '您好']]);
});

test('ignores bot and non-triggering messages', async () => {
  let calls = 0;
  const handler = createMessageHandler({
    assistant: { answer: async () => { calls += 1; return 'x'; } },
    reply: async () => { calls += 1; }, deduplicator: createDeduplicator(), logger: { error() {} },
  });
  await handler({ ...event(), sender: { sender_type: 'app' } });
  await handler(event({ message_id: 'om_2', chat_type: 'group', mentions: [] }));
  assert.equal(calls, 0);
});

test('replies with a safe message when the assistant fails', async () => {
  const replies = [];
  const handler = createMessageHandler({
    assistant: { answer: async () => { throw new Error('secret upstream detail'); } },
    reply: async (_messageId, text) => replies.push(text), deduplicator: createDeduplicator(), logger: { error() {} },
  });
  await handler(event());
  assert.deepEqual(replies, ['暂时无法回答，请稍后重试']);
});

test('routes a parsed task intent without calling the RAG assistant', async () => {
  const calls = [];
  const handler = createMessageHandler({
    taskIntent: { async parse(prompt) { calls.push(['parse', prompt]); return { operation: 'query_tasks', selector: {}, fields: {} }; } },
    taskService: { async prepare(intent, actorOpenId) { calls.push(['prepare', intent, actorOpenId]); return { kind: 'result', text: '你有 2 个任务' }; } },
    assistant: { async answer() { calls.push(['answer']); return '不应调用'; } },
    reply: async (messageId, text) => calls.push(['reply', messageId, text]),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });

  await handler(event());

  assert.deepEqual(calls, [
    ['parse', '你好'],
    ['prepare', { operation: 'query_tasks', selector: {}, fields: {} }, 'ou_actor'],
    ['reply', 'om_1', '你有 2 个任务'],
  ]);
});

test('replies with a task confirmation card when card replies are available', async () => {
  const calls = [];
  const handler = createMessageHandler({
    taskIntent: { async parse() { return { operation: 'update_task', selector: { name: '喝水' }, fields: { 状态: '阻塞中' } }; } },
    taskService: { async prepare() { return { kind: 'confirmation', confirmationId: 'cfm-1', preview: { after: { 任务名: '喝水', 状态: '阻塞中' } } }; } },
    assistant: { async answer() { return 'unused'; } },
    reply: async () => calls.push(['text']),
    replyCard: async (messageId, card) => calls.push(['card', messageId, card]),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });
  await handler(event({ content: '{"text":"帮我修改任务喝水 状态为阻塞"}' }));
  assert.equal(calls[0][0], 'card');
  assert.equal(calls[0][1], 'om_1');
  assert.match(JSON.stringify(calls[0][2]), /confirm_task_change/);
});

test('handles task confirmation card callbacks for the clicking actor', async () => {
  const calls = [];
  const handle = createTaskConfirmationActionHandler({
    taskService: { async confirm(id, actor) { calls.push([id, actor]); return { kind: 'result', text: '操作成功。' }; } },
    messenger: { async updateCard(messageId, card) { calls.push(['updateCard', messageId, card]); } },
  });
  const result = await handle({
    operator: { open_id: 'ou_actor' },
    context: { open_message_id: 'om_card' },
    action: { value: { action: 'confirm_task_change', confirmationId: 'cfm-1' } },
  });
  assert.deepEqual(calls[0], ['cfm-1', 'ou_actor']);
  assert.equal(calls[1][0], 'updateCard');
  assert.equal(calls[1][1], 'om_card');
  assert.equal(calls[1][2].header.template, 'green');
  assert.equal(result, undefined);
  assert.doesNotMatch(JSON.stringify(calls[1][2]), /button|callback/);
});

test('schedules form result update after the card callback can return', async () => {
  const calls = [];
  const scheduled = [];
  const taskService = {
    async prepare() { return { kind: 'confirmation', confirmationId: 'cfm-1' }; },
    async confirm() { calls.push('confirm'); return { kind: 'result', text: '操作成功。' }; },
  };
  const handle = createTaskConfirmationActionHandler({
    taskService,
    messenger: { async updateCardByToken(token) { calls.push(['update', token]); } },
    schedule(fn, delay) { scheduled.push([fn, delay]); },
    logger: { error() {} },
  });
  const result = await handle({
    token: 'token-1', operator: { open_id: 'ou_actor' }, context: { open_message_id: 'om_1' },
    action: { name: 'submit_edit__rec1', form_value: { task_name: '喝水', status: '进行中', progress: '20' } },
  });
  assert.equal(result, undefined);
  assert.deepEqual(calls, ['confirm']);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0][1], 100);
  await scheduled[0][0]();
  assert.deepEqual(calls, ['confirm', ['update', 'token-1']]);
});

test('keeps the existing RAG route when task parsing returns null', async () => {
  const calls = [];
  const handler = createMessageHandler({
    taskIntent: { async parse(prompt) { calls.push(['parse', prompt]); return null; } },
    taskService: { async prepare() { calls.push(['prepare']); } },
    assistant: { async answer(prompt, actorOpenId) { calls.push(['answer', prompt, actorOpenId]); return 'RAG 回复'; } },
    reply: async (messageId, text) => calls.push(['reply', messageId, text]),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });

  await handler(event());

  assert.deepEqual(calls, [
    ['parse', '你好'],
    ['answer', '你好', 'ou_actor'],
    ['reply', 'om_1', 'RAG 回复'],
  ]);
});

test('shows a task create card instead of falling back to RAG for empty create requests', async () => {
  const calls = [];
  const handler = createMessageHandler({
    taskIntent: { async parse(prompt) { calls.push(['parse', prompt]); return { operation: 'create_task', selector: {}, fields: {} }; } },
    taskService: { async prepare(intent, actorOpenId) {
      calls.push(['prepare', intent, actorOpenId]);
      return { kind: 'need_input', field: '任务名', text: '请提供任务名。' };
    } },
    assistant: { async answer() { calls.push(['answer']); return '不应调用'; } },
    reply: async (messageId, text) => calls.push(['reply', messageId, text]),
    replyCard: async (messageId, card) => calls.push(['card', messageId, card]),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });

  await handler(event({ content: '{"text":"帮我建立一个任务"}' }));

  assert.deepEqual(calls.slice(0, 2), [
    ['parse', '帮我建立一个任务'],
    ['prepare', { operation: 'create_task', selector: {}, fields: {} }, 'ou_actor'],
  ]);
  assert.equal(calls[2][0], 'card');
  assert.equal(calls[2][1], 'om_1');
  assert.match(JSON.stringify(calls[2][2]), /submit_create_task/);
});

test('shows editable task choices instead of falling back to RAG for unspecified edit requests', async () => {
  const calls = [];
  const tasks = [{ recordId: 'rec1', name: '喝水', status: '进行中', priority: 'P1', progress: 20 }];
  const handler = createMessageHandler({
    taskIntent: { async parse(prompt) { calls.push(['parse', prompt]); return { operation: 'edit_task_form', selector: { ownerOpenId: 'me' }, fields: {} }; } },
    taskService: { async prepare(intent, actorOpenId) {
      calls.push(['prepare', intent, actorOpenId]);
      return { kind: 'edit_task_picker', tasks };
    } },
    assistant: { async answer() { calls.push(['answer']); return '不应调用'; } },
    reply: async (messageId, text) => calls.push(['reply', messageId, text]),
    replyCard: async (messageId, card) => calls.push(['card', messageId, card]),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });

  await handler(event({ content: '{"text":"帮我修改任务"}' }));

  assert.deepEqual(calls.slice(0, 2), [
    ['parse', '帮我修改任务'],
    ['prepare', { operation: 'edit_task_form', selector: { ownerOpenId: 'me' }, fields: {} }, 'ou_actor'],
  ]);
  assert.equal(calls[2][0], 'card');
  assert.match(JSON.stringify(calls[2][2]), /edit_task/);
  assert.doesNotMatch(JSON.stringify(calls), /不应调用/);
});

test('turns an edit-task selection into the existing edit card', async () => {
  const calls = [];
  const handle = createTaskConfirmationActionHandler({
    taskService: { async prepare(intent, actorOpenId) {
      calls.push(['prepare', intent, actorOpenId]);
      return { kind: 'edit_form', task: { recordId: 'rec1', name: '喝水', status: '进行中' } };
    } },
    messenger: { async updateCard(messageId, card) { calls.push(['update', messageId, card]); } },
  });

  const result = await handle({
    operator: { open_id: 'ou_actor' },
    context: { open_message_id: 'om_card' },
    action: { value: { action: 'edit_task', taskId: 'rec1' } },
  });

  assert.deepEqual(calls[0], [
    'prepare',
    { operation: 'edit_task_form', selector: { recordId: 'rec1', ownerOpenId: 'ou_actor' }, fields: {} },
    'ou_actor',
  ]);
  assert.equal(calls[1][0], 'update');
  assert.equal(calls[1][1], 'om_card');
  assert.match(JSON.stringify(calls[1][2]), /submit_edit__rec1/);
  assert.equal(result, undefined);
});

test('keeps delegated owner context when asking for a task name', async () => {
  const calls = [];
  const handler = createMessageHandler({
    taskIntent: { async parse() { return { operation: 'create_task', selector: {}, fields: { 负责人: '田嘉国' } }; } },
    taskService: { async prepare() { return { kind: 'need_input', field: '任务名', text: '请提供任务名。' }; } },
    assistant: { async answer() { return '不应调用'; } },
    reply: async () => calls.push(['text']),
    replyCard: async (messageId, card) => calls.push(['card', messageId, card]),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });

  await handler(event({ content: '{"text":"帮田嘉国创建一个任务"}' }));

  assert.equal(calls[0][0], 'card');
  assert.match(JSON.stringify(calls[0][2]), /负责人：田嘉国/);
});

test('turns a create form submission into a confirmation card', async () => {
  const calls = [];
  const handle = createTaskConfirmationActionHandler({
    taskService: { async prepare(intent, actorOpenId) {
      calls.push(['prepare', intent, actorOpenId]);
      return { kind: 'confirmation', confirmationId: 'cfm-1', preview: { after: { 任务名: '喝水' } } };
    } },
    messenger: { async updateCardByToken(token, card) { calls.push(['update', token, card]); } },
    schedule(fn, delay) { calls.push(['schedule', delay]); return fn(); },
    logger: { error() {} },
  });

  const result = await handle({
    token: 'token-1', operator: { open_id: 'ou_actor' }, context: { open_message_id: 'om_1' },
    action: { name: 'submit_create_task', form_value: { task_name: '喝水', priority: 'P1' } },
  });

  assert.equal(result, undefined);
  assert.deepEqual(calls[0], [
    'prepare',
    { operation: 'create_task', selector: {}, fields: { 任务名: '喝水', 优先级: 'P1' } },
    'ou_actor',
  ]);
  assert.deepEqual(calls[1], ['schedule', 100]);
  assert.equal(calls[2][0], 'update');
  assert.equal(calls[2][1], 'token-1');
  assert.match(JSON.stringify(calls[2][2]), /confirm_task_change/);
});

test('turns a delegated create form submission into an owner-specific confirmation card', async () => {
  const calls = [];
  const handle = createTaskConfirmationActionHandler({
    taskService: { async prepare(intent, actorOpenId) {
      calls.push(['prepare', intent, actorOpenId]);
      return { kind: 'confirmation', confirmationId: 'cfm-1', preview: { after: { 任务名: '喝水', 负责人: 'ou_tian' } } };
    } },
    messenger: {},
  });

  const card = await handle({
    operator: { open_id: 'ou_actor' },
    action: { name: 'submit_create_task__owner_%E7%94%B0%E5%98%89%E5%9B%BD', form_value: { task_name: '喝水' } },
  });

  assert.deepEqual(calls[0], [
    'prepare',
    { operation: 'create_task', selector: {}, fields: { 负责人: '田嘉国', 任务名: '喝水' } },
    'ou_actor',
  ]);
  assert.match(JSON.stringify(card), /confirm_task_change/);
});

test('routes an explicit time-range summary before task parsing or RAG', async () => {
  const calls = [];
  const handler = createMessageHandler({
    chatSummaryRequest: { async handle(prompt, actorOpenId) {
      calls.push(['summary', prompt, actorOpenId]);
      return { kind: 'result', text: '聊天摘要' };
    } },
    taskIntent: { async parse() { calls.push(['parse']); return null; } },
    taskService: {},
    assistant: { async answer() { calls.push(['answer']); return 'unused'; } },
    reply: async (messageId, text) => calls.push(['reply', messageId, text]),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });

  await handler(event({ content: '{"text":"总结 2026-07-01 到 2026-07-15 的聊天"}' }));

  assert.deepEqual(calls, [
    ['summary', '总结 2026-07-01 到 2026-07-15 的聊天', 'ou_actor'],
    ['reply', 'om_1', '聊天摘要'],
  ]);
});

test('replies immediately with a processing card and updates it after chat summary completes', async () => {
  const calls = [];
  let scheduled;
  const handler = createMessageHandler({
    chatSummaryRequest: { parse(prompt, actorOpenId) {
      calls.push(['summary', prompt, actorOpenId]);
      return {
        kind: 'processing',
        title: '聊天总结',
        text: '正在总结今天的聊天，请稍候。',
        async run() { calls.push(['run']); return { kind: 'result', text: '{"important":["完成"]}' }; },
      };
    } },
    taskIntent: { async parse() { calls.push(['parse']); return null; } },
    assistant: { async answer() { calls.push(['answer']); return 'unused'; } },
    replyCard: async (messageId, card) => { calls.push(['card', messageId, card]); return { message_id: 'om_card' }; },
    reply: async () => calls.push(['text']),
    messenger: { async updateCard(messageId, card) { calls.push(['update', messageId, card]); } },
    schedule(fn, delay) { scheduled = fn; calls.push(['schedule', delay]); },
    deduplicator: createDeduplicator(), logger: { error() {} },
  });

  await handler(event({ content: '{"text":"总结今天的聊天"}' }));
  assert.equal(calls[0][0], 'summary');
  assert.equal(calls[1][0], 'card');
  assert.match(JSON.stringify(calls[1][2]), /正在总结/);
  assert.deepEqual(calls[2], ['schedule', 100]);

  await scheduled();

  assert.deepEqual(calls[3], ['run']);
  assert.equal(calls[4][0], 'update');
  assert.equal(calls[4][1], 'om_card');
  assert.match(JSON.stringify(calls[4][2]), /聊天总结完成/);
});

test('shows the confirmation id and text fallback commands', async () => {
  const replies = [];
  const handler = createMessageHandler({
    taskIntent: { async parse() { return { operation: 'delete_task' }; } },
    taskService: { async prepare() { return { kind: 'confirmation', confirmationId: 'cfm-1', preview: { operation: 'delete_task' } }; } },
    assistant: { async answer() { return 'unused'; } },
    reply: async (_messageId, text) => replies.push(text),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });

  await handler(event());

  assert.match(replies[0], /cfm-1/);
  assert.match(replies[0], /确认 cfm-1/);
  assert.match(replies[0], /取消 cfm-1/);
});

test('routes text confirmation directly to the task service for the sender', async () => {
  const calls = [];
  const handler = createMessageHandler({
    taskIntent: { async parse() { calls.push(['parse']); return null; } },
    taskService: { async confirm(id, actorOpenId) { calls.push(['confirm', id, actorOpenId]); return { kind: 'result', text: '操作成功。' }; } },
    assistant: { async answer() { calls.push(['answer']); return 'unused'; } },
    reply: async (messageId, text) => calls.push(['reply', messageId, text]),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });

  await handler(event({ content: '{"text":"  确认 cfm-1  "}' }));

  assert.deepEqual(calls, [
    ['confirm', 'cfm-1', 'ou_actor'],
    ['reply', 'om_1', '操作成功。'],
  ]);
});

test('routes text cancellation directly to the task service for the sender', async () => {
  const calls = [];
  const handler = createMessageHandler({
    taskIntent: { async parse() { calls.push(['parse']); return null; } },
    taskService: { async cancel(id, actorOpenId) { calls.push(['cancel', id, actorOpenId]); return { kind: 'result', text: '操作已取消。' }; } },
    assistant: { async answer() { calls.push(['answer']); return 'unused'; } },
    reply: async (messageId, text) => calls.push(['reply', messageId, text]),
    deduplicator: createDeduplicator(), logger: { error() {} },
  });

  await handler(event({ content: '{"text":"取消 cfm-2"}' }));

  assert.deepEqual(calls, [
    ['cancel', 'cfm-2', 'ou_actor'],
    ['reply', 'om_1', '操作已取消。'],
  ]);
});
