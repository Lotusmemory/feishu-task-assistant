import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatSummary } from '../src/chat-summary.js';

test('sanitizes fixed JSON and stores valid drafts as actor-owned confirmations', async () => {
  const prepared = [];
  const minimax = { async completeWithSystem(_system, prompt) {
    assert.match(prompt, /原始讨论/);
    assert.match(prompt, /张三/);
    assert.doesNotMatch(prompt, /ou_other/);
    return JSON.stringify({
      summary: { important: ['确认上线'], decisions: ['方案A'], todos: [], risks: [], people: [], forbidden: ['x'] },
      taskDrafts: [
        { 任务名: '完成首页', 截止日期: '2026-07-17 18:00', 优先级: 'P1', 来源摘要: '项目讨论', extra: 'drop' },
        { 截止日期: '2026-07-18' },
      ],
      unknown: 'drop',
    });
  } };
  const taskService = { async prepare(intent, actorOpenId) {
    prepared.push({ intent, actorOpenId });
    return { kind: 'confirmation', confirmationId: 'draft-1' };
  } };

  const result = await createChatSummary({ minimax, taskService }).summarize([
    { createTime: '1', senderId: 'ou_other', senderName: '张三', text: '原始讨论' },
  ], 'ou_actor');

  assert.deepEqual(result.summary, {
    important: ['确认上线'], decisions: ['方案A'], todos: [], risks: [], people: [],
  });
  assert.match(result.summaryText, /重点信息[\s\S]*确认上线/);
  assert.match(result.summaryText, /已确认决策[\s\S]*方案A/);
  assert.deepEqual(result.drafts, [{
    draftId: 'draft-1',
    fields: { 任务名: '完成首页', 截止日期: '2026-07-17 18:00', 优先级: 'P1', 负责人: 'ou_actor' },
    sourceSummary: '项目讨论',
  }]);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].intent.fields['负责人'], 'ou_actor');
  assert.doesNotMatch(JSON.stringify(result), /原始讨论|ou_other/);
});

test('retries a non-empty chat once when the model returns an empty summary', async () => {
  let calls = 0;
  const minimax = { async completeWithSystem() {
    calls += 1;
    return JSON.stringify(calls === 1
      ? { summary: { important: [], decisions: [], todos: [], risks: [], people: [] }, taskDrafts: [] }
      : { summary: { important: ['确认上线'], decisions: [], todos: [], risks: [], people: [] }, taskDrafts: [] });
  } };

  const result = await createChatSummary({ minimax, taskService: { async prepare() {} } }).summarize([
    { text: '今天确认上线。' },
  ], 'ou_actor');

  assert.equal(calls, 2);
  assert.match(result.summaryText, /确认上线/);
});

test('rejects a false-success empty summary after retrying', async () => {
  let calls = 0;
  const minimax = { async completeWithSystem() {
    calls += 1;
    return JSON.stringify({ summary: { important: [], decisions: [], todos: [], risks: [], people: [] }, taskDrafts: [] });
  } };

  await assert.rejects(
    () => createChatSummary({ minimax, taskService: { async prepare() {} } }).summarize([{ text: '有内容' }], 'ou_actor'),
    /Chat summary returned no content/,
  );
  assert.equal(calls, 2);
});
