import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config.js';
import { createDeduplicator } from './deduplicator.js';
import { createBaseClient } from './base-client.js';
import { createEmbedder } from './embedder.js';
import { createKnowledgeSync } from './knowledge-sync.js';
import { createMiniMaxClient } from './minimax-client.js';
import { createMessageHandler } from './message-handler.js';
import { createRagService } from './rag-service.js';
import { createUnknownQuestionService } from './unknown-question.js';
import { createVectorIndex, loadIndex } from './vector-index.js';

const config = loadConfig();
const baseConfig = { appId: config.feishuAppId, appSecret: config.feishuAppSecret, domain: lark.Domain.Feishu };
const client = new lark.Client({ ...baseConfig, appType: lark.AppType.SelfBuild });
const minimax = createMiniMaxClient({ apiKey: config.minimaxApiKey, baseUrl: config.minimaxBaseUrl, model: config.minimaxModel });
const embedder = createEmbedder({
  apiKey: config.embeddingApiKey,
  baseUrl: config.embeddingBaseUrl,
  model: config.embeddingModel,
});
const base = createBaseClient({
  client,
  baseToken: config.baseToken,
  knowledgeTableId: config.knowledgeTableId,
  questionsTableId: config.questionsTableId,
});
let currentIndex = createVectorIndex([], { threshold: config.embeddingThreshold });
try {
  const saved = await loadIndex(config.indexPath);
  currentIndex = createVectorIndex(saved.entries, { threshold: saved.threshold });
} catch {
  console.info('No valid local knowledge index; rebuilding from Base');
}
const knowledgeSync = createKnowledgeSync({
  base,
  embedder,
  indexPath: config.indexPath,
  model: config.embeddingModel,
  threshold: config.embeddingThreshold,
});
try {
  currentIndex = await knowledgeSync.sync();
  console.info('Knowledge index synchronized', { entries: currentIndex.entries.length });
} catch (error) {
  console.error('Knowledge sync failed; keeping last valid index', { error });
}
const rag = createRagService({ embedder, getIndex: () => currentIndex, minimax });
const unknown = createUnknownQuestionService({ base });
const assistant = {
  async answer(prompt, requesterOpenId) {
    const callbackRequested = prompt.startsWith('需要回访：');
    const question = callbackRequested ? prompt.slice('需要回访：'.length).trim() : prompt;
    const result = await rag.answer(question);
    if (!result.matched) {
      await unknown.record({ question, requesterOpenId, callbackRequested });
    }
    return result.text;
  },
};

const syncTimer = setInterval(async () => {
  try {
    currentIndex = await knowledgeSync.sync();
    console.info('Knowledge index synchronized', { entries: currentIndex.entries.length });
  } catch (error) {
    console.error('Scheduled knowledge sync failed', { error });
  }
}, 5 * 60 * 1000);
syncTimer.unref();

const reply = async (messageId, text) => {
  await client.im.v1.message.reply({
    path: { message_id: messageId },
    data: { msg_type: 'text', content: JSON.stringify({ text }) },
  });
};

const handler = createMessageHandler({ assistant, reply, deduplicator: createDeduplicator() });
const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (event) => {
    console.info('Received message event', {
      messageId: event.message?.message_id,
      chatType: event.message?.chat_type,
      messageType: event.message?.message_type,
    });
    await handler(event);
  },
});
const wsClient = new lark.WSClient({ ...baseConfig, loggerLevel: lark.LoggerLevel.info });

await wsClient.start({ eventDispatcher });
