import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatSummaryRequest, parseChatSummaryRequest } from '../src/chat-summary-request.js';
import { UserAuthorizationRequired } from '../src/chat-history.js';

test('parses an inclusive Shanghai date range from a chat summary request', () => {
  assert.deepEqual(parseChatSummaryRequest('总结 2026年7月1日 到 2026-07-15 的聊天'), {
    startDate: '2026-07-01',
    endDate: '2026-07-15',
    window: {
      startIso: '2026-07-01T00:00:00+08:00',
      endIso: '2026-07-15T23:59:59+08:00',
    },
  });
});

test('parses a today chat summary request using Shanghai date', () => {
  assert.deepEqual(parseChatSummaryRequest('总结今天的聊天', new Date('2026-07-15T02:00:00Z')), {
    startDate: '2026-07-15',
    endDate: '2026-07-15',
    window: {
      startIso: '2026-07-15T00:00:00+08:00',
      endIso: '2026-07-15T23:59:59+08:00',
    },
  });
});

test('ignores unrelated prompts and explains invalid ranges', () => {
  assert.equal(parseChatSummaryRequest('总结这个方案'), null);
  assert.match(parseChatSummaryRequest('总结 2026-07-15 到 2026-07-01 的聊天').error, /开始日期/);
  assert.match(parseChatSummaryRequest('总结昨天的聊天').error, /开始和结束日期/);
  assert.match(parseChatSummaryRequest('总结 2026-02-30 到 2026-03-01 的聊天').error, /开始和结束日期/);
});

test('reads the requested window and returns its summary', async () => {
  const calls = [];
  const service = createChatSummaryRequest({
    history: { async listTextMessages(actorOpenId, window) {
      calls.push(['history', actorOpenId, window]);
      return { messages: [{ text: '确认上线' }], incomplete: true };
    } },
    summary: { async summarize(messages, actorOpenId) {
      calls.push(['summary', messages, actorOpenId]);
      return { summaryText: '{"important":["确认上线"]}' };
    } },
    oauth: { async authorizationUrl() { throw new Error('unused'); } },
  });

  const result = await service.handle('总结 2026-07-01 到 2026-07-15 的聊天', 'ou_actor');

  assert.deepEqual(calls[0], ['history', 'ou_actor', {
    startIso: '2026-07-01T00:00:00+08:00', endIso: '2026-07-15T23:59:59+08:00',
  }]);
  assert.deepEqual(calls[1], ['summary', [{ text: '确认上线' }], 'ou_actor']);
  assert.match(result.text, /确认上线/);
  assert.match(result.text, /可能不完整/);
});

test('returns an authorization URL without reading or summarizing when authorization is missing', async () => {
  let summarized = false;
  const service = createChatSummaryRequest({
    history: { async listTextMessages() { throw new UserAuthorizationRequired(); } },
    summary: { async summarize() { summarized = true; } },
    oauth: { async authorizationUrl(openId) { assert.equal(openId, 'ou_actor'); return 'https://auth.example'; } },
  });

  const result = await service.handle('总结 2026-07-01 到 2026-07-15 的聊天', 'ou_actor');

  assert.equal(summarized, false);
  assert.match(result.text, /https:\/\/auth\.example/);
  assert.match(result.text, /重新发送/);
});

test('rejects users outside the single-user local trial allowlist', async () => {
  let read = false;
  const service = createChatSummaryRequest({
    allowedOpenId: 'ou_allowed',
    history: { async listTextMessages() { read = true; return { messages: [] }; } },
    summary: { async summarize() { return { summaryText: '{}' }; } },
    oauth: null,
  });

  const result = await service.handle('总结今天的聊天', 'ou_other');

  assert.equal(read, false);
  assert.match(result.text, /指定用户/);
});
