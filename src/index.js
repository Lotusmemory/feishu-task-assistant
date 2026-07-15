import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config.js';
import { createDeduplicator } from './deduplicator.js';
import { createBaseClient } from './base-client.js';
import { createEmbedder } from './embedder.js';
import { createKnowledgeSync } from './knowledge-sync.js';
import { createMiniMaxClient } from './minimax-client.js';
import { createMessageHandler, createTaskConfirmationActionHandler } from './message-handler.js';
import { createRagService } from './rag-service.js';
import { createUnknownQuestionService } from './unknown-question.js';
import { createVectorIndex, loadIndex } from './vector-index.js';
import { createJsonStore } from './json-store.js';
import { createConfirmationStore } from './confirmation-store.js';
import { createMemberService } from './member-service.js';
import { createTaskService } from './task-service.js';
import { createTaskIntentParser } from './task-intent.js';
import { createFeishuMessenger } from './feishu-messenger.js';
import { createReminderService } from './reminder-service.js';
import { createReminderScheduler } from './reminder-scheduler.js';
import { createTokenVault } from './token-vault.js';
import { createOAuthServer, createSafeOAuthCodeExchanger } from './oauth-server.js';
import { createChatHistory, UserAuthorizationRequired } from './chat-history.js';
import { createChatSummary } from './chat-summary.js';
import { createChatSummaryRequest } from './chat-summary-request.js';
import { createLarkCliChatHistory } from './lark-cli-chat-history.js';
import { shanghaiDayWindow } from './date-window.js';
import { createCardActionDispatcher } from './card-action-dispatcher.js';

const NOOP_LOGGER = Object.freeze({ error() {}, warn() {}, info() {}, debug() {}, trace() {} });
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1_000;
const CHAT_SUMMARY_TIMEOUT_MS = 120_000;

function chatWindow(at = new Date()) {
  const { dateKey } = shanghaiDayWindow(at);
  return { startIso: `${dateKey}T00:00:00+08:00`, endIso: `${dateKey}T23:59:59+08:00` };
}

