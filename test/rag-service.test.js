import test from 'node:test';
import assert from 'node:assert/strict';
import { createRagService } from '../src/rag-service.js';

test('answers only from matched knowledge and appends sources', async () => {
  let passages;
  const rag = createRagService({
    embedder: { embedQuery: async () => [1, 0] },
    getIndex: () => ({ search: () => [{
      answerText: '提前在飞书申请。', score: 0.8,
      metadata: { recordId: 'rec1', title: '年假申请', updatedAt: '2026-07-13', sourceUrl: 'https://example.test' },
    }] }),
    minimax: { answerWithKnowledge: async (_question, value) => { passages = value; return '请提前在飞书申请年假。'; } },
  });
  const result = await rag.answer('怎么休年假');
  assert.equal(result.matched, true);
  assert.equal(passages.length, 1);
  assert.match(result.text, /请提前.*来源：\s*- 年假申请.*2026-07-13.*https:\/\/example.test/s);
});

test('rejects safely without calling MiniMax when no knowledge matches', async () => {
  let called = false;
  const rag = createRagService({
    embedder: { embedQuery: async () => [1, 0] }, getIndex: () => ({ search: () => [] }),
    minimax: { answerWithKnowledge: async () => { called = true; } },
  });
  const result = await rag.answer('食堂在哪');
  assert.equal(result.matched, false);
  assert.equal(called, false);
  assert.match(result.text, /当前知识库暂无此信息/);
});
