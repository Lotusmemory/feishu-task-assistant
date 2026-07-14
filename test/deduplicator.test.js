import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeduplicator } from '../src/deduplicator.js';

test('claims each message id once', () => {
  const deduplicator = createDeduplicator();
  assert.equal(deduplicator.claim('om_1'), true);
  assert.equal(deduplicator.claim('om_1'), false);
  assert.equal(deduplicator.claim('om_2'), true);
});
