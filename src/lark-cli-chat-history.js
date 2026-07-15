import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PAGE_SIZE = 50;
const CONTACT_BATCH_SIZE = 30;

function parseTextContent(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parseTextContent(parsed);
    } catch {
      const trimmed = value.trim();
      return trimmed || null;
    }
  }
  const text = value?.text?.trim();
  return text || null;
}

function normalizeMessage(item) {
  if (item?.msg_type !== 'text') return null;
  const text = parseTextContent(item.content ?? item.body?.content);
  if (!text) return null;
  return {
    messageId: item.message_id,
    chatId: item.chat_id,
    createTime: item.create_time,
    senderId: item.sender?.id,
    senderType: item.sender?.sender_type,
    text,
  };
}

export function createLarkCliChatHistory({
  command = 'lark-cli',
  execFileImpl = execFileAsync,
  pageLimit = 20,
} = {}) {
  async function resolveSenderNames(messages) {
    const ids = [...new Set(messages.map(({ senderId }) => senderId)
      .filter((id) => /^ou_[a-zA-Z0-9]+$/.test(id)))];
    const names = new Map();
    for (let index = 0; index < ids.length; index += CONTACT_BATCH_SIZE) {
      try {
        const { stdout } = await execFileImpl(command, [
          'contact', '+search-user',
          '--user-ids', ids.slice(index, index + CONTACT_BATCH_SIZE).join(','),
          '--lang', 'zh_cn', '--page-size', String(CONTACT_BATCH_SIZE),
          '--as', 'user', '--format', 'json',
        ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
        const parsed = JSON.parse(stdout);
        if (parsed?.ok === false) continue;
        for (const user of parsed?.data?.users || []) {
          const name = typeof user.localized_name === 'string' ? user.localized_name.trim() : '';
          if (/^ou_[a-zA-Z0-9]+$/.test(user.open_id) && name && !/^ou_[a-zA-Z0-9]+$/.test(name)) {
            names.set(user.open_id, name);
          }
        }
      } catch {
        // A missing contact permission must not block the summary; unresolved ids use a safe label.
      }
    }
    return names;
  }

  return {
    async listTextMessages(_openId, window) {
      const { stdout } = await execFileImpl(command, [
        'im', '+messages-search',
        '--as', 'user',
        '--start', window.startIso,
        '--end', window.endIso,
        '--page-all',
        '--page-limit', String(pageLimit),
        '--page-size', String(PAGE_SIZE),
        '--format', 'json',
        '--no-reactions',
      ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      const parsed = JSON.parse(stdout);
      if (parsed?.ok === false) throw new Error(parsed.error?.message || 'lark-cli messages search failed');
      const data = parsed?.data || {};
      const rawMessages = Array.isArray(data.messages) ? data.messages : [];
      const messages = rawMessages.map(normalizeMessage).filter(Boolean)
        .sort((left, right) => Number(left.createTime) - Number(right.createTime));
      const senderNames = await resolveSenderNames(messages);
      return {
        messages: messages.map(({ senderType, ...message }) => ({
          ...message,
          senderName: senderNames.get(message.senderId)
            || (senderType === 'app' || /^cli_/.test(message.senderId || '') ? '智能客服' : '未知成员'),
        })),
        incomplete: Boolean(data.has_more || data.truncated),
      };
    },
  };
}
