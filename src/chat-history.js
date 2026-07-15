import { withUserAccessToken } from '@larksuiteoapi/node-sdk';

const REFRESH_BEFORE_MS = 5 * 60 * 1_000;
const PAGE_SIZE = 50;

export class UserAuthorizationRequired extends Error {
  constructor() {
    super('User authorization is required');
    this.name = 'UserAuthorizationRequired';
  }
}

function assertSuccess(response, operation) {
  if (response?.code !== 0) throw new Error(`Feishu ${operation} failed (code ${response?.code ?? 'unknown'})`);
  return response.data || {};
}

function refreshedToken(response, previous, now) {
  const data = response?.data || response;
  if (!data?.accessToken || !data?.refreshToken) throw new Error('Invalid refreshed user token');
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresIn === undefined ? previous.expiresAt : now + data.expiresIn * 1_000,
    refreshExpiresAt: data.refreshTokenExpiresIn === undefined
      ? previous.refreshExpiresAt
      : now + data.refreshTokenExpiresIn * 1_000,
    scope: data.scope ?? previous.scope,
  };
}

function messageText(item) {
  if (item?.msg_type !== 'text') return null;
  try {
    const content = typeof item.body?.content === 'string'
      ? JSON.parse(item.body.content)
      : item.body?.content;
    const text = content?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

export function createChatHistory({ client, vault, clock = Date.now, maxSearchPages = 100 }) {
  async function accessToken(openId) {
    let token = await vault.get(openId);
    if (!token) throw new UserAuthorizationRequired();
    const now = clock();
    if (Number.isFinite(token.expiresAt) && token.expiresAt - now <= REFRESH_BEFORE_MS) {
      try {
        const response = await client.accessToken.refresh({
          refreshToken: token.refreshToken,
          scope: token.scope,
        });
        token = refreshedToken(response, token, now);
        await vault.put(openId, token);
      } catch {
        await vault.delete(openId);
        throw new UserAuthorizationRequired();
      }
    }
    return token.accessToken;
  }

  return {
    async listTextMessages(openId, window) {
      const token = await accessToken(openId);
      const messageIds = [];
      let pageToken;
      let incomplete = false;
      for (let page = 0; page < maxSearchPages; page += 1) {
        const data = assertSuccess(await client.request({
          method: 'POST',
          url: `${client.domain}/open-apis/im/v1/messages/search`,
          params: { page_size: PAGE_SIZE, page_token: pageToken },
          data: {
            query: '',
            filter: { time_range: { start_time: window.startIso, end_time: window.endIso } },
          },
        }, withUserAccessToken(token)), 'message search');
        messageIds.push(...(data.items || []).map((item) => item.message_id).filter(Boolean));
        if (!data.has_more) break;
        pageToken = data.page_token;
        if (!pageToken || page === maxSearchPages - 1) {
          incomplete = true;
          break;
        }
      }

      const messages = [];
      for (let index = 0; index < messageIds.length; index += PAGE_SIZE) {
        const ids = messageIds.slice(index, index + PAGE_SIZE);
        const data = assertSuccess(await client.request({
          method: 'GET',
          url: `${client.domain}/open-apis/im/v1/messages/mget`,
          params: { message_ids: ids },
        }, withUserAccessToken(token)), 'message mget');
        for (const item of data.items || []) {
          const text = messageText(item);
          if (!text) continue;
          messages.push({
            messageId: item.message_id,
            chatId: item.chat_id,
            createTime: item.create_time,
            senderId: item.sender?.id,
            text,
          });
        }
      }
      messages.sort((left, right) => Number(left.createTime) - Number(right.createTime));
      return { messages, incomplete };
    },
  };
}
