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
      createdAt: 1_784_000_000_000, expiresAt: 1_784_000_600_000, consumedAt: null,
    },
  } });
  assert.deepEqual(await confirmations.get(id, 'ou_a'), store.snapshot().confirmations[id]);
});

test('an actor cannot consume another actor confirmation', async () => {
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 1_000, clock: () => 100, idFactory: () => 'cfm' });
  await confirmations.create('ou_b', { operation: 'delete_task' });

  assert.equal(await confirmations.consume('cfm', 'ou_a'), null);
  assert.equal(store.snapshot().confirmations.cfm.consumedAt, null);
});

test('expired confirmations are unavailable and cannot be consumed', async () => {
  let now = 100;
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 10, clock: () => now, idFactory: () => 'cfm' });
  await confirmations.create('ou_a', { operation: 'delete_task' });
  now = 111;

  assert.equal(await confirmations.get('cfm', 'ou_a'), null);
  assert.equal(await confirmations.consume('cfm', 'ou_a'), null);
});

test('a confirmation expires exactly at its expiry timestamp', async () => {
  let now = 100;
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 10, clock: () => now, idFactory: () => 'cfm' });
  await confirmations.create('ou_a', { operation: 'delete_task' });
  now = 110;

  assert.equal(await confirmations.get('cfm', 'ou_a'), null);
  assert.equal(await confirmations.consume('cfm', 'ou_a'), null);
});

test('a confirmation can only be consumed once', async () => {
  let now = 100;
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 1_000, clock: () => now, idFactory: () => 'cfm' });
  await confirmations.create('ou_a', { operation: 'delete_task', recordId: 'rec1' });
  now = 101;

  assert.deepEqual(await confirmations.consume('cfm', 'ou_a'), { operation: 'delete_task', recordId: 'rec1' });
  assert.equal(store.snapshot().confirmations.cfm.consumedAt, 101);
  assert.equal(await confirmations.consume('cfm', 'ou_a'), null);
});

test('concurrent consumers only receive one action', async () => {
  const store = createMemoryStore();
  const confirmations = createConfirmationStore({ store, ttlMs: 1_000, clock: () => 100, idFactory: () => 'cfm' });
  const action = { operation: 'delete_task', recordId: 'rec1' };
  await confirmations.create('ou_a', action);

  const results = await Promise.all([
    confirmations.consume('cfm', 'ou_a'),
    confirmations.consume('cfm', 'ou_a'),
  ]);
  assert.deepEqual(results.filter(Boolean), [action]);
});
