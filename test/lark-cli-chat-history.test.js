import test from 'node:test';
import assert from 'node:assert/strict';
import { createLarkCliChatHistory } from '../src/lark-cli-chat-history.js';

test('reads text messages from lark-cli search output', async () => {
  const calls = [];
  const history = createLarkCliChatHistory({
    command: 'fake-lark',
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'contact') {
        return { stdout: JSON.stringify({
          ok: true,
          data: { users: [
            { open_id: 'ou_a', localized_name: '张三' },
            { open_id: 'ou_b', localized_name: '李四' },
          ] },
        }) };
      }
      return { stdout: JSON.stringify({
        ok: true,
        data: {
          has_more: true,
          messages: [
            {
              message_id: 'm2', chat_id: 'c1', create_time: '2',
              sender: { id: 'ou_b' }, msg_type: 'text', content: '{"text":" 后发 "}',
            },
            {
              message_id: 'm1', chat_id: 'c1', create_time: '1',
              sender: { id: 'ou_a' }, msg_type: 'text', content: { text: '先发' },
            },
            { message_id: 'm3', msg_type: 'image', content: '{}' },
          ],
        },
      }) };
    },
  });

  const result = await history.listTextMessages('ou_actor', {
    startIso: '2026-07-15T00:00:00+08:00',
    endIso: '2026-07-15T23:59:59+08:00',
  });

  assert.equal(calls[0].command, 'fake-lark');
  assert.deepEqual(calls[0].args.slice(0, 4), ['im', '+messages-search', '--as', 'user']);
  assert.deepEqual(calls[1].args.slice(0, 2), ['contact', '+search-user']);
  assert.deepEqual(result, {
    incomplete: true,
    messages: [
      { messageId: 'm1', chatId: 'c1', createTime: '1', senderId: 'ou_a', senderName: '张三', text: '先发' },
      { messageId: 'm2', chatId: 'c1', createTime: '2', senderId: 'ou_b', senderName: '李四', text: '后发' },
    ],
  });
});

test('hides unresolved user and bot ids behind readable fallback names', async () => {
  const history = createLarkCliChatHistory({
    execFileImpl: async (_command, args) => {
      if (args[0] === 'contact') return { stdout: JSON.stringify({ ok: true, data: { users: [] } }) };
      return { stdout: JSON.stringify({ ok: true, data: { messages: [
        { message_id: 'm1', chat_id: 'c1', create_time: '1', sender: { id: 'ou_hidden', sender_type: 'user' }, msg_type: 'text', content: '{"text":"用户消息"}' },
        { message_id: 'm2', chat_id: 'c1', create_time: '2', sender: { id: 'cli_bot', sender_type: 'app' }, msg_type: 'text', content: '{"text":"机器人消息"}' },
      ] } }) };
    },
  });

  const result = await history.listTextMessages('ou_actor', { startIso: 'a', endIso: 'b' });

  assert.deepEqual(result.messages.map(({ senderName }) => senderName), ['未知成员', '智能客服']);
});

test('throws a safe error when lark-cli reports failure', async () => {
  const history = createLarkCliChatHistory({
    execFileImpl: async () => ({ stdout: JSON.stringify({ ok: false, error: { message: 'token expired' } }) }),
  });

  await assert.rejects(
    () => history.listTextMessages('ou_actor', { startIso: 'a', endIso: 'b' }),
    /token expired/,
  );
});
