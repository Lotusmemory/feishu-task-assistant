import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeSync } from '../src/knowledge-sync.js';

test('builds a complete replacement index from published knowledge', async () => {
  let saved;
  const sync = createKnowledgeSync({
    base: { listPublishedKnowledge: async () => [{
      recordId: 'rec1', title: '年假', category: 'HR', questions: '怎么休年假', body: '年假流程',
      keywords: '年假', sourceUrl: 'https://example.test', status: '已发布', updatedAt: 1,
    }] },
    embedder: { embedPassages: async () => [[1, 0]] },
    indexPath: '.data/test.json', model: 'BAAI/bge-m3', threshold: 0.52,
    save: async (_path, data) => { saved = data; },
  });
  const index = await sync.sync();
  assert.equal(index.entries.length, 1);
  assert.equal(saved.entries[0].metadata.title, '年假');
  assert.deepEqual(saved.entries[0].vector, [1, 0]);
});
