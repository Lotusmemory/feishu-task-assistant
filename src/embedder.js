export function createEmbedder({
  apiKey,
  baseUrl,
  model,
  fetchImpl = fetch,
  batchSize = 32,
  timeoutMs = 30_000,
}) {
  async function embedBatch(input) {
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input, encoding_format: 'float' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.data) || data.data.length !== input.length) throw new Error('Invalid embedding response');
      return data.data.sort((a, b) => a.index - b.index).map(({ embedding }) => embedding);
    } catch (error) {
      throw new Error('Embedding request failed', { cause: error });
    }
  }

  async function embedMany(texts) {
    const vectors = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      vectors.push(...await embedBatch(texts.slice(offset, offset + batchSize)));
    }
    return vectors;
  }

  return {
    async embedQuery(text) { return (await embedBatch([text]))[0]; },
    embedPassages: embedMany,
  };
}
