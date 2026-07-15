import { extractPrompt } from './message-policy.js';
import {
  buildTaskConfirmationCard,
  buildTaskConfirmationResultCard,
  buildChatSummaryStatusCard,
  buildTaskCreateCard,
  buildTaskEditCard,
  buildTaskEditPickerCard,
  buildMyTasksCard,
  parseTaskCreateFormAction,
  parseTaskEditFormAction,
  parseTaskEditSelectionAction,
  parseTaskConfirmationAction,
} from './feishu-messenger.js';

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
  taskIntent, taskService, chatSummaryRequest, assistant, reply, replyCard, messenger, schedule = setTimeout, deduplicator, logger = console,
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
        response = chatSummaryRequest
          ? typeof chatSummaryRequest.parse === 'function'
            ? chatSummaryRequest.parse(prompt, actorOpenId)
            : await chatSummaryRequest.handle(prompt, actorOpenId)
          : null;
        if (!response) {
          const intent = taskIntent ? await taskIntent.parse(prompt) : null;
          response = intent
            ? { ...(await taskService.prepare(intent, actorOpenId)), intent }
            : { kind: 'result', text: await assistant.answer(prompt, actorOpenId) };
        }
      }
      if (response.kind === 'processing' && replyCard) {
        const pendingCard = buildChatSummaryStatusCard({ title: response.title, text: response.text });
        const replyResult = await replyCard(message.message_id, pendingCard);
        const cardMessageId = replyResult?.message_id || replyResult?.messageId || message.message_id;
        schedule(() => {
          return response.run().then((result) => {
            const card = buildChatSummaryStatusCard({ title: '聊天总结完成', text: result.text || '没有可总结的内容。' });
            if (messenger?.updateCard) return messenger.updateCard(cardMessageId, card);
            return undefined;
          }).catch((error) => {
            logger.error('Chat summary failed after acknowledgement', { messageId: cardMessageId, error });
            const card = buildChatSummaryStatusCard({ title: '聊天总结失败', text: '暂时无法生成聊天总结，请稍后重试。' });
            if (messenger?.updateCard) {
              return messenger.updateCard(cardMessageId, card).catch((updateError) => {
                logger.error('Chat summary failure card update failed', { messageId: cardMessageId, error: updateError });
              });
            }
            return undefined;
          });
        }, 100);
      } else if (response.kind === 'need_input' && response.field === '任务名' && replyCard) {
        await replyCard(message.message_id, buildTaskCreateCard(response.intent?.fields));
      } else if (response.kind === 'task_list' && replyCard) {
        await replyCard(message.message_id, buildMyTasksCard(response.tasks));
      } else if (response.kind === 'edit_task_picker' && replyCard) {
        await replyCard(message.message_id, buildTaskEditPickerCard(response.tasks));
      } else if (response.kind === 'edit_form' && replyCard) {
        await replyCard(message.message_id, buildTaskEditCard(response.task));
      } else if (response.kind === 'confirmation' && replyCard) {
        await replyCard(message.message_id, buildTaskConfirmationCard(response));
      } else {
        await reply(message.message_id, response.text || formatTaskResponse(response));
      }
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

export function createTaskConfirmationActionHandler({ taskService, messenger, schedule = setTimeout, logger = console }) {
  return async function handle(event) {
    const create = parseTaskCreateFormAction(event);
    if (create) {
      const value = create.values;
      const fields = { ...create.fields, 任务名: value.task_name };
      if (value.priority) fields['优先级'] = value.priority;
      if (value.deadline) fields['截止日期'] = Date.parse(`${value.deadline}:00+08:00`);
      const prepared = await taskService.prepare({ operation: 'create_task', selector: {}, fields }, create.actorOpenId);
      const card = prepared.kind === 'confirmation'
        ? buildTaskConfirmationCard(prepared)
        : buildTaskConfirmationResultCard(prepared.text || '未能创建任务。');
      const messageId = event?.context?.open_message_id || event?.open_message_id;
      if (messenger && typeof event?.token === 'string' && event.token) {
        schedule(() => {
          messenger.updateCardByToken(event.token, card).catch((error) => {
            logger.error('Delayed card update failed', { messageId, error });
          });
        }, 100);
        return undefined;
      }
      if (messenger && messageId) {
        await messenger.updateCard(messageId, card);
        return undefined;
      }
      return card;
    }
    const edit = parseTaskEditFormAction(event);
    if (edit) {
      const value = edit.values;
      const fields = {
        任务名: value.task_name,
        状态: value.status,
        进度: Number(value.progress),
        阻塞原因: value.blocker || '',
        标签: Array.isArray(value.tags) ? value.tags : value.tags ? [value.tags] : [],
      };
      if (value.priority) fields['优先级'] = value.priority;
      if (value.start) fields['开始日期'] = Date.parse(`${value.start}:00+08:00`);
      if (value.deadline) fields['截止日期'] = Date.parse(`${value.deadline}:00+08:00`);
      const prepared = await taskService.prepare({ operation: 'update_task', selector: { recordId: edit.recordId }, fields }, edit.actorOpenId);
      if (prepared.kind !== 'confirmation') return buildTaskConfirmationResultCard(prepared.text || '未能更新任务。');
      const result = await taskService.confirm(prepared.confirmationId, edit.actorOpenId);
      const card = buildTaskConfirmationResultCard(result.text);
      const messageId = event?.context?.open_message_id || event?.open_message_id;
      if (messenger && typeof event?.token === 'string' && event.token) {
        schedule(() => {
          messenger.updateCardByToken(event.token, card).catch((error) => {
            logger.error('Delayed card update failed', { messageId, error });
          });
        }, 100);
        return undefined;
      }
      if (messenger && messageId) {
        await messenger.updateCard(messageId, card);
        return undefined;
      }
      return card;
    }
    const selection = parseTaskEditSelectionAction(event);
    if (selection) {
      const prepared = await taskService.prepare({
        operation: 'edit_task_form',
        selector: { recordId: selection.taskId, ownerOpenId: selection.actorOpenId },
        fields: {},
      }, selection.actorOpenId);
      const card = prepared.kind === 'edit_form'
        ? buildTaskEditCard(prepared.task)
        : buildTaskConfirmationResultCard(prepared.text || '没有找到匹配的任务。');
      const messageId = event?.context?.open_message_id || event?.open_message_id;
      if (messenger && messageId) {
        await messenger.updateCard(messageId, card);
        return undefined;
      }
      return card;
    }
    const parsed = parseTaskConfirmationAction(event);
    if (!parsed) return { kind: 'ignored', reason: 'invalid' };
    const result = parsed.action === 'confirm_task_change'
      ? await taskService.confirm(parsed.confirmationId, parsed.actorOpenId)
      : await taskService.cancel(parsed.confirmationId, parsed.actorOpenId);
    const card = buildTaskConfirmationResultCard(result.text);
    const messageId = event?.context?.open_message_id || event?.open_message_id;
    if (messenger && typeof messageId === 'string' && messageId) {
      await messenger.updateCard(messageId, card);
    }
    return messenger && messageId ? undefined : card;
  };
}
