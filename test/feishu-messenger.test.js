import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuMessenger } from '../src/feishu-messenger.js';

function fixture(responses = {}) {
  const calls = [];
  const client = { im: { v1: { message: {
    async create(request) { calls.push(['create', request]); return responses.create || { code: 0 }; },
    async reply(request) { calls.push(['reply', request]); return responses.reply || { code: 0 }; },
  } } } };
  return { messenger: createFeishuMessenger({ client }), calls };
}

test('sends text to an open id with serialized content and an idempotency uuid', async () => {
  const { messenger, calls } = fixture();

  await messenger.sendText('ou_user', '你好', 'uuid-1');

  assert.deepEqual(calls, [['create', {
    params: { receive_id_type: 'open_id' },
    data: { receive_id: 'ou_user', msg_type: 'text', content: '{"text":"你好"}', uuid: 'uuid-1' },
  }]]);
});

test('sends a prebuilt card as serialized interactive content', async () => {
  const { messenger, calls } = fixture();
  const card = { schema: '2.0', body: { elements: [] } };

  await messenger.sendCard('ou_user', card, 'uuid-2');

  assert.deepEqual(calls, [['create', {
    params: { receive_id_type: 'open_id' },
    data: { receive_id: 'ou_user', msg_type: 'interactive', content: JSON.stringify(card), uuid: 'uuid-2' },
  }]]);
});

test('replies to an existing message with text', async () => {
  const { messenger, calls } = fixture();

  await messenger.replyText('om_1', '收到');

  assert.deepEqual(calls, [['reply', {
    path: { message_id: 'om_1' },
    data: { msg_type: 'text', content: '{"text":"收到"}' },
  }]]);
});

test('throws a sanitized error for a nonzero Feishu response code', async () => {
  const { messenger } = fixture({ create: { code: 999, msg: 'secret=tenant-token' } });

  await assert.rejects(
    () => messenger.sendText('ou_user', '你好', 'uuid-1'),
    (error) => {
      assert.match(error.message, /999/);
      assert.doesNotMatch(error.message, /tenant-token|secret/);
      return true;
    },
  );
});
