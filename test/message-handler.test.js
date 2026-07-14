import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeduplicator } from '../src/deduplicator.js';
import { createMessageHandler } from '../src/message-handler.js';

function event(overrides = {}) {
  return { message: { message_id: 'om_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"你好"}', mentions: [], ...overrides }, sender: { sender_type: 'user' } };
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
