import { createHash } from 'node:crypto';

function ensureSuccess(response, operation) {
  if (response?.code !== 0) {
    throw new Error(`Feishu ${operation} failed (code ${response?.code ?? 'unknown'})`);
  }
  return response?.data;
}

function messageUuid(value) {
  if (!value || value.length <= 50) return value;
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 43)}`;
}

const OWNER_ACTIONS = ['complete', 'continue', 'block', 'postpone'];
const CONSENT_ACTIONS = ['consent_chat_summary', 'decline_chat_summary'];
const MAX_CARD_COMPONENTS = 190;
const MAX_CARD_BYTES = 28 * 1024;

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

function truncateText(value, maximum) {
  const characters = Array.from(String(value || ''));
  return characters.length <= maximum ? characters.join('') : `${characters.slice(0, maximum).join('')}…`;
}

function taskMarkdown(task, ownerName) {
  const name = truncateText(task.name, 200);
  const owner = ownerName ? `\n负责人：${truncateText(ownerName, 100)}` : '';
  const deadline = task.deadline ? new Date(task.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未设置';
  const status = truncateText(task.status || '未设置', 100);
  const blocker = truncateText(task.blocker || '无', 1_000);
  return `**${name}**${owner}\n状态：${status}\n截止时间：${deadline}\n阻塞原因：${blocker}`;
}

export function countTaggedComponents(value) {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countTaggedComponents(item), 0);
  if (!value || typeof value !== 'object') return 0;
  return (typeof value.tag === 'string' ? 1 : 0)
    + Object.values(value).reduce((total, item) => total + countTaggedComponents(item), 0);
}

function cardFits(card) {
  return countTaggedComponents(card) <= MAX_CARD_COMPONENTS
    && Buffer.byteLength(JSON.stringify(card), 'utf8') <= MAX_CARD_BYTES;
}

function splitCompleteEntries(entries, buildCard) {
  const cards = [];
  let current = [];
  for (const entry of entries) {
    const candidate = buildCard([...current, entry]);
    if (cardFits(candidate)) {
      current.push(entry);
      continue;
    }
    if (current.length === 0) throw new Error('A single card entry exceeds the safe Card 2.0 limits');
    cards.push(buildCard(current));
    current = [entry];
    if (!cardFits(buildCard(current))) throw new Error('A single card entry exceeds the safe Card 2.0 limits');
  }
  if (current.length > 0) cards.push(buildCard(current));
  return cards;
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

export function buildOwnerReminderCards(owner, dateKey) {
  return splitCompleteEntries(owner.tasks, (tasks) => buildOwnerReminderCard({ ...owner, tasks }, dateKey));
}

export function buildLeaderSummaryCard(leader) {
  return {
    schema: '2.0',
    config: { width_mode: 'default' },
    header: { template: 'blue', title: plainText('今日截止未完成任务') },
    body: {
      elements: leader.owners.flatMap((owner) => owner.tasks.map((task) => ({
        tag: 'markdown',
        content: taskMarkdown(task, owner.name),
      }))),
    },
  };
}

export function buildLeaderSummaryCards(leader) {
  const entries = leader.owners.flatMap((owner) => owner.tasks.map((task) => ({ owner, task })));
  return splitCompleteEntries(entries, (parts) => buildLeaderSummaryCard({
    ...leader,
    owners: parts.map(({ owner, task }) => ({
      openId: owner.openId,
      name: owner.name,
      tasks: [task],
    })),
  }));
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

export function buildChatSummaryStatusCard({ title = '聊天总结', text }) {
  return {
    schema: '2.0',
    config: { width_mode: 'default', update_multi: true },
    header: { template: 'blue', title: plainText(title), icon: { tag: 'standard_icon', token: 'ai_colorful' } },
    body: { elements: [{ tag: 'markdown', content: truncateText(text, 4_000) }] },
  };
}

function previewMarkdown(preview) {
  const fields = preview?.after || preview?.before || {};
  const lines = [];
  if (fields.name || fields['任务名']) lines.push(`**任务：** ${truncateText(fields.name || fields['任务名'], 200)}`);
  if (fields.status || fields['状态']) lines.push(`**状态：** ${truncateText(fields['状态'] || fields.status, 100)}`);
  if (fields['开始日期']) lines.push(`**开始时间：** ${new Date(fields['开始日期']).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  if (fields.deadline || fields['截止日期']) lines.push(`**截止时间：** ${new Date(fields['截止日期'] || fields.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  return lines.join('\n') || '请确认是否执行此任务操作。';
}

export function buildTaskConfirmationCard(response) {
  return {
    schema: '2.0',
    config: { width_mode: 'default', update_multi: true },
    header: { template: 'blue', title: plainText('确认任务操作') },
    body: {
      elements: [
        { tag: 'markdown', content: previewMarkdown(response.preview) },
        {
          tag: 'column_set',
          columns: [{
            tag: 'column', width: 'weighted', weight: 1,
            elements: [
              callbackButton('确认', 'primary_filled', {
                action: 'confirm_task_change', confirmationId: response.confirmationId,
              }),
              callbackButton('取消', 'default', {
                action: 'cancel_task_change', confirmationId: response.confirmationId,
              }),
            ],
          }],
        },
      ],
    },
  };
}

export function buildTaskConfirmationResultCard(text) {
  const succeeded = text === '操作成功。';
  return {
    schema: '2.0',
    config: { width_mode: 'default' },
    header: {
      template: succeeded ? 'green' : 'grey',
      title: plainText(succeeded ? '任务操作已确认' : '任务操作已取消'),
    },
    body: { elements: [{ tag: 'markdown', content: truncateText(text, 500) }] },
  };
}

export function buildReminderReasonCard(task, action) {
  const label = action === 'block' ? '阻塞' : '延期';
  return {
    schema: '2.0',
    config: { width_mode: 'default', update_multi: true },
    header: { template: action === 'block' ? 'red' : 'orange', title: plainText(`${label}任务：${truncateText(task.name, 100)}`) },
    body: {
      elements: [{
        tag: 'form', name: `reason_${action}_${task.recordId}`, elements: [
          { tag: 'input', name: 'reason', required: true, label: plainText('原因'), placeholder: plainText(`请填写${label}原因`) },
          { tag: 'button', name: `submit_reason__${action}__${task.recordId}`, text: plainText('提交'), type: 'primary_filled', form_action_type: 'submit' },
        ],
      }],
    },
  };
}

function staticOptions(values) {
  return values.map((value) => ({ text: plainText(value), value }));
}

function dateTimeValue(value) {
  if (!value) return undefined;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(value));
  const item = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${item.year}-${item.month}-${item.day} ${item.hour}:${item.minute}`;
}

export function buildTaskEditCard(task) {
  const elements = [
    { tag: 'input', name: 'task_name', required: true, label: plainText('任务名'), default_value: task.name || '', width: 'fill' },
    { tag: 'markdown', content: '**优先级**' },
    { tag: 'select_static', name: 'priority', placeholder: plainText('请选择优先级'), options: staticOptions(['P0', 'P1', 'P2', 'P3']), initial_option: task.priority || undefined, width: 'fill' },
    { tag: 'markdown', content: '**状态**' },
    { tag: 'select_static', name: 'status', required: true, placeholder: plainText('请选择状态'), options: staticOptions(['未开始', '进行中', '阻塞中', '已完成', '已延期']), initial_option: task.status || undefined, width: 'fill' },
    { tag: 'input', name: 'progress', label: plainText('进度（0-100）'), default_value: String(task.progress ?? 0), width: 'fill' },
    { tag: 'input', name: 'blocker', label: plainText('阻塞原因'), default_value: task.blocker || '', width: 'fill' },
    { tag: 'markdown', content: '**标签**' },
    { tag: 'multi_select_static', name: 'tags', placeholder: plainText('请选择标签'), options: staticOptions(['需求', '开发', '测试', '设计', '运维', '运营', '其他']), selected_values: task.tags || [], width: 'fill' },
    { tag: 'markdown', content: '**开始时间**' },
    { tag: 'picker_datetime', name: 'start', placeholder: plainText('请选择开始时间'), initial_datetime: dateTimeValue(task.start), width: 'fill' },
    { tag: 'markdown', content: '**截止时间**' },
    { tag: 'picker_datetime', name: 'deadline', placeholder: plainText('请选择截止时间'), initial_datetime: dateTimeValue(task.deadline), width: 'fill' },
    { tag: 'button', name: `submit_edit__${task.recordId}`, text: plainText('保存修改'), type: 'primary_filled', width: 'fill', form_action_type: 'submit' },
  ];
  return {
    schema: '2.0', config: { width_mode: 'default', update_multi: true },
    header: { template: 'blue', title: plainText(`编辑任务：${truncateText(task.name, 100)}`), icon: { tag: 'standard_icon', token: 'todo_colorful' } },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', elements: [{ tag: 'form', name: `edit_${task.recordId}`, vertical_spacing: '12px', elements }] },
  };
}

function createTaskContext(fields = {}) {
  const owner = typeof fields['负责人'] === 'string' && fields['负责人'].trim()
    ? encodeURIComponent(fields['负责人'].trim())
    : '';
  return owner ? `__owner_${owner}` : '';
}

export function buildTaskCreateCard(fields = {}) {
  const elements = [
    ...(fields['负责人'] ? [{ tag: 'markdown', content: `负责人：${truncateText(fields['负责人'], 100)}` }] : []),
    { tag: 'input', name: 'task_name', required: true, label: plainText('任务名'), placeholder: plainText('请输入任务名'), width: 'fill' },
    { tag: 'markdown', content: '**优先级**' },
    { tag: 'select_static', name: 'priority', placeholder: plainText('请选择优先级'), options: staticOptions(['P0', 'P1', 'P2', 'P3']), width: 'fill' },
    { tag: 'markdown', content: '**截止时间**' },
    { tag: 'picker_datetime', name: 'deadline', placeholder: plainText('请选择截止时间'), width: 'fill' },
    { tag: 'button', name: `submit_create_task${createTaskContext(fields)}`, text: plainText('创建任务'), type: 'primary_filled', width: 'fill', form_action_type: 'submit' },
  ];
  return {
    schema: '2.0', config: { width_mode: 'default', update_multi: true },
    header: { template: 'blue', title: plainText('创建任务'), icon: { tag: 'standard_icon', token: 'todo_colorful' } },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', elements: [{ tag: 'form', name: 'create_task', vertical_spacing: '12px', elements }] },
  };
}

export function buildMyTasksCard(tasks) {
  return {
    schema: '2.0',
    config: { width_mode: 'default', update_multi: true },
    header: { template: 'blue', title: plainText('我的任务盘点'), icon: { tag: 'standard_icon', token: 'todo_colorful' } },
    body: {
      direction: 'vertical', padding: '12px 12px 20px 12px', vertical_spacing: '12px',
      elements: tasks.map((task) => ({
        tag: 'interactive_container', width: 'fill', has_border: true, border_color: 'blue-100',
        corner_radius: '8px', background_style: 'blue-50', padding: '12px', vertical_spacing: '4px',
        elements: [
          { tag: 'markdown', content: `**${truncateText(task.name, 200)}**` },
          { tag: 'markdown', content: `状态：${task.status || '未设置'}  ·  优先级：${task.priority || '未设置'}  ·  进度：${task.progress ?? 0}%` },
          { tag: 'markdown', content: `截止时间：${task.deadline ? new Date(task.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未设置'}`, text_size: 'notation' },
        ],
      })),
    },
  };
}

export function buildTaskEditPickerCard(tasks) {
  return {
    schema: '2.0',
    config: { width_mode: 'default', update_multi: true },
    header: { template: 'blue', title: plainText('选择要修改的任务'), icon: { tag: 'standard_icon', token: 'todo_colorful' } },
    body: {
      direction: 'vertical', padding: '12px 12px 20px 12px', vertical_spacing: '12px',
      elements: tasks.map((task) => ({
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'blue-50',
        horizontal_spacing: '8px',
        columns: [
          {
            tag: 'column', width: 'weighted', weight: 3, vertical_spacing: '4px',
            elements: [
              { tag: 'markdown', content: `**${truncateText(task.name, 200)}**` },
              { tag: 'markdown', content: `状态：${task.status || '未设置'}  ·  优先级：${task.priority || '未设置'}  ·  进度：${task.progress ?? 0}%`, text_size: 'notation' },
              { tag: 'markdown', content: `截止时间：${task.deadline ? new Date(task.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未设置'}`, text_size: 'notation' },
            ],
          },
          {
            tag: 'column', width: 'weighted', weight: 1,
            elements: [callbackButton('修改', 'primary_filled', { action: 'edit_task', taskId: task.recordId })],
          },
        ],
      })),
    },
  };
}

export function parseTaskCreateFormAction(event) {
  const actorOpenId = event?.operator?.open_id;
  const name = event?.action?.name;
  let values = event?.action?.form_value;
  if (typeof values === 'string') { try { values = JSON.parse(values); } catch { return null; } }
  const match = typeof name === 'string' ? name.match(/^submit_create_task(?:__owner_(.+))?$/) : null;
  if (!actorOpenId || !match || !values || typeof values !== 'object') return null;
  const fields = {};
  if (match[1]) fields['负责人'] = decodeURIComponent(match[1]);
  return { actorOpenId, values, fields };
}

export function parseTaskEditFormAction(event) {
  const actorOpenId = event?.operator?.open_id;
  const name = event?.action?.name;
  let values = event?.action?.form_value;
  if (typeof values === 'string') { try { values = JSON.parse(values); } catch { return null; } }
  if (!actorOpenId || typeof name !== 'string' || !name.startsWith('submit_edit__') || !values || typeof values !== 'object') return null;
  return { actorOpenId, recordId: name.slice('submit_edit__'.length), values };
}

export function parseReminderReasonAction(event) {
  const actorOpenId = event?.operator?.open_id;
  const name = event?.action?.name;
  let values = event?.action?.form_value;
  if (typeof values === 'string') { try { values = JSON.parse(values); } catch { return null; } }
  const match = typeof name === 'string' ? name.match(/^submit_reason__(block|postpone)__(.+)$/) : null;
  const reason = typeof values?.reason === 'string' ? values.reason.trim() : '';
  if (!actorOpenId || !match || !reason) return null;
  return { actorOpenId, action: match[1], taskId: match[2], reason };
}

export function parseTaskConfirmationAction(event) {
  const actorOpenId = event?.operator?.open_id;
  const value = event?.action?.value;
  if (typeof actorOpenId !== 'string' || !actorOpenId || !value || typeof value !== 'object') return null;
  if (!['confirm_task_change', 'cancel_task_change'].includes(value.action)) return null;
  if (typeof value.confirmationId !== 'string' || !value.confirmationId) return null;
  return { actorOpenId, action: value.action, confirmationId: value.confirmationId };
}

export function parseTaskEditSelectionAction(event) {
  const actorOpenId = event?.operator?.open_id;
  const value = event?.action?.value;
  if (typeof actorOpenId !== 'string' || !actorOpenId || !value || typeof value !== 'object') return null;
  if (value.action !== 'edit_task') return null;
  if (typeof value.taskId !== 'string' || !value.taskId) return null;
  return { actorOpenId, taskId: value.taskId };
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
      data: { receive_id: openId, msg_type: msgType, content: JSON.stringify(content), uuid: messageUuid(uuid) },
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
      return ensureSuccess(response, 'message reply');
    },

    async replyCard(messageId, card) {
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'interactive', content: JSON.stringify(card) },
      });
      return ensureSuccess(response, 'message reply');
    },

    async updateCard(messageId, card) {
      const response = await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      ensureSuccess(response, 'message patch');
    },

    async updateCardByToken(token, card) {
      const response = await client.request({
        method: 'POST',
        url: '/open-apis/interactive/v1/card/update',
        data: { token, card },
      });
      ensureSuccess(response?.data?.code !== undefined ? response.data : response, 'card delayed update');
    },
  };
}
