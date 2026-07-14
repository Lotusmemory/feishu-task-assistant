const REQUIRED = [
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'MINIMAX_API_KEY',
  'FEISHU_BASE_TOKEN', 'FEISHU_KNOWLEDGE_TABLE_ID', 'FEISHU_QUESTIONS_TABLE_ID',
  'SILICONFLOW_API_KEY',
];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
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
  };
}
