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
    knowledgeBaseToken: 'bas_test', taskBaseToken: 'bas_test',
    knowledgeTableId: 'tbl_knowledge', questionsTableId: 'tbl_questions',
    embeddingApiKey: 'sf-key', embeddingBaseUrl: 'https://api.siliconflow.cn/v1',
    embeddingModel: 'BAAI/bge-m3', embeddingThreshold: 0.52,
    indexPath: '.data/knowledge-index.json',
    tasksTableId: 'tbl_tasks', membersTableId: 'tbl_members',
    enableChatSummary: false,
    chatHistoryProvider: 'oauth',
    allowedChatSummaryOpenId: undefined,
    larkCliPath: 'lark-cli',
    statePath: '.data/task-assistant-state.json', tokenPath: '.data/user-tokens.json',
    tokenEncryptionKey: 'token-key', oauthRedirectUri: 'https://example.com/oauth/callback',
    port: 3000,
  });
});

test('reports every missing required variable', () => {
  assert.throws(
    () => loadConfig({}),
    /FEISHU_APP_ID, FEISHU_APP_SECRET, MINIMAX_API_KEY, FEISHU_KNOWLEDGE_TABLE_ID, FEISHU_QUESTIONS_TABLE_ID, SILICONFLOW_API_KEY, FEISHU_TASKS_TABLE_ID, FEISHU_MEMBERS_TABLE_ID, FEISHU_KNOWLEDGE_BASE_TOKEN, FEISHU_TASK_BASE_TOKEN/,
  );
});

test('loads separate knowledge and task Base tokens', () => {
  const config = loadConfig({
    FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', MINIMAX_API_KEY: 'key',
    FEISHU_KNOWLEDGE_BASE_TOKEN: 'bas_knowledge', FEISHU_TASK_BASE_TOKEN: 'bas_tasks',
    FEISHU_KNOWLEDGE_TABLE_ID: 'tbl_knowledge', FEISHU_QUESTIONS_TABLE_ID: 'tbl_questions',
    SILICONFLOW_API_KEY: 'sf-key', FEISHU_TASKS_TABLE_ID: 'tbl_tasks',
    FEISHU_MEMBERS_TABLE_ID: 'tbl_members',
  });
  assert.equal(config.knowledgeBaseToken, 'bas_knowledge');
  assert.equal(config.taskBaseToken, 'bas_tasks');
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

test('allows local lark-cli chat summary without OAuth secrets for one user', () => {
  const config = loadConfig({
    FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', MINIMAX_API_KEY: 'key',
    FEISHU_BASE_TOKEN: 'bas_test', FEISHU_KNOWLEDGE_TABLE_ID: 'tbl_knowledge',
    FEISHU_QUESTIONS_TABLE_ID: 'tbl_questions', SILICONFLOW_API_KEY: 'sf-key',
    FEISHU_TASKS_TABLE_ID: 'tbl_tasks', FEISHU_MEMBERS_TABLE_ID: 'tbl_members',
    ENABLE_CHAT_SUMMARY: 'true',
    CHAT_HISTORY_PROVIDER: 'lark-cli',
    ALLOWED_CHAT_SUMMARY_OPEN_ID: 'ou_allowed',
    LARK_CLI_PATH: '/bin/lark-cli',
  });

  assert.equal(config.enableChatSummary, true);
  assert.equal(config.chatHistoryProvider, 'lark-cli');
  assert.equal(config.allowedChatSummaryOpenId, 'ou_allowed');
  assert.equal(config.larkCliPath, '/bin/lark-cli');
});
