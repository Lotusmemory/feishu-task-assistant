import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeduplicator } from '../src/deduplicator.js';
import { createMessageHandler } from '../src/message-handler.js';

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
