import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPrompt } from '../src/message-policy.js';

test('accepts non-empty private text', () => {
  assert.equal(extractPrompt({ chat_type: 'p2p', message_type: 'text', content: '{"text":"你好"}', mentions: [] }), '你好');
});

test('ignores a group message without a mention', () => {
  assert.equal(extractPrompt({ chat_type: 'group', message_type: 'text', content: '{"text":"你好"}', mentions: [] }), null);
});

test('removes the bot mention from a group prompt', () => {
  assert.equal(extractPrompt({ chat_type: 'group', message_type: 'text', content: '{"text":"@_user_1 帮我介绍产品"}', mentions: [{ key: '@_user_1', name: '客服机器人' }] }), '帮我介绍产品');
});

test('ignores non-text, invalid JSON and empty text', () => {
  assert.equal(extractPrompt({ chat_type: 'p2p', message_type: 'image', content: '{}' }), null);
  assert.equal(extractPrompt({ chat_type: 'p2p', message_type: 'text', content: 'bad' }), null);
  assert.equal(extractPrompt({ chat_type: 'p2p', message_type: 'text', content: '{"text":"  "}' }), null);
});
