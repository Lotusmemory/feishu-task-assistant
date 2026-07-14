import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVectorIndex, loadIndex, saveIndexAtomic } from '../src/vector-index.js';

test('sorts by cosine score, limits results and rejects below threshold', () => {
  const index = createVectorIndex([
    { id: 'a', vector: [1, 0] }, { id: 'b', vector: [0.8, 0.2] },
    { id: 'c', vector: [0, 1] }, { id: 'd', vector: [-1, 0] },
  ], { threshold: 0.52 });
  assert.deepEqual(index.search([1, 0], 3).map(({ id }) => id), ['a', 'b']);
  assert.deepEqual(index.search([0.1, -1], 3), []);
});

test('saves and loads an index atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-index-'));
  const path = join(directory, 'index.json');
  const data = { version: 1, model: 'BAAI/bge-m3', threshold: 0.52, entries: [{ id: 'a', vector: [1, 0] }] };
  try {
    await saveIndexAtomic(path, data);
    assert.deepEqual(await loadIndex(path), data);
    assert.doesNotMatch(await readFile(path, 'utf8'), /\.tmp/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
