import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskService } from '../src/task-service.js';

function fixture({ tasks = [], members = [] } = {}) {
  const writes = [];
  const actions = new Map();
  let sequence = 0;
  const base = {
    async searchTasks(selector) { base.selector = selector; return tasks; },
    async createTask(fields) { writes.push(['create', fields]); },
    async updateTask(recordId, fields) { writes.push(['update', recordId, fields]); },
    async deleteTask(recordId) { writes.push(['delete', recordId]); },
  };
  const confirmations = {
    async create(actorOpenId, action) { const id = `cfm-${++sequence}`; actions.set(id, { actorOpenId, action, consumed: false }); return id; },
    async consume(id, actorOpenId) {
      const item = actions.get(id);
      if (!item || item.actorOpenId !== actorOpenId || item.consumed) return null;
      item.consumed = true;
      return item.action;
    },
  };
  return {
    service: createTaskService({
      base,
      members: { async resolveByName(name) { return members.filter((member) => member.name === name); } },
      confirmations,
      clock: () => 1_784_000_000_000,
    }),
    base,
    writes,
  };
}

const task = {
  recordId: 'rec1', name: '首页设计', ownerOpenId: 'ou_owner', ownerName: '张三',
  status: '进行中', progress: 60, deadline: 1_784_041_200_000, blocker: '', priority: 'P1',
};

test('queries tasks without creating a confirmation or writing Base', async () => {
  const { service, base, writes } = fixture({ tasks: [task] });
  const result = await service.prepare({ operation: 'query_tasks', selector: { name: '首页' }, fields: {} }, 'ou_actor');

  assert.equal(result.kind, 'result');
  assert.match(result.text, /首页设计/);
  assert.deepEqual(base.selector, { name: '首页' });
  assert.deepEqual(writes, []);
});

test('returns task candidates when a selector matches multiple tasks', async () => {
  const second = { ...task, recordId: 'rec2', name: '首页开发', ownerName: '李四' };
  const { service } = fixture({ tasks: [task, second] });
  assert.deepEqual(
    await service.prepare({ operation: 'delete_task', selector: { name: '首页' }, fields: {} }, 'ou_actor'),
    { kind: 'disambiguation', candidates: [
      { recordId: 'rec1', name: '首页设计', ownerName: '张三', deadline: 1_784_041_200_000 },
      { recordId: 'rec2', name: '首页开发', ownerName: '李四', deadline: 1_784_041_200_000 },
    ] },
  );
});

test('requires a blocker before preparing a blocked-task update', async () => {
  const { service, writes } = fixture({ tasks: [task] });
  assert.deepEqual(
    await service.prepare({ operation: 'block_task', selector: { name: '首页' }, fields: {} }, 'ou_actor'),
    { kind: 'need_input', field: '阻塞原因', text: '请提供阻塞原因。' },
  );
  assert.deepEqual(writes, []);
});

test('requires a new deadline before preparing postponement', async () => {
  const { service } = fixture({ tasks: [task] });
  assert.deepEqual(
    await service.prepare({ operation: 'postpone_task', selector: { name: '首页' }, fields: {} }, 'ou_actor'),
    { kind: 'need_input', field: '截止日期', text: '请提供新的截止日期。' },
  );
});

test('prepares create and delete previews without writing Base', async () => {
  const created = fixture();
  const create = await created.service.prepare({ operation: 'create_task', selector: {}, fields: { 任务名: '新任务' } }, 'ou_actor');
  assert.deepEqual(create.preview, { operation: 'create_task', before: null, after: { 任务名: '新任务' } });
  assert.match(create.confirmationId, /^cfm-/);
  assert.deepEqual(created.writes, []);

  const deleted = fixture({ tasks: [task] });
  const remove = await deleted.service.prepare({ operation: 'delete_task', selector: { name: '首页设计' }, fields: {} }, 'ou_actor');
  assert.deepEqual(remove.preview, { operation: 'delete_task', before: task, after: null });
  assert.deepEqual(deleted.writes, []);
});

test('forces the complete-task patch instead of trusting model fields', async () => {
  const { service, writes } = fixture({ tasks: [task] });
  const prepared = await service.prepare({
    operation: 'complete_task', selector: { name: '首页设计' }, fields: { 状态: '未开始', 进度: 1, 完成时间: 2 },
  }, 'ou_actor');

  assert.equal(prepared.preview.operation, 'complete_task');
  assert.deepEqual(prepared.preview.after, {
    ...task, 状态: '已完成', 进度: 100, 完成时间: 1_784_000_000_000,
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(await service.confirm(prepared.confirmationId, 'ou_actor'), { kind: 'result', text: '操作成功。' });
  assert.deepEqual(writes, [['update', 'rec1', { 状态: '已完成', 进度: 100, 完成时间: 1_784_000_000_000 }]]);
});

test('resolves an owner name before preparing an owner change', async () => {
  const { service, writes } = fixture({ tasks: [task], members: [{ name: '李四', openId: 'ou_next' }] });
  const prepared = await service.prepare({
    operation: 'update_task', selector: { name: '首页设计' }, fields: { 负责人: '李四' },
  }, 'ou_actor');

  assert.equal(prepared.kind, 'confirmation');
  assert.equal(prepared.preview.after['负责人'], 'ou_next');
  assert.deepEqual(writes, []);
  await service.confirm(prepared.confirmationId, 'ou_actor');
  assert.deepEqual(writes, [['update', 'rec1', { 负责人: 'ou_next' }]]);
});

test('consumes a confirmation before writing and never writes it twice', async () => {
  const { service, writes } = fixture({ tasks: [task] });
  const prepared = await service.prepare({ operation: 'delete_task', selector: { name: '首页设计' }, fields: {} }, 'ou_actor');

  assert.deepEqual(await service.confirm(prepared.confirmationId, 'ou_other'), { kind: 'result', text: '该操作已处理。' });
  assert.deepEqual(writes, []);
  assert.deepEqual(await service.confirm(prepared.confirmationId, 'ou_actor'), { kind: 'result', text: '操作成功。' });
  assert.deepEqual(await service.confirm(prepared.confirmationId, 'ou_actor'), { kind: 'result', text: '该操作已处理。' });
  assert.deepEqual(writes, [['delete', 'rec1']]);
});
