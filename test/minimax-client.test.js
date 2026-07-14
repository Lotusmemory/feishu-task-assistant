import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiniMaxClient } from '../src/minimax-client.js';

const options = { apiKey: 'key', baseUrl: 'https://example.test/v1', model: 'MiniMax-M3' };

test('returns final answer and sends no conversation history', async () => {
  let request;
  const client = createMiniMaxClient({ ...options, fetchImpl: async (url, init) => {
    request = { url, init };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '最终回答' } }] }) };
  }});
  assert.equal(await client.answer('你好'), '最终回答');
  assert.equal(request.url, 'https://example.test/v1/chat/completions');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'MiniMax-M3');
  assert.deepEqual(body.messages.map(({ role }) => role), ['system', 'user']);
  assert.equal(request.init.headers.Authorization, 'Bearer key');
});

test('normalizes HTTP and empty-answer failures', async () => {
  const httpClient = createMiniMaxClient({ ...options, fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(() => httpClient.answer('x'), /MiniMax request failed/);
  const emptyClient = createMiniMaxClient({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }) });
  await assert.rejects(() => emptyClient.answer('x'), /MiniMax request failed/);
});

test('completes with exactly the supplied system and user messages', async () => {
  let body;
  const client = createMiniMaxClient({ ...options, fetchImpl: async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '  结果  ' } }] }) };
  }});

  assert.equal(await client.completeWithSystem('系统', '输入'), '结果');
  assert.deepEqual(body.messages, [
    { role: 'system', content: '系统' },
    { role: 'user', content: '输入' },
  ]);
});

test('normalizes controlled completion failures', async () => {
  const client = createMiniMaxClient({ ...options, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(() => client.completeWithSystem('系统', '输入'), /MiniMax request failed/);
});

test('sends approved knowledge with strict grounding instructions', async () => {
  let body;
  const client = createMiniMaxClient({ ...options, fetchImpl: async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '回答' } }] }) };
  }});
  await client.answerWithKnowledge('怎么休年假', [{
    answerText: '提前申请', metadata: { title: '年假制度', updatedAt: '2026-07-13', sourceUrl: 'https://example.test' },
  }]);
  assert.match(body.messages[0].content, /只能依据.*不得编造/);
  assert.match(body.messages[1].content, /年假制度.*提前申请/s);
  assert.doesNotMatch(body.messages[1].content, /score|审核人|提交人/);
});
