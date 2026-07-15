import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('wires card updates and a dedicated timeout into chat summaries', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

  assert.match(source, /createChatSummary\(\{ minimax: chatSummaryMinimax, taskService \}\)/);
  assert.match(source, /createMessageHandler\(\{[\s\S]*?replyCard:[\s\S]*?messenger, deduplicator:/);
  assert.match(source, /CHAT_SUMMARY_TIMEOUT_MS = 120_000/);
});
