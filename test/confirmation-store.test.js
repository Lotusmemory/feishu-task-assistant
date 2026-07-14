import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmationStore } from '../src/confirmation-store.js';

function createMemoryStore(initial = { confirmations: {} }) {
  let state = structuredClone(initial);
  let queue = Promise.resolve();
  return {
    async read() { return structuredClone(state); },
    update(mutator) {
      const operation = queue.then(async () => {
        state = await mutator(structuredClone(state));
        return structuredClone(state);
      });
      queue = operation.catch(() => {});
      return operation;
    },
    snapshot() { return structuredClone(state); },
  };
}

test('persists confirmations with the fixed shape and returns them to their actor', async () => {
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 600_000, clock: () => 1_784_000_000_000, idFactory: () => 'cfm-id' });
  const id = await confirmations.create('ou_a', { operation: 'delete_task', recordId: 'rec1' });

  assert.equal(id, 'cfm-id');
  assert.deepEqual(store.snapshot(), { confirmations: {
    'cfm-id': {
      actorOpenId: 'ou_a', action: { operation: 'delete_task', recordId: 'rec1' },
      createdAt: 1_784_000_000_000, expiresAt: 1_784_000_600_000,
      status: 'pending', startedAt: null, succeededAt: null, failedAt: null,
    },
  } });
  assert.deepEqual(await confirmations.get(id, 'ou_a'), store.snapshot().confirmations[id]);
});

test('an actor cannot begin another actor confirmation', async () => {
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 1_000, clock: () => 100, idFactory: () => 'cfm' });
  await confirmations.create('ou_b', { operation: 'delete_task' });

  assert.equal(await confirmations.begin('cfm', 'ou_a'), null);
  assert.equal(store.snapshot().confirmations.cfm.status, 'pending');
});

test('expired confirmations are unavailable and cannot begin', async () => {
  let now = 100;
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 10, clock: () => now, idFactory: () => 'cfm' });
  await confirmations.create('ou_a', { operation: 'delete_task' });
  now = 111;

  assert.equal(await confirmations.get('cfm', 'ou_a'), null);
  assert.equal(await confirmations.begin('cfm', 'ou_a'), null);
});

test('a confirmation expires exactly at its expiry timestamp', async () => {
  let now = 100;
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 10, clock: () => now, idFactory: () => 'cfm' });
  await confirmations.create('ou_a', { operation: 'delete_task' });
  now = 110;

  assert.equal(await confirmations.get('cfm', 'ou_a'), null);
  assert.equal(await confirmations.begin('cfm', 'ou_a'), null);
});

test('a confirmation moves from pending through executing to succeeded', async () => {
  let now = 100;
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 1_000, clock: () => now, idFactory: () => 'cfm' });
  await confirmations.create('ou_a', { operation: 'delete_task', recordId: 'rec1' });
  now = 101;

  assert.deepEqual(await confirmations.begin('cfm', 'ou_a'), { operation: 'delete_task', recordId: 'rec1' });
  assert.equal(store.snapshot().confirmations.cfm.status, 'executing');
  assert.equal(store.snapshot().confirmations.cfm.startedAt, 101);
  assert.equal(await confirmations.begin('cfm', 'ou_a'), null);
  now = 102;
  await confirmations.markSucceeded('cfm', 'ou_a');
  assert.equal(store.snapshot().confirmations.cfm.status, 'succeeded');
  assert.equal(store.snapshot().confirmations.cfm.succeededAt, 102);
  assert.equal(await confirmations.begin('cfm', 'ou_a'), null);
});

test('a failed confirmation can be begun again by the same actor', async () => {
  let now = 100;
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 1_000, clock: () => now, idFactory: () => 'cfm' });
  const action = { operation: 'delete_task', recordId: 'rec1' };
  await confirmations.create('ou_a', action);
  await confirmations.begin('cfm', 'ou_a');
  now = 101;
  await confirmations.markFailed('cfm', 'ou_a');

  assert.equal(store.snapshot().confirmations.cfm.status, 'failed');
  assert.equal(store.snapshot().confirmations.cfm.failedAt, 101);
  assert.deepEqual(await confirmations.begin('cfm', 'ou_a'), action);
  assert.equal(store.snapshot().confirmations.cfm.status, 'executing');
});

test('concurrent begin calls only return one action', async () => {
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 1_000, clock: () => 100, idFactory: () => 'cfm' });
  const action = { operation: 'delete_task', recordId: 'rec1' };
  await confirmations.create('ou_a', action);

  const results = await Promise.all([
    confirmations.begin('cfm', 'ou_a'),
    confirmations.begin('cfm', 'ou_a'),
  ]);
  assert.deepEqual(results.filter(Boolean), [action]);
});

test('only the owning actor can cancel a pending confirmation', async () => {
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 1_000, clock: () => 100, idFactory: () => 'cfm' });
  await confirmations.create('ou_a', { operation: 'delete_task' });

  assert.equal(await confirmations.cancel('cfm', 'ou_b'), false);
  assert.equal(await confirmations.cancel('cfm', 'ou_a'), true);
  assert.equal(store.snapshot().confirmations.cfm.status, 'cancelled');
  assert.equal(await confirmations.begin('cfm', 'ou_a'), null);
  assert.equal(await confirmations.cancel('cfm', 'ou_a'), false);
});
