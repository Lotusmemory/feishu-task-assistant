import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function createJsonStore({ path, defaultValue }) {
  async function read() {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(defaultValue);
      throw error;
    }
  }

  let queue = Promise.resolve();

  function update(mutator) {
    const operation = queue.then(async () => {
      const next = await mutator(await read());
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(next));
      await rename(temporaryPath, path);
      return next;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { read, update };
}
