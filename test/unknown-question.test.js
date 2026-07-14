import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnknownQuestionService, normalizeQuestion } from '../src/unknown-question.js';

test('normalizes whitespace, case and common punctuation', () => {
  assert.equal(normalizeQuestion('  VPN   怎么用？ '), 'vpn 怎么用');
});

test('creates anonymously unless callback is explicitly requested', async () => {
  const created = [];
  const service = createUnknownQuestionService({
    base: { findQuestion: async () => null, createQuestion: async (value) => created.push(value) },
    now: () => 123,
  });
  await service.record({ question: '食堂在哪', requesterOpenId: 'ou_secret', callbackRequested: false });
  await service.record({ question: '停车在哪', requesterOpenId: 'ou_callback', callbackRequested: true });
  assert.equal(created[0].callbackUser, undefined);
  assert.equal(created[1].callbackUser, 'ou_callback');
});

test('increments an existing normalized question', async () => {
  let incremented;
  const service = createUnknownQuestionService({
    base: {
      findQuestion: async () => ({ recordId: 'rec1', count: 2 }),
      incrementQuestion: async (...args) => { incremented = args; },
    }, now: () => 123,
  });
  await service.record({ question: '食堂在哪' });
  assert.deepEqual(incremented, ['rec1', { count: 3, now: 123, callbackUser: undefined }]);
});
