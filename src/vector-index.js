function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }
  if (!normA || !normB) return -1;
  return dot / Math.sqrt(normA * normB);
}

export function createVectorIndex(entries, { threshold }) {
  return {
    entries,
    threshold,
    search(vector, limit = 3) {
      return entries
        .map((entry) => ({ ...entry, score: cosine(vector, entry.vector) }))
        .filter(({ score }) => score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  };
}

export async function saveIndexAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(data), 'utf8');
  await rename(temporaryPath, path);
}

export async function loadIndex(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(data.entries) || typeof data.threshold !== 'number') throw new Error();
    return data;
  } catch (error) {
    throw new Error('Invalid knowledge index', { cause: error });
  }
}
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
