import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConsentCard,
  buildLeaderSummaryCards,
  buildLeaderSummaryCard,
  buildOwnerReminderCards,
  buildOwnerReminderCard,
  countTaggedComponents,
  createFeishuMessenger,
  parseCardAction,
} from '../src/feishu-messenger.js';

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

test('parses a valid card callback and rejects malformed events', () => {
  assert.deepEqual(parseCardAction({
    operator: { open_id: 'ou_a' },
    action: { value: { action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' } },
  }), { actorOpenId: 'ou_a', action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' });
  assert.equal(parseCardAction({ action: { value: {} } }), null);
});
