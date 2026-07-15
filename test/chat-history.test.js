import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatHistory, UserAuthorizationRequired } from '../src/chat-history.js';

const window = { startIso: '2026-07-15T00:00:00+08:00', endIso: '2026-07-15T23:59:59+08:00' };

test('requires authorization before making a Feishu request', async () => {
  let requests = 0;
  const history = createChatHistory({
    client: { request() { requests += 1; } },
    vault: { async get() {} },
  });
  await assert.rejects(history.listTextMessages('ou_user', window), UserAuthorizationRequired);
  assert.equal(requests, 0);
});

test('reads all search pages, batches mget and returns only sorted text', async () => {
  const calls = [];
  const client = {
    domain: 'https://open.feishu.cn',
    request: async (request, options) => {
      calls.push({ request, options });
      if (request.url.endsWith('/search')) {
        return request.params.page_token
          ? { code: 0, data: { items: [{ message_id: 'm3' }], has_more: false } }
          : { code: 0, data: { items: [{ message_id: 'm2' }, { message_id: 'm1' }], has_more: true, page_token: 'next' } };
      }
      return { code: 0, data: { items: [
        { message_id: 'm2', chat_id: 'c1', create_time: '2', sender: { id: 'ou_b' }, msg_type: 'text', body: { content: '{"text":" 后发 "}' } },
        { message_id: 'm1', chat_id: 'c1', create_time: '1', sender: { id: 'ou_a' }, msg_type: 'text', body: { content: '{"text":"先发"}' } },
        { message_id: 'm3', chat_id: 'c1', create_time: '3', msg_type: 'image', body: { content: '{}' } },
      ] } };
    },
  };
  const history = createChatHistory({
    client,
    vault: { async get() { return { accessToken: 'secret', expiresAt: Date.now() + 3_600_000 }; } },
  });

  const result = await history.listTextMessages('ou_user', window);

  assert.deepEqual(result, { incomplete: false, messages: [
    { messageId: 'm1', chatId: 'c1', createTime: '1', senderId: 'ou_a', text: '先发' },
    { messageId: 'm2', chatId: 'c1', createTime: '2', senderId: 'ou_b', text: '后发' },
  ] });
  assert.equal(calls.filter(({ request }) => request.url.endsWith('/search')).length, 2);
  assert.equal(calls.filter(({ request }) => request.url.endsWith('/mget')).length, 1);
  assert.deepEqual(calls[0].request.data.filter.time_range, {
    start_time: window.startIso, end_time: window.endIso,
  });
  assert.equal(Object.getOwnPropertySymbols(calls[0].options.lark).map((key) => calls[0].options.lark[key])[0], 'secret');
  assert.doesNotMatch(JSON.stringify(calls[0].request), /secret/);
});

test('refreshes expiring tokens and deletes them when refresh fails', async () => {
  const saved = [];
  const client = {
    domain: 'https://open.feishu.cn',
    accessToken: { async refresh() { return { accessToken: 'new', refreshToken: 'new-refresh', expiresIn: 3600 }; } },
    async request(request, options) {
      assert.equal(Object.getOwnPropertySymbols(options.lark).map((key) => options.lark[key])[0], 'new');
      return { code: 0, data: { items: [], has_more: false } };
    },
  };
  const vault = {
    async get() { return { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1001, scope: 'scope' }; },
    async put(openId, token) { saved.push({ openId, token }); },
  };
  await createChatHistory({ client, vault, clock: () => 1000 }).listTextMessages('ou_user', window);
  assert.equal(saved[0].token.accessToken, 'new');

  let deleted = false;
  client.accessToken.refresh = async () => { throw new Error('refresh rejected: secret'); };
  vault.delete = async () => { deleted = true; };
  await assert.rejects(
    createChatHistory({ client, vault, clock: () => 1000 }).listTextMessages('ou_user', window),
    UserAuthorizationRequired,
  );
  assert.equal(deleted, true);
});

test('marks a capped search as incomplete', async () => {
  const history = createChatHistory({
    client: {
      domain: 'https://open.feishu.cn',
      async request() { return { code: 0, data: { items: [], has_more: true, page_token: 'more' } }; },
    },
    vault: { async get() { return { accessToken: 'secret' }; } },
    maxSearchPages: 1,
  });
  assert.equal((await history.listTextMessages('ou_user', window)).incomplete, true);
});
