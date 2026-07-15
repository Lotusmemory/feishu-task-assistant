const REQUIRED = [
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'MINIMAX_API_KEY',
  'FEISHU_KNOWLEDGE_TABLE_ID', 'FEISHU_QUESTIONS_TABLE_ID',
  'SILICONFLOW_API_KEY',
  'FEISHU_TASKS_TABLE_ID', 'FEISHU_MEMBERS_TABLE_ID',
];

export function loadConfig(env = process.env) {
  const enableChatSummary = env.ENABLE_CHAT_SUMMARY === 'true';
  const chatHistoryProvider = env.CHAT_HISTORY_PROVIDER || 'oauth';
  const required = enableChatSummary
    ? chatHistoryProvider === 'lark-cli'
      ? [...REQUIRED, 'ALLOWED_CHAT_SUMMARY_OPEN_ID']
      : [...REQUIRED, 'TOKEN_ENCRYPTION_KEY', 'OAUTH_REDIRECT_URI']
    : REQUIRED;
  const missing = required.filter((key) => !env[key]?.trim());
  if (!env.FEISHU_KNOWLEDGE_BASE_TOKEN?.trim() && !env.FEISHU_BASE_TOKEN?.trim()) {
    missing.push('FEISHU_KNOWLEDGE_BASE_TOKEN');
  }
  if (!env.FEISHU_TASK_BASE_TOKEN?.trim() && !env.FEISHU_BASE_TOKEN?.trim()) {
    missing.push('FEISHU_TASK_BASE_TOKEN');
  }
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    feishuAppId: env.FEISHU_APP_ID,
    feishuAppSecret: env.FEISHU_APP_SECRET,
    minimaxApiKey: env.MINIMAX_API_KEY,
    minimaxBaseUrl: env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
    minimaxModel: env.MINIMAX_MODEL || 'MiniMax-M3',
    knowledgeBaseToken: env.FEISHU_KNOWLEDGE_BASE_TOKEN || env.FEISHU_BASE_TOKEN,
    taskBaseToken: env.FEISHU_TASK_BASE_TOKEN || env.FEISHU_BASE_TOKEN,
    knowledgeTableId: env.FEISHU_KNOWLEDGE_TABLE_ID,
    questionsTableId: env.FEISHU_QUESTIONS_TABLE_ID,
    embeddingApiKey: env.SILICONFLOW_API_KEY,
    embeddingBaseUrl: env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
    embeddingModel: env.SILICONFLOW_EMBEDDING_MODEL || 'BAAI/bge-m3',
    embeddingThreshold: Number(env.EMBEDDING_THRESHOLD || 0.52),
    indexPath: env.KNOWLEDGE_INDEX_PATH || '.data/knowledge-index.json',
    tasksTableId: env.FEISHU_TASKS_TABLE_ID,
    membersTableId: env.FEISHU_MEMBERS_TABLE_ID,
    enableChatSummary,
    chatHistoryProvider,
    allowedChatSummaryOpenId: env.ALLOWED_CHAT_SUMMARY_OPEN_ID,
    larkCliPath: env.LARK_CLI_PATH || 'lark-cli',
    statePath: env.TASK_ASSISTANT_STATE_PATH || '.data/task-assistant-state.json',
    tokenPath: env.USER_TOKEN_PATH || '.data/user-tokens.json',
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    oauthRedirectUri: env.OAUTH_REDIRECT_URI,
    port: Number(env.PORT || 3000),
  };
}
