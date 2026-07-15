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

test('lists due tasks across pages and maps only required fields', async () => {
  const calls = [];
  const responses = [
    { code: 0, data: { has_more: true, page_token: 'next', items: [{ record_id: 'rec1', fields: {
      任务名: '首页设计', 负责人: [{ id: 'ou_owner', name: '张三' }], 状态: '进行中',
      进度: 60, 截止日期: 1784041200000, 优先级: 'P1', 阻塞原因: '', ignored: 'value',
    }}] } },
    { code: 0, data: { has_more: false, items: [] } },
  ];
  const client = { bitable: { v1: { appTableRecord: { list: async (payload) => {
    calls.push(payload);
    return responses.shift();
  } } } } };
  const base = createBaseClient({ client, baseToken: 'bas', knowledgeTableId: 'tbl1', questionsTableId: 'tbl2', tasksTableId: 'tbl_tasks' });

  const due = await base.listDueTasks({ startMs: 1783958400000, endMs: 1784044799999 });

  assert.equal(calls[0].path.table_id, 'tbl_tasks');
  assert.equal(calls[0].params.page_size, 500);
  assert.equal(calls[1].params.page_token, 'next');
  assert.deepEqual(due[0], {
    recordId: 'rec1', name: '首页设计', ownerOpenId: 'ou_owner', ownerName: '张三',
    status: '进行中', progress: 60, deadline: 1784041200000, priority: 'P1', blocker: '',
  });
});

test('searches tasks by name and owner open id', async () => {
  let payload;
  const client = { bitable: { v1: { appTableRecord: { list: async (value) => {
    payload = value;
    return { code: 0, data: { has_more: false, items: [] } };
  } } } } };
  const base = createBaseClient({ client, baseToken: 'bas', tasksTableId: 'tbl_tasks' });

  assert.deepEqual(await base.searchTasks({ name: '首页', ownerOpenId: 'ou_owner' }), []);
  assert.equal(payload.params.page_size, 500);
});

test('gets the current task by record id for callback ownership checks', async () => {
  let payload;
  const client = { bitable: { v1: { appTableRecord: { get: async (value) => {
    payload = value;
    return { code: 0, data: { record: { record_id: 'rec1', fields: {
      任务名: '首页设计', 负责人: [{ id: 'ou_owner', name: '张三' }], 状态: '进行中',
      进度: 60, 截止日期: 1784041200000, 优先级: 'P1', 阻塞原因: '',
    } } } };
  } } } } };
  const base = createBaseClient({ client, baseToken: 'bas', tasksTableId: 'tbl_tasks' });

  assert.deepEqual(await base.getTask('rec1'), {
    recordId: 'rec1', name: '首页设计', ownerOpenId: 'ou_owner', ownerName: '张三',
    status: '进行中', progress: 60, deadline: 1784041200000, priority: 'P1', blocker: '',
  });
  assert.deepEqual(payload.path, { app_token: 'bas', table_id: 'tbl_tasks', record_id: 'rec1' });
});

test('normalizes rich-text task fields returned by Base', async () => {
  const client = { bitable: { v1: { appTableRecord: {
    async get() { return { code: 0, data: { record: { record_id: 'rec1', fields: {
      任务名: [{ text: '喝水', type: 'text' }], 阻塞原因: [{ text: '等待', type: 'text' }],
    } } } }; },
  } } } };
  const base = createBaseClient({ client, baseToken: 'bas', tasksTableId: 'tbl_tasks' });
  const task = await base.getTask('rec1');
  assert.equal(task.name, '喝水');
  assert.equal(task.blocker, '等待');
});

test('creates, updates, and deletes tasks through the tasks table', async () => {
  const calls = [];
  const appTableRecord = {
    create: async (payload) => { calls.push(['create', payload]); return { code: 0, data: { record: { record_id: 'rec-new' } } }; },
    update: async (payload) => { calls.push(['update', payload]); return { code: 0, data: { record: { record_id: 'rec1' } } }; },
    delete: async (payload) => { calls.push(['delete', payload]); return { code: 0, data: {} }; },
  };
  const client = { bitable: { v1: { appTableRecord } } };
  const base = createBaseClient({ client, baseToken: 'bas', tasksTableId: 'tbl_tasks' });

  await base.createTask({ 任务名: '首页设计', 负责人: 'ou_owner', 协作人: ['ou_helper'], 状态: '未开始' });
  await base.updateTask('rec1', { 进度: 60, 负责人: 'ou_next' });
  await base.deleteTask('rec1');

  assert.equal(calls[0][1].path.table_id, 'tbl_tasks');
  assert.deepEqual(calls[0][1].data.fields['负责人'], [{ id: 'ou_owner' }]);
  assert.deepEqual(calls[0][1].data.fields['协作人'], [{ id: 'ou_helper' }]);
  assert.equal(calls[1][1].path.record_id, 'rec1');
  assert.deepEqual(calls[1][1].data.fields['负责人'], [{ id: 'ou_next' }]);
  assert.equal(calls[2][1].path.table_id, 'tbl_tasks');
  assert.equal(calls[2][1].path.record_id, 'rec1');
});

test('rejects non-writable task fields and empty delete record ids', async () => {
  const client = { bitable: { v1: { appTableRecord: {} } } };
  const base = createBaseClient({ client, baseToken: 'bas', tasksTableId: 'tbl_tasks' });

  await assert.rejects(() => base.createTask({ 系统字段: 'no' }), /系统字段/);
  await assert.rejects(() => base.updateTask('rec1', { 任务名: 'ok', 公式字段: 1 }), /公式字段/);
  await assert.rejects(() => base.deleteTask(''), /recordId/);
});

test('lists members and maps people fields by open id', async () => {
  const calls = [];
  const client = { bitable: { v1: { appTableRecord: { list: async (payload) => {
    calls.push(payload);
    return { code: 0, data: { has_more: false, items: [
      { record_id: 'member-rec', fields: {
        成员: [{ id: 'ou_owner', name: '张三' }], 姓名: '姓名文本不覆盖人员名称',
        leaders: [{ id: 'ou_leader_1', name: '李经理' }, { id: 'ou_leader_2', name: '王经理' }],
      } },
      { record_id: 'member-without-person', fields: {
        姓名: '仅有姓名文本', leaders: [{ id: 'ou_leader_3', name: '赵经理' }],
      } },
    ] } };
  } } } } };
  const base = createBaseClient({ client, baseToken: 'bas', membersTableId: 'tbl_members' });

  assert.deepEqual(await base.listMembers(), [
    {
      recordId: 'member-rec', openId: 'ou_owner', name: '张三',
      leaderOpenIds: ['ou_leader_1', 'ou_leader_2'],
    },
    {
      recordId: 'member-without-person', openId: '', name: '仅有姓名文本',
      leaderOpenIds: ['ou_leader_3'],
    },
  ]);
  assert.equal(calls[0].path.table_id, 'tbl_members');
});
