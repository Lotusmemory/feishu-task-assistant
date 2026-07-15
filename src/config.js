const REQUIRED = [
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'MINIMAX_API_KEY',
  'FEISHU_BASE_TOKEN', 'FEISHU_KNOWLEDGE_TABLE_ID', 'FEISHU_QUESTIONS_TABLE_ID',
  'SILICONFLOW_API_KEY',
  'FEISHU_TASKS_TABLE_ID', 'FEISHU_MEMBERS_TABLE_ID',
];

export function loadConfig(env = process.env) {
  const enableChatSummary = env.ENABLE_CHAT_SUMMARY === 'true';
  const required = enableChatSummary
    ? [...REQUIRED, 'TOKEN_ENCRYPTION_KEY', 'OAUTH_REDIRECT_URI']
    : REQUIRED;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    feishuAppId: env.FEISHU_APP_ID,
    feishuAppSecret: env.FEISHU_APP_SECRET,
    minimaxApiKey: env.MINIMAX_API_KEY,
    minimaxBaseUrl: env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
    minimaxModel: env.MINIMAX_MODEL || 'MiniMax-M3',
    baseToken: env.FEISHU_BASE_TOKEN,
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
    statePath: env.TASK_ASSISTANT_STATE_PATH || '.data/task-assistant-state.json',
    tokenPath: env.USER_TOKEN_PATH || '.data/user-tokens.json',
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    oauthRedirectUri: env.OAUTH_REDIRECT_URI,
    port: Number(env.PORT || 3000),
  };
}
