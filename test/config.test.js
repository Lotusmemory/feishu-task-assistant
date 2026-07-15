import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loads required values and defaults', () => {
  assert.deepEqual(loadConfig({
    FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', MINIMAX_API_KEY: 'key',
    FEISHU_BASE_TOKEN: 'bas_test', FEISHU_KNOWLEDGE_TABLE_ID: 'tbl_knowledge',
    FEISHU_QUESTIONS_TABLE_ID: 'tbl_questions', SILICONFLOW_API_KEY: 'sf-key',
    FEISHU_TASKS_TABLE_ID: 'tbl_tasks', FEISHU_MEMBERS_TABLE_ID: 'tbl_members',
    TOKEN_ENCRYPTION_KEY: 'token-key', OAUTH_REDIRECT_URI: 'https://example.com/oauth/callback',
  }), {
    feishuAppId: 'cli_test', feishuAppSecret: 'secret', minimaxApiKey: 'key',
    minimaxBaseUrl: 'https://api.minimaxi.com/v1', minimaxModel: 'MiniMax-M3',
    baseToken: 'bas_test', knowledgeTableId: 'tbl_knowledge', questionsTableId: 'tbl_questions',
    embeddingApiKey: 'sf-key', embeddingBaseUrl: 'https://api.siliconflow.cn/v1',
    embeddingModel: 'BAAI/bge-m3', embeddingThreshold: 0.52,
    indexPath: '.data/knowledge-index.json',
    tasksTableId: 'tbl_tasks', membersTableId: 'tbl_members',
    enableChatSummary: false,
    statePath: '.data/task-assistant-state.json', tokenPath: '.data/user-tokens.json',
    tokenEncryptionKey: 'token-key', oauthRedirectUri: 'https://example.com/oauth/callback',
    port: 3000,
  });
});

test('reports every missing required variable', () => {
  assert.throws(
    () => loadConfig({}),
    /FEISHU_APP_ID, FEISHU_APP_SECRET, MINIMAX_API_KEY, FEISHU_BASE_TOKEN, FEISHU_KNOWLEDGE_TABLE_ID, FEISHU_QUESTIONS_TABLE_ID, SILICONFLOW_API_KEY, FEISHU_TASKS_TABLE_ID, FEISHU_MEMBERS_TABLE_ID/,
  );
});

test('requires OAuth secrets only when chat summaries are enabled', () => {
  const env = {
    FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', MINIMAX_API_KEY: 'key',
    FEISHU_BASE_TOKEN: 'bas_test', FEISHU_KNOWLEDGE_TABLE_ID: 'tbl_knowledge',
    FEISHU_QUESTIONS_TABLE_ID: 'tbl_questions', SILICONFLOW_API_KEY: 'sf-key',
    FEISHU_TASKS_TABLE_ID: 'tbl_tasks', FEISHU_MEMBERS_TABLE_ID: 'tbl_members',
    ENABLE_CHAT_SUMMARY: 'true',
  };
  assert.throws(() => loadConfig(env), /TOKEN_ENCRYPTION_KEY, OAUTH_REDIRECT_URI/);
  const config = loadConfig({
    ...env,
    TOKEN_ENCRYPTION_KEY: 'token-key',
    OAUTH_REDIRECT_URI: 'https://example.com/oauth/callback',
  });
  assert.equal(config.enableChatSummary, true);
});
