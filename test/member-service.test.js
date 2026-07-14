import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberService } from '../src/member-service.js';

test('matches leaders by owner open id and caches members in process', async () => {
  let calls = 0;
  const base = { async listMembers() {
    calls += 1;
    return [
      { openId: 'ou_owner', name: '张三', leaderOpenIds: ['ou_leader_1', 'ou_leader_2'] },
      { openId: 'ou_same_name', name: '张三', leaderOpenIds: ['ou_other'] },
    ];
  } };
  const members = createMemberService({ base });

  assert.deepEqual(await members.leadersByOwner('ou_owner'), ['ou_leader_1', 'ou_leader_2']);
  assert.deepEqual(await members.leadersByOwner('ou_missing'), []);
  assert.equal(calls, 1);
  assert.equal((await members.resolveByName('张三')).length, 2);
});

test('refresh explicitly replaces the cached member list', async () => {
  let current = [{ openId: 'ou_owner', name: '张三', leaderOpenIds: ['ou_old'] }];
  const base = { async listMembers() { return current; } };
  const members = createMemberService({ base });

  assert.deepEqual(await members.leadersByOwner('ou_owner'), ['ou_old']);
  current = [{ openId: 'ou_owner', name: '张三', leaderOpenIds: ['ou_new'] }];
  await members.refresh();
  assert.deepEqual(await members.leadersByOwner('ou_owner'), ['ou_new']);
});
