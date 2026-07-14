import test from 'node:test';
import assert from 'node:assert/strict';
import { createBaseClient } from '../src/base-client.js';

test('maps only published knowledge returned by Base', async () => {
  const calls = [];
  const client = { bitable: { v1: { appTableRecord: { list: async (payload) => {
    calls.push(payload);
    return { code: 0, data: { has_more: false, items: [{ record_id: 'rec1', fields: {
      标题: '年假', 分类: 'HR', 适用问题: '怎么请假', 正文: '流程正文', 关键词: '年假',
      来源链接: { link: 'https://example.test', text: '制度原文' }, 状态: '已发布', 更新时间: 1783908000000,
    }}] } };
  } } } } };
  const base = createBaseClient({ client, baseToken: 'bas', knowledgeTableId: 'tbl1', questionsTableId: 'tbl2' });
  assert.deepEqual(await base.listPublishedKnowledge(), [{
    recordId: 'rec1', title: '年假', category: 'HR', questions: '怎么请假', body: '流程正文',
    keywords: '年假', sourceUrl: 'https://example.test', status: '已发布', updatedAt: 1783908000000,
  }]);
  assert.equal(calls[0].params.filter, 'CurrentValue.[状态] = "已发布"');
});

test('creates an anonymous unknown question without callback identity', async () => {
  let payload;
  const client = { bitable: { v1: { appTableRecord: { create: async (value) => {
    payload = value; return { code: 0, data: { record: { record_id: 'rec-new' } } };
  } } } } };
  const base = createBaseClient({ client, baseToken: 'bas', knowledgeTableId: 'tbl1', questionsTableId: 'tbl2' });
  await base.createQuestion({ original: '食堂在哪', normalized: '食堂在哪', category: '其他', now: 1783908000000 });
  assert.equal(payload.data.fields['回访用户'], undefined);
  assert.equal(payload.data.fields['是否要求回访'], false);
  assert.equal(payload.data.fields['状态'], '待补充');
});
