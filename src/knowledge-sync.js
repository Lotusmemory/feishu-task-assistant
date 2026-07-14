import { chunkKnowledge } from './chunker.js';
import { createVectorIndex, saveIndexAtomic } from './vector-index.js';

export function createKnowledgeSync({ base, embedder, indexPath, model, threshold, save = saveIndexAtomic }) {
  return {
    async sync() {
      const records = await base.listPublishedKnowledge();
      const chunks = records.flatMap((record) => chunkKnowledge(record));
      const vectors = chunks.length ? await embedder.embedPassages(chunks.map(({ retrievalText }) => retrievalText)) : [];
      const entries = chunks.map((chunk, index) => ({
        id: `${chunk.metadata.recordId}:${chunk.metadata.chunkIndex}`,
        answerText: chunk.answerText,
        metadata: chunk.metadata,
        vector: vectors[index],
      }));
      const data = { version: 1, generatedAt: new Date().toISOString(), model, threshold, entries };
      await save(indexPath, data);
      return createVectorIndex(entries, { threshold });
    },
  };
}
