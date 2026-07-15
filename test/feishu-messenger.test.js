import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConsentCard,
  buildKnowledgeAnswerCard,
  buildChatSummaryStatusCard,
  buildTaskConfirmationCard,
  buildTaskConfirmationResultCard,
  buildTaskCreateCard,
  buildTaskCreateProcessingCard,
  buildTaskIntentProcessingCard,
  buildTaskOperationProcessingCard,
  buildTaskConfirmationProcessingCard,
  buildTaskEditCard,
  buildTaskEditProcessingCard,
  buildTaskEditPickerCard,
  buildTaskScopeChoiceCard,
  buildTaskReviewProcessingCard,
  buildMyTasksCard,
  buildLeaderSummaryCards,
  buildLeaderSummaryCard,
  buildOwnerReminderCards,
  buildOwnerReminderCard,
  buildReminderReasonCard,
  countTaggedComponents,
  createFeishuMessenger,
  parseCardAction,
  parseTaskConfirmationAction,
  parseTaskCreateFormAction,
  parseTaskEditFormAction,
  parseTaskEditSelectionAction,
  parseTaskScopeSelectionAction,
  parseReminderReasonAction,
} from '../src/feishu-messenger.js';

function fixture(responses = {}) {
  const calls = [];
  const client = { async request(request) { calls.push(['request', request]); return responses.request || { code: 0 }; }, im: { v1: { message: {
    async create(request) { calls.push(['create', request]); return responses.create || { code: 0 }; },
    async reply(request) { calls.push(['reply', request]); return responses.reply || { code: 0 }; },
    async patch(request) { calls.push(['patch', request]); return responses.patch || { code: 0 }; },
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

test('builds and parses reminder reason forms for block and postpone', () => {
  for (const action of ['block', 'postpone']) {
    const card = buildReminderReasonCard({ recordId: 'rec1', name: '喝水' }, action);
    assert.equal(card.schema, '2.0');
    assert.match(JSON.stringify(card), new RegExp(`submit_reason__${action}__rec1`));
    assert.deepEqual(parseReminderReasonAction({
      operator: { open_id: 'ou_a' },
      action: { name: `submit_reason__${action}__rec1`, form_value: '{"reason":"等待接口"}' },
    }), { actorOpenId: 'ou_a', action, taskId: 'rec1', reason: '等待接口' });
  }
});

test('hashes an overlong idempotency uuid to the Feishu field limit', async () => {
  const { messenger, calls } = fixture();
  const uuid = `owner:2026-07-15:${'ou_'.padEnd(40, 'a')}:1/1`;

  await messenger.sendText('ou_user', '你好', uuid);

  assert.equal(calls[0][1].data.uuid.length, 50);
  assert.match(calls[0][1].data.uuid, /^sha256:[a-f0-9]{43}$/);
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

test('replies to an existing message with an interactive card', async () => {
  const { messenger, calls } = fixture();
  const card = { schema: '2.0', body: { elements: [] } };
  await messenger.replyCard('om_1', card);
  assert.deepEqual(calls, [['reply', {
    path: { message_id: 'om_1' },
    data: { msg_type: 'interactive', content: JSON.stringify(card) },
  }]]);
});

test('builds a read-only knowledge answer card', () => {
  const card = buildKnowledgeAnswerCard('账号开通后即可使用。');

  assert.equal(card.schema, '2.0');
  assert.equal(card.header.title.content, '知识助手');
  assert.equal(card.header.template, 'blue');
  assert.equal(card.body.elements[0].content, '账号开通后即可使用。');
  assert.doesNotMatch(JSON.stringify(card), /button|callback/);
});

test('updates an existing interactive card', async () => {
  const { messenger, calls } = fixture();
  const card = { schema: '2.0', body: { elements: [] } };
  await messenger.updateCard('om_1', card);
  assert.deepEqual(calls, [['patch', {
    path: { message_id: 'om_1' },
    data: { content: JSON.stringify(card) },
  }]]);
});

test('updates a card with the callback delayed-update token', async () => {
  const { messenger, calls } = fixture();
  const card = { schema: '2.0', body: { elements: [] } };
  await messenger.updateCardByToken('token-1', card);
  assert.deepEqual(calls, [['request', {
    method: 'POST', url: '/open-apis/interactive/v1/card/update', data: { token: 'token-1', card },
  }]]);
});

test('builds and parses a task confirmation card', () => {
  const card = buildTaskConfirmationCard({
    confirmationId: 'cfm-1',
    preview: { after: { 任务名: '喝水', 状态: '阻塞中' } },
  });
  const buttons = card.body.elements[1].columns[0].elements;
  assert.equal(card.config.update_multi, true);
  assert.match(card.body.elements[0].content, /喝水/);
  assert.deepEqual(buttons.map((button) => button.behaviors[0].value), [
    { action: 'confirm_task_change', confirmationId: 'cfm-1' },
    { action: 'cancel_task_change', confirmationId: 'cfm-1' },
  ]);
  assert.deepEqual(parseTaskConfirmationAction({
    operator: { open_id: 'ou_actor' },
    action: { value: buttons[0].behaviors[0].value },
  }), { actorOpenId: 'ou_actor', action: 'confirm_task_change', confirmationId: 'cfm-1' });
});

test('builds a read-only result card after confirmation', () => {
  const card = buildTaskConfirmationResultCard('操作成功。');
  assert.equal(card.header.template, 'green');
  assert.match(card.header.title.content, /已确认/);
  assert.doesNotMatch(JSON.stringify(card), /button|callback|confirmationId/);
});

test('distinguishes a failed task operation from a cancellation', () => {
  const failed = buildTaskConfirmationResultCard('保存失败，请重新打开任务后再试。');
  const cancelled = buildTaskConfirmationResultCard('操作已取消。');

  assert.equal(failed.header.template, 'red');
  assert.equal(failed.header.title.content, '任务操作失败');
  assert.equal(cancelled.header.template, 'grey');
  assert.equal(cancelled.header.title.content, '任务操作已取消');
});

test('builds and parses a prefilled task edit form', () => {
  const card = buildTaskEditCard({ recordId: 'rec1', name: '喝水', status: '进行中', priority: 'P1', progress: 20, tags: ['其他'] });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /select_static/);
  assert.match(serialized, /multi_select_static/);
  assert.match(serialized, /submit_edit__rec1/);
  assert.deepEqual(parseTaskEditFormAction({
    operator: { open_id: 'ou_actor' },
    action: { name: 'submit_edit__rec1', form_value: { task_name: '喝水', status: '进行中' } },
  }), { actorOpenId: 'ou_actor', recordId: 'rec1', values: { task_name: '喝水', status: '进行中' } });
});

test('builds a read-only processing card while a task edit is being saved', () => {
  const card = buildTaskEditProcessingCard('喝水');
  const serialized = JSON.stringify(card);

  assert.equal(card.header.title.content, '正在保存任务修改');
  assert.match(serialized, /喝水/);
  assert.doesNotMatch(serialized, /button|submit_edit|callback/);
});

test('builds and parses a task edit picker card', () => {
  const card = buildTaskEditPickerCard([
    { recordId: 'rec1', name: '喝水', status: '进行中', priority: 'P1', progress: 20, deadline: 1_784_041_200_000 },
  ]);
  const serialized = JSON.stringify(card);
  assert.equal(card.header.title.content, '选择要修改的任务');
  assert.match(serialized, /edit_task/);
  assert.match(serialized, /喝水/);
  assert.deepEqual(parseTaskEditSelectionAction({
    operator: { open_id: 'ou_actor' },
    action: { value: { action: 'edit_task', taskId: 'rec1' } },
  }), { actorOpenId: 'ou_actor', taskId: 'rec1' });
});

test('builds and parses a task create form', () => {
  const card = buildTaskCreateCard();
  const serialized = JSON.stringify(card);
  assert.equal(card.header.title.content, '创建任务');
  assert.match(serialized, /submit_create_task/);
  assert.match(serialized, /picker_datetime/);
  assert.deepEqual(parseTaskCreateFormAction({
    operator: { open_id: 'ou_actor' },
    action: { name: 'submit_create_task', form_value: '{"task_name":"喝水","priority":"P1"}' },
  }), { actorOpenId: 'ou_actor', values: { task_name: '喝水', priority: 'P1' }, fields: {} });
});

test('builds a read-only processing card while a task is being created', () => {
  const card = buildTaskCreateProcessingCard('喝水');
  const serialized = JSON.stringify(card);

  assert.equal(card.header.title.content, '正在创建任务');
  assert.match(serialized, /喝水/);
  assert.doesNotMatch(serialized, /button|submit_create_task|callback/);
});

test('builds read-only task understanding and operation processing cards', () => {
  const understanding = buildTaskIntentProcessingCard();
  const preparing = buildTaskOperationProcessingCard('delete_task');
  const confirming = buildTaskConfirmationProcessingCard('confirm_task_change');

  assert.equal(understanding.header.title.content, '正在理解任务请求');
  assert.equal(preparing.header.title.content, '正在准备删除任务');
  assert.equal(confirming.header.title.content, '正在执行任务操作');
  assert.doesNotMatch(JSON.stringify([understanding, preparing, confirming]), /button|callback/);
});

test('preserves delegated owner in a task create form', () => {
  const card = buildTaskCreateCard({ 负责人: '田嘉国' });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /负责人：田嘉国/);
  assert.match(serialized, /submit_create_task__owner_/);
  const button = card.body.elements[0].elements.find((element) => element.tag === 'button');

  assert.deepEqual(parseTaskCreateFormAction({
    operator: { open_id: 'ou_actor' },
    action: { name: button.name, form_value: { task_name: '喝水' } },
  }), { actorOpenId: 'ou_actor', values: { task_name: '喝水' }, fields: { 负责人: '田嘉国' } });
});

test('builds a card for my task review', () => {
  const card = buildMyTasksCard([{ name: '喝水', status: '进行中', priority: 'P1', progress: 20, deadline: 1_784_041_200_000 }]);
  assert.equal(card.header.title.content, '我的任务盘点');
  assert.match(JSON.stringify(card), /喝水/);
  assert.match(JSON.stringify(card), /进行中/);
});

test('builds and parses a leader task scope choice card', () => {
  const card = buildTaskScopeChoiceCard();
  const buttons = card.body.elements[1].columns[0].elements;

  assert.equal(card.header.title.content, '选择任务盘点范围');
  assert.deepEqual(buttons.map((button) => button.behaviors[0].value), [
    { action: 'query_task_scope', scope: 'self' },
    { action: 'query_task_scope', scope: 'all' },
  ]);
  assert.deepEqual(parseTaskScopeSelectionAction({
    operator: { open_id: 'ou_leader' },
    action: { value: { action: 'query_task_scope', scope: 'all' } },
  }), { actorOpenId: 'ou_leader', scope: 'all' });
});

test('builds a read-only task review processing card', () => {
  const card = buildTaskReviewProcessingCard();

  assert.equal(card.header.title.content, '正在盘点任务');
  assert.match(card.body.elements[0].content, /请稍候/);
  assert.doesNotMatch(JSON.stringify(card), /button|callback/);
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

test('builds a Card 2.0 owner reminder with four callbacks per task', () => {
  const card = buildOwnerReminderCard({
    openId: 'ou_a',
    tasks: [{ recordId: 'rec1', name: '首页设计', status: '进行中', deadline: 1_784_041_200_000, blocker: '' }],
  }, '2026-07-14');
  const serialized = JSON.stringify(card);
  const buttons = card.body.elements[0].columns.flatMap((column) => column.elements)
    .filter((element) => element.tag === 'button');

  assert.equal(card.schema, '2.0');
  assert.equal(card.header.template, 'yellow');
  assert.equal(card.config.width_mode, 'default');
  assert.equal(card.body.elements[0].tag, 'column_set');
  assert.match(serialized, /markdown/);
  assert.deepEqual(buttons.map(({ type }) => type), ['primary_filled', 'default', 'danger', 'default']);
  assert.deepEqual(buttons.map(({ behaviors }) => behaviors[0]), [
    { type: 'callback', value: { action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
    { type: 'callback', value: { action: 'continue', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
    { type: 'callback', value: { action: 'block', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
    { type: 'callback', value: { action: 'postpone', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
  ]);
});

test('splits owner tasks without exceeding component and UTF-8 byte limits', () => {
  const tasks = Array.from({ length: 17 }, (_, index) => ({
    recordId: `rec${index}`, name: `任务${index}`, status: '进行中', deadline: 1_784_041_200_000, blocker: '',
  }));
  const cards = buildOwnerReminderCards({ openId: 'ou_a', tasks }, '2026-07-14');

  assert.ok(cards.length > 1);
  assert.equal(cards.reduce((total, card) => total + card.body.elements.length, 0), 17);
  for (const card of cards) {
    assert.ok(countTaggedComponents(card) <= 190);
    assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') <= 28 * 1024);
  }
});

test('builds a blue read-only leader card without interactive fields', () => {
  const card = buildLeaderSummaryCard({
    openId: 'ou_l',
    owners: [{ openId: 'ou_a', name: '张三', tasks: [{
      recordId: 'rec1', name: '首页设计', status: '已阻塞', deadline: 1_784_041_200_000, blocker: '等待接口',
    }] }],
  });
  const serialized = JSON.stringify(card);

  assert.equal(card.header.template, 'blue');
  assert.match(serialized, /张三/);
  assert.match(serialized, /首页设计/);
  assert.match(serialized, /已阻塞/);
  assert.match(serialized, /等待接口/);
  assert.doesNotMatch(serialized, /"(?:button|behaviors|action)"/);
});

test('splits large leader summaries on complete owner/task entries', () => {
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    recordId: `rec${index}`, name: `任务${index}`, status: '已阻塞', deadline: 1_784_041_200_000,
    blocker: `阻塞${index}${'很长'.repeat(2_000)}`,
  }));
  const cards = buildLeaderSummaryCards({
    openId: 'ou_l', owners: [{ openId: 'ou_a', name: '张三', tasks }],
  });

  assert.ok(cards.length > 1);
  assert.equal(cards.reduce((total, card) => total + card.body.elements.length, 0), 10);
  for (const card of cards) {
    assert.ok(countTaggedComponents(card) <= 190);
    assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') <= 28 * 1024);
    assert.doesNotMatch(JSON.stringify(card), /"(?:button|behaviors|action)"/);
  }
});

test('builds a blue consent card with only the two consent callback values', () => {
  const card = buildConsentCard();
  const buttons = card.body.elements.filter(({ tag }) => tag === 'button');

  assert.equal(card.header.template, 'blue');
  assert.deepEqual(buttons.map(({ behaviors }) => behaviors[0].value), [
    { action: 'consent_chat_summary' },
    { action: 'decline_chat_summary' },
  ]);
});

test('builds a chat summary status card', () => {
  const card = buildChatSummaryStatusCard({ title: '聊天总结', text: '正在总结，请稍候。' });
  assert.equal(card.header.title.content, '聊天总结');
  assert.match(JSON.stringify(card), /正在总结/);
  assert.equal(card.config.update_multi, true);
});

test('parses a valid card callback and rejects malformed events', () => {
  assert.deepEqual(parseCardAction({
    operator: { open_id: 'ou_a' },
    action: { value: { action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
  }), { actorOpenId: 'ou_a', action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' });
  assert.equal(parseCardAction({ action: { value: {} } }), null);
});
