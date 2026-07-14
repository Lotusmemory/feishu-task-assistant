function ensureSuccess(response, operation) {
  if (response?.code !== 0) {
    throw new Error(`Feishu ${operation} failed (code ${response?.code ?? 'unknown'})`);
  }
}

const OWNER_ACTIONS = ['complete', 'continue', 'block', 'postpone'];
const CONSENT_ACTIONS = ['consent_chat_summary', 'decline_chat_summary'];

function plainText(content) {
  return { tag: 'plain_text', content };
}

function callbackButton(text, type, value) {
  return {
    tag: 'button',
    text: plainText(text),
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

function taskMarkdown(task, ownerName) {
  const owner = ownerName ? `\n负责人：${ownerName}` : '';
  const deadline = task.deadline ? new Date(task.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未设置';
  const blocker = task.blocker || '无';
  return `**${task.name}**${owner}\n状态：${task.status || '未设置'}\n截止时间：${deadline}\n阻塞原因：${blocker}`;
}

export function buildOwnerReminderCard(owner, dateKey) {
  const batchId = `${dateKey}:${owner.openId}`;
  return {
    schema: '2.0',
    config: { width_mode: 'default' },
    header: { template: 'yellow', title: plainText('每日任务盘点') },
    body: {
      elements: owner.tasks.map((task) => ({
        tag: 'column_set',
        columns: [
          { tag: 'column', width: 'weighted', weight: 2, elements: [{ tag: 'markdown', content: taskMarkdown(task) }] },
          {
            tag: 'column', width: 'weighted', weight: 1,
            elements: [
              callbackButton('完成', 'primary_filled', { action: 'complete', taskId: task.recordId, batchId }),
              callbackButton('继续', 'default', { action: 'continue', taskId: task.recordId, batchId }),
              callbackButton('阻塞', 'danger', { action: 'block', taskId: task.recordId, batchId }),
              callbackButton('延期', 'default', { action: 'postpone', taskId: task.recordId, batchId }),
            ],
          },
        ],
      })),
    },
  };
}

export function buildLeaderSummaryCard(leader) {
  return {
    schema: '2.0',
    config: { width_mode: 'default' },
    header: { template: 'blue', title: plainText('团队任务摘要') },
    body: {
      elements: leader.owners.flatMap((owner) => owner.tasks.map((task) => ({
        tag: 'markdown',
        content: taskMarkdown(task, owner.name),
      }))),
    },
  };
}

export function buildConsentCard() {
  return {
    schema: '2.0',
    config: { width_mode: 'default' },
    header: { template: 'blue', title: plainText('聊天摘要授权') },
    body: {
      elements: [
        { tag: 'markdown', content: '是否授权使用聊天摘要辅助任务盘点？' },
        callbackButton('同意', 'primary_filled', { action: 'consent_chat_summary' }),
        callbackButton('拒绝', 'default', { action: 'decline_chat_summary' }),
      ],
    },
  };
}

export function parseCardAction(event) {
  const actorOpenId = event?.operator?.open_id;
  const value = event?.action?.value;
  if (typeof actorOpenId !== 'string' || !actorOpenId || !value || typeof value !== 'object') return null;
  if (![...OWNER_ACTIONS, ...CONSENT_ACTIONS].includes(value.action)) return null;
  if (OWNER_ACTIONS.includes(value.action)
    && (![value.taskId, value.batchId].every((item) => typeof item === 'string' && item))) return null;
  return { actorOpenId, action: value.action, taskId: value.taskId, batchId: value.batchId };
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
