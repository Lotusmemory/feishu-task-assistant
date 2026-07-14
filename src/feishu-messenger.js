function ensureSuccess(response, operation) {
  if (response?.code !== 0) {
    throw new Error(`Feishu ${operation} failed (code ${response?.code ?? 'unknown'})`);
  }
}

export function createFeishuMessenger({ client }) {
  async function create(openId, msgType, content, uuid) {
    const response = await client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: msgType, content: JSON.stringify(content), uuid },
    });
    ensureSuccess(response, 'message create');
  }

  return {
    async sendText(openId, text, uuid) {
      await create(openId, 'text', { text }, uuid);
    },

    async sendCard(openId, card, uuid) {
      await create(openId, 'interactive', card, uuid);
    },

    async replyText(messageId, text) {
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) },
      });
      ensureSuccess(response, 'message reply');
    },
  };
}