export async function createApplication({ config = loadConfig(), sdk = lark, logger = console } = {}) {
  const baseConfig = { appId: config.feishuAppId, appSecret: config.feishuAppSecret, domain: sdk.Domain.Feishu };
  const client = new sdk.Client({ ...baseConfig, appType: sdk.AppType.SelfBuild });
  const useOauthChatSummary = config.enableChatSummary && config.chatHistoryProvider !== 'lark-cli';
  const safeUserClient = useOauthChatSummary ? new sdk.Client({
    ...baseConfig, appType: sdk.AppType.SelfBuild,
    logger: NOOP_LOGGER, loggerLevel: sdk.LoggerLevel.fatal,
  }) : null;
  const minimax = createMiniMaxClient({ apiKey: config.minimaxApiKey, baseUrl: config.minimaxBaseUrl, model: config.minimaxModel });
  const chatSummaryMinimax = createMiniMaxClient({
    apiKey: config.minimaxApiKey,
    baseUrl: config.minimaxBaseUrl,
    model: config.minimaxModel,
    timeoutMs: CHAT_SUMMARY_TIMEOUT_MS,
  });
  const embedder = createEmbedder({ apiKey: config.embeddingApiKey, baseUrl: config.embeddingBaseUrl, model: config.embeddingModel });
  const base = createBaseClient({
    client, knowledgeBaseToken: config.knowledgeBaseToken, taskBaseToken: config.taskBaseToken,
    knowledgeTableId: config.knowledgeTableId,
    questionsTableId: config.questionsTableId, tasksTableId: config.tasksTableId,
    membersTableId: config.membersTableId,
  });
  const stateStore = createJsonStore({
    path: config.statePath,
    defaultValue: { confirmations: {}, reminderRuns: {}, reminderSnapshots: {}, oauthStates: {} },
  });
  const confirmations = createConfirmationStore({ store: stateStore, ttlMs: CONFIRMATION_TTL_MS });
  const members = createMemberService({ base });
  const taskService = createTaskService({ base, members, confirmations });
  const taskIntent = createTaskIntentParser({ minimax });
  const messenger = createFeishuMessenger({ client });
  const reminderService = createReminderService({ base, members });
  const tokenStore = useOauthChatSummary
    ? createJsonStore({ path: config.tokenPath, defaultValue: { users: {} } })
    : null;
  const vault = useOauthChatSummary
    ? createTokenVault({ store: tokenStore, encryptionKey: config.tokenEncryptionKey })
    : null;
  const oauth = useOauthChatSummary ? createOAuthServer({
    codeExchanger: createSafeOAuthCodeExchanger({
      appId: config.feishuAppId, appSecret: config.feishuAppSecret, domain: sdk.Domain.Feishu,
    }),
    vault, redirectUri: config.oauthRedirectUri, port: config.port, stateStore,
  }) : null;
  const chatHistory = config.enableChatSummary
    ? config.chatHistoryProvider === 'lark-cli'
      ? createLarkCliChatHistory({ command: config.larkCliPath })
      : createChatHistory({ client: safeUserClient, vault })
    : null;
  const chatSummary = config.enableChatSummary ? createChatSummary({ minimax: chatSummaryMinimax, taskService }) : null;
  const chatSummaryRequest = config.enableChatSummary
    ? createChatSummaryRequest({
      history: chatHistory, summary: chatSummary, oauth,
      allowedOpenId: config.allowedChatSummaryOpenId,
    })
    : null;

  let currentIndex = createVectorIndex([], { threshold: config.embeddingThreshold });
  try {
    const saved = await loadIndex(config.indexPath);
    currentIndex = createVectorIndex(saved.entries, { threshold: saved.threshold });
  } catch {
    logger.info('No valid local knowledge index; rebuilding from Base');
  }
  const knowledgeSync = createKnowledgeSync({
    base, embedder, indexPath: config.indexPath, model: config.embeddingModel,
    threshold: config.embeddingThreshold,
  });
  const rag = createRagService({ embedder, getIndex: () => currentIndex, minimax });
  const unknown = createUnknownQuestionService({ base });
  const assistant = { async answer(prompt, requesterOpenId) {
    const callbackRequested = prompt.startsWith('需要回访：');
    const question = callbackRequested ? prompt.slice('需要回访：'.length).trim() : prompt;
    const result = await rag.answer(question);
    if (!result.matched) await unknown.record({ question, requesterOpenId, callbackRequested });
    return result.text;
  } };

  const scheduler = createReminderScheduler({
    store: stateStore, reminderService, messenger, base, taskService,
    consentEnabled: config.enableChatSummary,
    async onConsent(action) {
      if (action.action === 'decline_chat_summary') {
        await messenger.sendText(action.actorOpenId, '已拒绝，本次不会读取聊天。', `consent-declined:${Date.now()}:${action.actorOpenId}`);
        return { kind: 'result', text: '已拒绝。' };
      }
      try {
        const history = await chatHistory.listTextMessages(action.actorOpenId, chatWindow());
        const result = await chatSummary.summarize(history.messages, action.actorOpenId);
        const suffix = history.incomplete ? '\n注意：平台分页限制导致摘要可能不完整。' : '';
        await messenger.sendText(action.actorOpenId, `${result.summaryText}${suffix}`, `chat-summary:${Date.now()}:${action.actorOpenId}`);
        return { kind: 'result', ...result, incomplete: history.incomplete };
      } catch (error) {
        if (!(error instanceof UserAuthorizationRequired)) throw error;
        const url = await oauth.authorizationUrl(action.actorOpenId);
        await messenger.sendText(action.actorOpenId, `请先完成授权：${url}`, `oauth-required:${Date.now()}:${action.actorOpenId}`);
        return { kind: 'authorization_required' };
      }
    },
    logger,
  });
  const handler = createMessageHandler({
    taskIntent, taskService, chatSummaryRequest, assistant,
    reply: (messageId, text) => messenger.replyText(messageId, text),
    replyCard: (messageId, card) => messenger.replyCard(messageId, card),
    messenger, deduplicator: createDeduplicator(), logger,
  });
  const confirmationAction = createTaskConfirmationActionHandler({ taskService, messenger, logger });
  const cardAction = createCardActionDispatcher({
    confirmationAction,
    reminderAction: (event) => scheduler.handleCardAction(event),
    logger,
  });
  const eventDispatcher = new sdk.EventDispatcher({}).register({
    'im.message.receive_v1': handler,
    'card.action.trigger': cardAction,
  });
  const wsClient = new sdk.WSClient({ ...baseConfig, loggerLevel: sdk.LoggerLevel.info });
  let syncTimer;

  return {
    scheduler,
    async start() {
      if (oauth) await oauth.start();
      try {
        try { currentIndex = await knowledgeSync.sync(); }
        catch (error) { logger.error('Knowledge sync failed; keeping last valid index', { error }); }
        syncTimer = setInterval(async () => {
          try { currentIndex = await knowledgeSync.sync(); }
          catch (error) { logger.error('Scheduled knowledge sync failed', { error }); }
        }, 5 * 60 * 1_000);
        syncTimer.unref();
        scheduler.start();
        await wsClient.start({ eventDispatcher });
      } catch (error) {
        scheduler.stop();
        if (syncTimer) clearInterval(syncTimer);
        if (oauth) await oauth.stop();
        throw error;
      }
    },
    async stop() {
      scheduler.stop();
      if (syncTimer) clearInterval(syncTimer);
      if (oauth) await oauth.stop();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await createApplication();
  await application.start();
}
