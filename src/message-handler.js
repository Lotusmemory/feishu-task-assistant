import { extractPrompt } from './message-policy.js';

export function createMessageHandler({ assistant, reply, deduplicator, logger = console }) {
  return async function handle(event) {
    const { message, sender } = event;
    if (sender?.sender_type === 'app') return;
    if (!deduplicator.claim(message?.message_id)) return;
    const prompt = extractPrompt(message);
    if (!prompt) return;
    try {
      const answer = await assistant.answer(prompt, sender?.sender_id?.open_id);
      await reply(message.message_id, answer);
    } catch (error) {
      logger.error('Message processing failed', { messageId: message.message_id, error });
      try {
        await reply(message.message_id, '暂时无法回答，请稍后重试');
      } catch (replyError) {
        logger.error('Fallback reply failed', { messageId: message.message_id, error: replyError });
      }
    }
  };
}
