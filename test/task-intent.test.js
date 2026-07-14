import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskIntentParser } from '../src/task-intent.js';

test('rejects unknown operations', async () => {
  const minimax = { completeWithSystem: async () => JSON.stringify({ operation: 'run_shell', fields: { secret: 'x' } }) };
  const parser = createTaskIntentParser({ minimax });
  assert.equal(await parser.parse('执行命令'), null);
});

test('accepts a create task candidate and strips unknown fields', async () => {
  const minimax = { completeWithSystem: async () => JSON.stringify({
    operation: 'create_task', selector: {},
    fields: { 任务名: '首页设计', 截止日期: '2026-07-17 18:00', 优先级: 'P1', secret: 'x' },
  }) };
  assert.deepEqual(await createTaskIntentParser({ minimax }).parse('创建任务'), {
    operation: 'create_task', selector: {},
    fields: { 任务名: '首页设计', 截止日期: '2026-07-17 18:00', 优先级: 'P1' },
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
