import { extractPrompt } from './message-policy.js';

function formatTaskResponse(response) {
  if (response.kind === 'confirmation') {
    return `请确认操作。\n确认 ID：${response.confirmationId}\n回复“确认 ${response.confirmationId}”执行，或“取消 ${response.confirmationId}”放弃。`;
  }
  if (response.kind === 'disambiguation') {
    return response.candidates
      .map((candidate) => `${candidate.name}（ID：${candidate.recordId}，负责人：${candidate.ownerName || '未指定'}）`)
      .join('\n');
  }
  return response.text;
}

function confirmationCommand(prompt) {
  const match = prompt.trim().match(/^(确认|取消)\s+(\S+)$/);
  return match ? { operation: match[1] === '确认' ? 'confirm' : 'cancel', confirmationId: match[2] } : null;
}

export function createMessageHandler({
  taskIntent, taskService, assistant, reply, deduplicator, logger = console,
}) {
  return async function handle(event) {
    const { message, sender } = event;
    if (sender?.sender_type === 'app') return;
    if (!deduplicator.claim(message?.message_id)) return;
    const prompt = extractPrompt(message);
    if (!prompt) return;
    try {
      const actorOpenId = sender?.sender_id?.open_id;
      const command = taskService ? confirmationCommand(prompt) : null;
      let response;
      if (command) {
        response = await taskService[command.operation](command.confirmationId, actorOpenId);
      } else {
        const intent = taskIntent ? await taskIntent.parse(prompt) : null;
        response = intent
          ? await taskService.prepare(intent, actorOpenId)
          : { kind: 'result', text: await assistant.answer(prompt, actorOpenId) };
      }
      await reply(message.message_id, response.text || formatTaskResponse(response));
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
