import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkKnowledge } from '../src/chunker.js';

const record = {
  recordId: 'rec1', title: '年假申请', category: 'HR', questions: '怎么休年假',
  keywords: '年假 请假', body: '第一段流程。\n\n第二段注意事项。', status: '已发布',
  updatedAt: '2026-07-13 10:00:00', sourceUrl: 'https://example.test/leave',
};

test('ignores unpublished knowledge', () => {
  assert.deepEqual(chunkKnowledge({ ...record, status: '待审核' }), []);
});

test('splits paragraphs and preserves retrieval text and source metadata', () => {
  const chunks = chunkKnowledge(record, { maxChars: 20, overlapChars: 4 });
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].retrievalText, /标题：年假申请.*适用问题：怎么休年假.*第一段流程/s);
  assert.deepEqual(chunks[0].metadata, {
    recordId: 'rec1', title: '年假申请', category: 'HR', updatedAt: '2026-07-13 10:00:00',
    sourceUrl: 'https://example.test/leave', chunkIndex: 0,
  });
  assert.equal(chunks[1].answerText, '第二段注意事项。');
});
