import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderService } from '../src/reminder-service.js';

const task = (overrides) => ({
  recordId: 'r-default',
  name: '默认任务',
  ownerOpenId: 'ou_a',
  ownerName: 'A负责人',
  status: '进行中',
  progress: 0,
  deadline: 300,
  priority: 'P2',
  blocker: '',
  ...overrides,
});

test('builds stable owner reminders and read-only leader summaries', async () => {
  const window = { startMs: 100, endMs: 500 };
  const calls = [];
  const dueTasks = [
    task({ recordId: 'r-a-2', name: '任务乙', ownerOpenId: 'ou_a', ownerName: '旧姓名', priority: 'P1', deadline: 300 }),
    task({ recordId: 'r-missing', name: '缺成员任务', ownerOpenId: 'ou_missing', ownerName: 'C负责人', priority: 'P3', deadline: 200 }),
    task({ recordId: 'r-b', name: '共享负责人任务', ownerOpenId: 'ou_b', ownerName: '旧姓名', priority: 'P2', deadline: 100 }),
    task({ recordId: 'r-a-0', name: '最高优先任务', ownerOpenId: 'ou_a', ownerName: '旧姓名', priority: 'P0', deadline: 400 }),
    task({ recordId: 'r-a-1', name: '任务甲', ownerOpenId: 'ou_a', ownerName: '旧姓名', priority: 'P1', deadline: 200 }),
  ];
  const completedTask = task({ recordId: 'r-done', name: '已完成任务', status: '已完成' });
  const activeOutsideDueWindow = task({
    recordId: 'r-active', name: '非今日截止任务', ownerOpenId: 'ou_b', ownerName: '旧姓名', deadline: 900,
  });
  const memberRows = [
    { openId: 'ou_b', name: 'B负责人', leaderOpenIds: ['ou_shared'] },
    { openId: 'ou_a', name: 'A负责人', leaderOpenIds: ['ou_shared', 'ou_extra'] },
  ];
  const leaders = new Map(memberRows.map((member) => [member.openId, member.leaderOpenIds]));
  const base = { async listDueTasks(receivedWindow) {
    calls.push(['listDueTasks', receivedWindow]);
    // 模拟 Base 查询过滤；聚合层只消费查询结果，不重复实现状态筛选。
    return [...dueTasks, completedTask].filter((item) => item.status !== '已完成');
  }, async listLeaderReportTasks(receivedWindow) {
    calls.push(['listLeaderReportTasks', receivedWindow]);
    return [activeOutsideDueWindow, completedTask];
  } };
  const members = {
    async refresh() { calls.push(['refresh']); return memberRows; },
    async leadersByOwner(openId) { calls.push(['leadersByOwner', openId]); return leaders.get(openId) || []; },
  };

  const plan = await createReminderService({ base, members }).buildPlan(window);

  assert.deepEqual(calls, [
    ['refresh'],
    ['listDueTasks', window],
    ['listLeaderReportTasks', window],
    ['leadersByOwner', 'ou_a'],
    ['leadersByOwner', 'ou_b'],
  ]);
  assert.deepEqual(plan, {
    owners: [
      { openId: 'ou_a', tasks: [dueTasks[3], dueTasks[4], dueTasks[0]] },
      { openId: 'ou_b', tasks: [dueTasks[2]] },
      { openId: 'ou_missing', tasks: [dueTasks[1]] },
    ],
    leaders: [
      { openId: 'ou_extra', owners: [
        { openId: 'ou_a', name: 'A负责人', tasks: [completedTask] },
      ] },
      { openId: 'ou_shared', owners: [
        { openId: 'ou_a', name: 'A负责人', tasks: [completedTask] },
        { openId: 'ou_b', name: 'B负责人', tasks: [activeOutsideDueWindow] },
      ] },
    ],
    warnings: [{ ownerOpenId: 'ou_missing', reason: 'member_not_found' }],
  });
  assert.equal(JSON.stringify(plan.owners).includes(completedTask.recordId), false);
  assert.equal(JSON.stringify(plan.leaders).includes(completedTask.recordId), true);
});

test('leader plans never contain action or button fields', async () => {
  const base = { async listDueTasks() { return []; }, async listLeaderReportTasks() {
    return [task({ recordId: 'r1', action: { type: 'complete' }, button: '确认' })];
  } };
  const members = {
    async refresh() { return [{ openId: 'ou_a', name: 'A负责人', leaderOpenIds: ['ou_leader'] }]; },
    async leadersByOwner() { return ['ou_leader']; },
  };

  const { leaders } = await createReminderService({ base, members }).buildPlan({ startMs: 100, endMs: 500 });
  const serialized = JSON.stringify(leaders);

  assert.doesNotMatch(serialized, /"(?:action|button)"/);
});

test('sorts tasks with the documented stable comparator', async () => {
  const dueTasks = [
    task({ recordId: 'p3', priority: 'P3' }),
    task({ recordId: 'p1-late', priority: 'P1', deadline: 400 }),
    task({ recordId: 'p1-name-b', name: 'B任务', priority: 'P1', deadline: 200 }),
    task({ recordId: 'p2', priority: 'P2' }),
    task({ recordId: 'p0', priority: 'P0' }),
    task({ recordId: 'p1-name-a', name: 'A任务', priority: 'P1', deadline: 200 }),
  ];
  const base = { async listDueTasks() { return dueTasks; }, async listLeaderReportTasks() { return []; } };
  const members = {
    async refresh() { return [{ openId: 'ou_a', name: 'A负责人', leaderOpenIds: [] }]; },
    async leadersByOwner() { return []; },
  };

  const plan = await createReminderService({ base, members }).buildPlan({ startMs: 100, endMs: 500 });

  assert.deepEqual(plan.owners[0].tasks.map(({ recordId }) => recordId), [
    'p0', 'p1-name-a', 'p1-name-b', 'p1-late', 'p2', 'p3',
  ]);
});
