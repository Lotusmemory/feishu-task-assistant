import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loads required values and defaults', () => {
  assert.deepEqual(loadConfig({
    FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', MINIMAX_API_KEY: 'key',
    FEISHU_BASE_TOKEN: 'bas_test', FEISHU_KNOWLEDGE_TABLE_ID: 'tbl_knowledge',
    FEISHU_QUESTIONS_TABLE_ID: 'tbl_questions', SILICONFLOW_API_KEY: 'sf-key',
  }), {
    feishuAppId: 'cli_test', feishuAppSecret: 'secret', minimaxApiKey: 'key',
    minimaxBaseUrl: 'https://api.minimaxi.com/v1', minimaxModel: 'MiniMax-M3',
    baseToken: 'bas_test', knowledgeTableId: 'tbl_knowledge', questionsTableId: 'tbl_questions',
    embeddingApiKey: 'sf-key', embeddingBaseUrl: 'https://api.siliconflow.cn/v1',
    embeddingModel: 'BAAI/bge-m3', embeddingThreshold: 0.52,
    indexPath: '.data/knowledge-index.json',
  });
});

test('reports every missing required variable', () => {
  assert.throws(
    () => loadConfig({}),
    /FEISHU_APP_ID, FEISHU_APP_SECRET, MINIMAX_API_KEY, FEISHU_BASE_TOKEN, FEISHU_KNOWLEDGE_TABLE_ID, FEISHU_QUESTIONS_TABLE_ID, SILICONFLOW_API_KEY/,
  );
});
