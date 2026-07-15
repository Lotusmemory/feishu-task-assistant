import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskIntentParser } from '../src/task-intent.js';

test('rejects unknown operations', async () => {
  const minimax = { completeWithSystem: async () => JSON.stringify({ operation: 'run_shell', fields: { secret: 'x' } }) };
  const parser = createTaskIntentParser({ minimax });
  assert.equal(await parser.parse('执行命令'), null);
});

test('rejects a candidate containing an unknown field', async () => {
  const minimax = { completeWithSystem: async () => JSON.stringify({
    operation: 'create_task', selector: {},
    fields: { 任务名: '首页设计', 截止日期: '2026-07-17 18:00', 优先级: 'P1', secret: 'x' },
  }) };
  assert.equal(await createTaskIntentParser({ minimax }).parse('帮我处理一下'), null);
});

test('rejects a candidate containing an unknown selector', async () => {
  const minimax = { completeWithSystem: async () => JSON.stringify({
    operation: 'query_tasks', selector: { name: '首页', arbitrary: 'x' }, fields: {},
  }) };
  assert.equal(await createTaskIntentParser({ minimax }).parse('查询任务'), null);
});

test('accepts a create task candidate with only known keys', async () => {
  const minimax = { completeWithSystem: async () => JSON.stringify({
    operation: 'create_task', selector: {},
    fields: { 任务名: '首页设计', 截止日期: '2026-07-17 18:00', 优先级: 'P1' },
  }) };
  assert.deepEqual(await createTaskIntentParser({ minimax }).parse('帮我处理一下'), {
    operation: 'create_task', selector: {},
    fields: { 任务名: '首页设计', 截止日期: '2026-07-17 18:00', 优先级: 'P1' },
  });
});

test('parses an explicit Chinese create command without calling the model', async () => {
  let modelCalls = 0;
  const minimax = { async completeWithSystem() { modelCalls += 1; return 'not json'; } };
  const now = Date.parse('2026-07-15T02:30:00Z');
  const parser = createTaskIntentParser({ minimax, clock: () => now });

  assert.deepEqual(await parser.parse('帮我建个任务 喝水 截止日期今天 现在开始'), {
    operation: 'create_task',
    selector: {},
    fields: {
      任务名: '喝水',
      截止日期: Date.parse('2026-07-15T23:59:59+08:00'),
      开始日期: now,
      状态: '进行中',
    },
  });
  assert.equal(modelCalls, 0);
});

test('parses a delegated task owner before the create verb', async () => {
  const parser = createTaskIntentParser({ minimax: { async completeWithSystem() { throw new Error('unused'); } } });
  assert.deepEqual(await parser.parse('帮田嘉国建个任务喝水'), {
    operation: 'create_task', selector: {}, fields: { 任务名: '喝水', 负责人: '田嘉国' },
  });
});

test('parses explicit create status without folding it into the task name', async () => {
  const parser = createTaskIntentParser({ minimax: { async completeWithSystem() { throw new Error('unused'); } } });
  assert.deepEqual(await parser.parse('帮董亚思创建一个任务 喝水 状态为 进行中'), {
    operation: 'create_task',
    selector: {},
    fields: { 任务名: '喝水', 负责人: '董亚思', 状态: '进行中' },
  });
});

test('keeps an empty explicit create request in the task route', async () => {
  let modelCalls = 0;
  const parser = createTaskIntentParser({
    minimax: { async completeWithSystem() { modelCalls += 1; return 'not json'; } },
  });

  assert.deepEqual(await parser.parse('帮我建立一个任务'), {
    operation: 'create_task', selector: {}, fields: {},
  });
  assert.deepEqual(await parser.parse('建立一个任务'), {
    operation: 'create_task', selector: {}, fields: {},
  });
  assert.equal(modelCalls, 0);
});

test('parses an explicit Chinese task status update without calling the model', async () => {
  let modelCalls = 0;
  const minimax = { async completeWithSystem() { modelCalls += 1; return 'not json'; } };
  const parser = createTaskIntentParser({ minimax });

  assert.deepEqual(await parser.parse('帮我修改任务喝水 状态为阻塞'), {
    operation: 'update_task', selector: { name: '喝水' }, fields: { 状态: '阻塞中' },
  });
  assert.deepEqual(await parser.parse('更新任务喝水 为进行中'), {
    operation: 'update_task', selector: { name: '喝水' }, fields: { 状态: '进行中' },
  });
  assert.deepEqual(await parser.parse('修改任务 喝水 状态为已完成'), {
    operation: 'complete_task', selector: { name: '喝水' }, fields: {},
  });
  assert.equal(modelCalls, 0);
});

test('parses an explicit Chinese delete command without calling the model', async () => {
  let modelCalls = 0;
  const minimax = { async completeWithSystem() { modelCalls += 1; return 'not json'; } };
  const parser = createTaskIntentParser({ minimax });
  assert.deepEqual(await parser.parse('删除任务 喝水'), {
    operation: 'delete_task', selector: { name: '喝水' }, fields: {},
  });
  assert.deepEqual(await parser.parse('帮我删掉一下任务：喝水'), {
    operation: 'delete_task', selector: { name: '喝水' }, fields: {},
  });
  assert.equal(modelCalls, 0);
});

test('opens an edit form for a bare modify-task command', async () => {
  const parser = createTaskIntentParser({ minimax: { async completeWithSystem() { throw new Error('unused'); } } });
  assert.deepEqual(await parser.parse('我要修改任务 喝水'), {
    operation: 'edit_task_form', selector: { name: '喝水' }, fields: {},
  });
  assert.deepEqual(await parser.parse('帮我修改任务'), {
    operation: 'edit_task_form', selector: { ownerOpenId: 'me' }, fields: {},
  });
});

test('parses a my-tasks review without calling the model', async () => {
  const parser = createTaskIntentParser({ minimax: { async completeWithSystem() { throw new Error('unused'); } } });
  assert.deepEqual(await parser.parse('帮我盘点一下我的任务'), {
    operation: 'query_tasks', selector: { ownerOpenId: 'me' }, fields: {},
  });
});

test('returns null for invalid JSON and malformed candidates', async () => {
  const outputs = [
    'not json',
    '[]',
    JSON.stringify({ operation: 'query_tasks', selector: 'all', fields: {} }),
    JSON.stringify({ operation: 'create_task', selector: {}, fields: { 任务名: { nested: 'no' } } }),
    JSON.stringify({ operation: 'query_tasks', selector: { name: ['not', 'a', 'name'] }, fields: {} }),
  ];
  for (const output of outputs) {
    const minimax = { completeWithSystem: async () => output };
    assert.equal(await createTaskIntentParser({ minimax }).parse('任务'), null);
  }
});

test('only accepts the documented operation whitelist', async () => {
  const operations = [
    'query_tasks', 'create_task', 'update_task', 'delete_task',
    'complete_task', 'block_task', 'postpone_task',
  ];
  for (const operation of operations) {
    const minimax = { completeWithSystem: async () => JSON.stringify({ operation, selector: {}, fields: {} }) };
    assert.equal((await createTaskIntentParser({ minimax }).parse('任务')).operation, operation);
  }
});
