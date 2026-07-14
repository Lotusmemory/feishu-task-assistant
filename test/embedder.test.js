import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder } from '../src/embedder.js';

test('calls SiliconFlow embeddings in batches and preserves vector order', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const { input } = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ data: input.map((_text, index) => ({ index, embedding: [index, index + 1] })) }),
    };
  };
  const embedder = createEmbedder({
    apiKey: 'secret', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3',
    fetchImpl, batchSize: 2,
  });

  assert.deepEqual(await embedder.embedQuery('如何请年假'), [0, 1]);
  assert.deepEqual(await embedder.embedPassages(['年假流程', '报销流程', 'VPN 流程']), [[0, 1], [1, 2], [0, 1]]);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, 'https://api.siliconflow.cn/v1/embeddings');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    model: 'BAAI/bge-m3', input: ['年假流程', '报销流程'], encoding_format: 'float',
  });
});

test('normalizes API failures', async () => {
  const embedder = createEmbedder({
    apiKey: 'secret', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3',
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  await assert.rejects(() => embedder.embedQuery('测试'), /Embedding request failed/);
});
