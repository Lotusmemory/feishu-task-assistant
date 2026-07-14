import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskService } from '../src/task-service.js';

function fixture({ tasks = [], members = [], baseOverrides = {} } = {}) {
  const writes = [];
  const actions = new Map();
  let sequence = 0;
  const base = {
    async searchTasks(selector) { base.selector = selector; return tasks; },
    async createTask(fields) { writes.push(['create', fields]); return baseOverrides.createTask?.(fields); },
    async updateTask(recordId, fields) { writes.push(['update', recordId, fields]); return baseOverrides.updateTask?.(recordId, fields); },
    async deleteTask(recordId) { writes.push(['delete', recordId]); return baseOverrides.deleteTask?.(recordId); },
  };
  const confirmations = {
    async create(actorOpenId, action) { const id = `cfm-${++sequence}`; actions.set(id, { actorOpenId, action, status: 'pending' }); return id; },
    async begin(id, actorOpenId) {
      const item = actions.get(id);
      if (!item || item.actorOpenId !== actorOpenId || !['pending', 'failed'].includes(item.status)) return null;
      item.status = 'executing';
      return item.action;
    },
    async cancel(id, actorOpenId) {
      const item = actions.get(id);
      if (!item || item.actorOpenId !== actorOpenId || !['pending', 'failed'].includes(item.status)) return false;
      item.status = 'cancelled';
      return true;
    },
    async markSucceeded(id, actorOpenId) {
      const item = actions.get(id);
      if (item?.actorOpenId === actorOpenId && item.status === 'executing') item.status = 'succeeded';
    },
    async markFailed(id, actorOpenId) {
      const item = actions.get(id);
      if (item?.actorOpenId === actorOpenId && item.status === 'executing') item.status = 'failed';
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

test('successful confirmation never writes twice', async () => {
  const { service, writes } = fixture({ tasks: [task] });
  const prepared = await service.prepare({ operation: 'delete_task', selector: { name: '首页设计' }, fields: {} }, 'ou_actor');

  assert.deepEqual(await service.confirm(prepared.confirmationId, 'ou_other'), { kind: 'result', text: '该操作已处理。' });
  assert.deepEqual(writes, []);
  assert.deepEqual(await service.confirm(prepared.confirmationId, 'ou_actor'), { kind: 'result', text: '操作成功。' });
  assert.deepEqual(await service.confirm(prepared.confirmationId, 'ou_actor'), { kind: 'result', text: '该操作已处理。' });
  assert.deepEqual(writes, [['delete', 'rec1']]);
});

test('retries a confirmation after a transient Base failure', async () => {
  let attempts = 0;
  const { service, writes } = fixture({
    tasks: [task],
    baseOverrides: { async deleteTask() { attempts += 1; if (attempts === 1) throw new Error('transient'); } },
  });
  const prepared = await service.prepare({ operation: 'delete_task', selector: { name: '首页设计' }, fields: {} }, 'ou_actor');

  await assert.rejects(() => service.confirm(prepared.confirmationId, 'ou_actor'), /transient/);
  assert.deepEqual(await service.confirm(prepared.confirmationId, 'ou_actor'), { kind: 'result', text: '操作成功。' });
  assert.equal(attempts, 2);
  assert.deepEqual(writes, [['delete', 'rec1'], ['delete', 'rec1']]);
});

test('concurrent confirmations allow only one Base writer', async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const { service, writes } = fixture({
    tasks: [task],
    baseOverrides: { async deleteTask() { entered(); await blocked; } },
  });
  const prepared = await service.prepare({ operation: 'delete_task', selector: { name: '首页设计' }, fields: {} }, 'ou_actor');

  const first = service.confirm(prepared.confirmationId, 'ou_actor');
  await started;
  assert.deepEqual(await service.confirm(prepared.confirmationId, 'ou_actor'), { kind: 'result', text: '该操作已处理。' });
  assert.equal(writes.length, 1);
  release();
  assert.deepEqual(await first, { kind: 'result', text: '操作成功。' });
  assert.equal(writes.length, 1);
});

test('cancels a prepared operation without writing Base', async () => {
  const { service, writes } = fixture({ tasks: [task] });
  const prepared = await service.prepare({ operation: 'delete_task', selector: { name: '首页设计' }, fields: {} }, 'ou_actor');

  assert.deepEqual(await service.cancel(prepared.confirmationId, 'ou_actor'), { kind: 'result', text: '操作已取消。' });
  assert.deepEqual(await service.confirm(prepared.confirmationId, 'ou_actor'), { kind: 'result', text: '该操作已处理。' });
  assert.deepEqual(writes, []);
});
