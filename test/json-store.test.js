import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJsonStore } from '../src/json-store.js';

test('serializes concurrent updates without losing data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kefu-store-'));
  const path = join(dir, 'state.json');
  const store = createJsonStore({ path, defaultValue: { count: 0 } });
  await Promise.all([store.update((s) => ({ count: s.count + 1 })), store.update((s) => ({ count: s.count + 1 }))]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { count: 2 });
});
