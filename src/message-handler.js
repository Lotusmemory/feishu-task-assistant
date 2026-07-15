import { extractPrompt } from './message-policy.js';
import {
  buildTaskConfirmationCard,
  buildTaskConfirmationResultCard,
  buildChatSummaryStatusCard,
  buildKnowledgeAnswerCard,
  buildTaskCreateCard,
  buildTaskCreateProcessingCard,
  buildTaskIntentProcessingCard,
  buildTaskOperationProcessingCard,
  buildTaskConfirmationProcessingCard,
  buildTaskReviewProcessingCard,
  buildTaskEditCard,
  buildTaskEditProcessingCard,
  buildTaskEditPickerCard,
  buildTaskScopeChoiceCard,
  buildMyTasksCard,
  parseTaskCreateFormAction,
  parseTaskEditFormAction,
  parseTaskEditSelectionAction,
  parseTaskScopeSelectionAction,
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

function taskReviewResultCard(response) {
  if (response.kind === 'task_list') return buildMyTasksCard(response.tasks);
  if (response.kind === 'task_scope_choice') return buildTaskScopeChoiceCard();
  return buildMyTasksCard([], { title: '任务盘点', emptyText: response.text || '没有找到匹配的任务。' });
}

function taskResponseCard(response, intent) {
  if (response.kind === 'confirmation') return buildTaskConfirmationCard(response);
  if (response.kind === 'need_input' && response.field === '任务名') return buildTaskCreateCard(intent?.fields);
  if (response.kind === 'task_list') return buildMyTasksCard(response.tasks);
  if (response.kind === 'task_scope_choice') return buildTaskScopeChoiceCard();
  if (response.kind === 'edit_task_picker') return buildTaskEditPickerCard(response.tasks);
  if (response.kind === 'edit_form') return buildTaskEditCard(response.task);
  return buildKnowledgeAnswerCard(response.text || formatTaskResponse(response), { title: '任务助理' });
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
          if (taskIntent?.isLikelyTask?.(prompt) && replyCard && messenger?.updateCard) {
            response = { kind: 'task_request_processing', prompt, actorOpenId };
          } else {
            const intent = taskIntent ? await taskIntent.parse(prompt) : null;
            if (intent) {
              response = intent.operation === 'query_tasks' && replyCard && messenger?.updateCard
                ? { kind: 'task_review_processing', run: () => taskService.prepare(intent, actorOpenId) }
                : { ...(await taskService.prepare(intent, actorOpenId)), intent };
            } else {
              response = replyCard && messenger?.updateCard
                ? {
                    kind: 'knowledge_processing',
                    text: '正在查询知识库，请稍候…',
                    run: () => assistant.answer(prompt, actorOpenId),
                  }
                : { kind: 'knowledge_answer', text: await assistant.answer(prompt, actorOpenId) };
            }
          }
        }
      }
      if (response.kind === 'task_request_processing' && replyCard) {
        const replyResult = await replyCard(message.message_id, buildTaskIntentProcessingCard());
        const cardMessageId = replyResult?.message_id || replyResult?.messageId || message.message_id;
        schedule(async () => {
          try {
            const intent = await taskIntent.parse(response.prompt);
            if (!intent) {
              await messenger.updateCard(cardMessageId, buildKnowledgeAnswerCard('正在查询知识库，请稍候…', { title: '正在查询知识' }));
              const text = await assistant.answer(response.prompt, response.actorOpenId);
              await messenger.updateCard(cardMessageId, buildKnowledgeAnswerCard(text));
              return;
            }
            await messenger.updateCard(cardMessageId, buildTaskOperationProcessingCard(intent.operation));
            const result = await taskService.prepare(intent, response.actorOpenId);
            await messenger.updateCard(cardMessageId, taskResponseCard(result, intent));
          } catch (error) {
            logger.error('Task request failed after acknowledgement', { messageId: cardMessageId, error });
            await messenger.updateCard(
              cardMessageId,
              buildTaskConfirmationResultCard('任务处理失败，请稍后重试。'),
            ).catch((updateError) => {
              logger.error('Task request failure card update failed', { messageId: cardMessageId, error: updateError });
            });
          }
        }, 100);
      } else if (response.kind === 'task_review_processing' && replyCard) {
        const replyResult = await replyCard(message.message_id, buildTaskReviewProcessingCard());
        const cardMessageId = replyResult?.message_id || replyResult?.messageId || message.message_id;
        schedule(() => {
          return response.run().then((result) => {
            if (messenger?.updateCard) return messenger.updateCard(cardMessageId, taskReviewResultCard(result));
            return undefined;
          }).catch((error) => {
            logger.error('Task review failed after acknowledgement', { messageId: cardMessageId, error });
            const card = buildMyTasksCard([], { title: '任务盘点失败', emptyText: '暂时无法查询任务，请稍后重试。' });
            if (messenger?.updateCard) {
              return messenger.updateCard(cardMessageId, card).catch((updateError) => {
                logger.error('Task review failure card update failed', { messageId: cardMessageId, error: updateError });
              });
            }
            return undefined;
          });
        }, 100);
      } else if (response.kind === 'knowledge_processing' && replyCard) {
        const pendingCard = buildKnowledgeAnswerCard(response.text, { title: '正在查询知识' });
        const replyResult = await replyCard(message.message_id, pendingCard);
        const cardMessageId = replyResult?.message_id || replyResult?.messageId || message.message_id;
        schedule(() => {
          return response.run().then((text) => {
            if (messenger?.updateCard) return messenger.updateCard(cardMessageId, buildKnowledgeAnswerCard(text));
            return undefined;
          }).catch((error) => {
            logger.error('Knowledge lookup failed after acknowledgement', { messageId: cardMessageId, error });
            const card = buildKnowledgeAnswerCard('暂时无法回答，请稍后重试。', { title: '知识查询失败' });
            if (messenger?.updateCard) {
              return messenger.updateCard(cardMessageId, card).catch((updateError) => {
                logger.error('Knowledge lookup failure card update failed', { messageId: cardMessageId, error: updateError });
              });
            }
            return undefined;
          });
        }, 100);
      } else if (response.kind === 'processing' && replyCard) {
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
      } else if (response.kind === 'task_scope_choice' && replyCard) {
        await replyCard(message.message_id, buildTaskScopeChoiceCard());
      } else if (response.kind === 'edit_task_picker' && replyCard) {
        await replyCard(message.message_id, buildTaskEditPickerCard(response.tasks));
      } else if (response.kind === 'edit_form' && replyCard) {
        await replyCard(message.message_id, buildTaskEditCard(response.task));
      } else if (response.kind === 'confirmation' && replyCard) {
        await replyCard(message.message_id, buildTaskConfirmationCard(response));
      } else if (response.kind === 'knowledge_answer' && replyCard) {
        await replyCard(message.message_id, buildKnowledgeAnswerCard(response.text));
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
  const pendingCreates = new Set();
  const pendingEdits = new Set();

  return async function handle(event) {
    const create = parseTaskCreateFormAction(event);
    if (create) {
      const messageId = event?.context?.open_message_id || event?.open_message_id;
      const submissionKey = messageId || create.actorOpenId;
      if (pendingCreates.has(submissionKey)) return undefined;
      pendingCreates.add(submissionKey);

      const value = create.values;
      const fields = { ...create.fields, 任务名: value.task_name };
      if (value.priority) fields['优先级'] = value.priority;
      if (value.deadline) fields['截止日期'] = Date.parse(`${value.deadline}:00+08:00`);
      try {
        if (messenger && messageId && typeof messenger.updateCard === 'function') {
          await messenger.updateCard(messageId, buildTaskCreateProcessingCard(value.task_name));
        }

        const prepared = await taskService.prepare({ operation: 'create_task', selector: {}, fields }, create.actorOpenId);
        const card = prepared.kind === 'confirmation'
          ? buildTaskConfirmationCard(prepared)
          : buildTaskConfirmationResultCard(prepared.text || '未能创建任务。');
        if (messenger && typeof event?.token === 'string' && event.token) {
          schedule(() => {
            messenger.updateCardByToken(event.token, card).catch((error) => {
              logger.error('Delayed card update failed', { messageId, error });
            }).finally(() => pendingCreates.delete(submissionKey));
          }, 100);
          return undefined;
        }
        if (messenger && messageId && typeof messenger.updateCard === 'function') {
          await messenger.updateCard(messageId, card);
          pendingCreates.delete(submissionKey);
          return undefined;
        }
        pendingCreates.delete(submissionKey);
        return card;
      } catch (error) {
        pendingCreates.delete(submissionKey);
        if (messenger && messageId && typeof messenger.updateCard === 'function') {
          try {
            await messenger.updateCard(messageId, buildTaskConfirmationResultCard('创建失败，请重新发起后再试。'));
          } catch (updateError) {
            logger.error('Task create failure card update failed', { messageId, error: updateError });
          }
        }
        throw error;
      }
    }
    const edit = parseTaskEditFormAction(event);
    if (edit) {
      const messageId = event?.context?.open_message_id || event?.open_message_id;
      const submissionKey = `${messageId || edit.actorOpenId}:${edit.recordId}`;
      if (pendingEdits.has(submissionKey)) return undefined;
      pendingEdits.add(submissionKey);

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
      try {
        if (messenger && messageId) {
          await messenger.updateCard(messageId, buildTaskEditProcessingCard(value.task_name));
        }

        const prepared = await taskService.prepare({ operation: 'update_task', selector: { recordId: edit.recordId }, fields }, edit.actorOpenId);
        const result = prepared.kind === 'confirmation'
          ? await taskService.confirm(prepared.confirmationId, edit.actorOpenId)
          : prepared;
        const card = buildTaskConfirmationResultCard(result.text || '未能更新任务。');
        if (messenger && typeof event?.token === 'string' && event.token) {
          schedule(() => {
            messenger.updateCardByToken(event.token, card).catch((error) => {
              logger.error('Delayed card update failed', { messageId, error });
            }).finally(() => pendingEdits.delete(submissionKey));
          }, 100);
          return undefined;
        }
        if (messenger && messageId) {
          await messenger.updateCard(messageId, card);
          pendingEdits.delete(submissionKey);
          return undefined;
        }
        pendingEdits.delete(submissionKey);
        return card;
      } catch (error) {
        pendingEdits.delete(submissionKey);
        if (messenger && messageId) {
          try {
            await messenger.updateCard(messageId, buildTaskConfirmationResultCard('保存失败，请重新打开任务后再试。'));
          } catch (updateError) {
            logger.error('Task edit failure card update failed', { messageId, error: updateError });
          }
        }
        throw error;
      }
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
    const scopeSelection = parseTaskScopeSelectionAction(event);
    if (scopeSelection) {
      const messageId = event?.context?.open_message_id || event?.open_message_id;
      if (messenger && messageId) await messenger.updateCard(messageId, buildTaskReviewProcessingCard());
      const result = await taskService.queryScope(scopeSelection.scope, scopeSelection.actorOpenId);
      const card = result.kind === 'task_list'
        ? buildMyTasksCard(result.tasks, {
            title: scopeSelection.scope === 'all' ? '全部成员任务盘点' : '我的任务盘点',
            showOwner: scopeSelection.scope === 'all',
          })
        : buildMyTasksCard([], { title: '任务盘点', emptyText: result.text });
      if (messenger && messageId) {
        await messenger.updateCard(messageId, card);
        return undefined;
      }
      return card;
    }
    const parsed = parseTaskConfirmationAction(event);
    if (!parsed) return { kind: 'ignored', reason: 'invalid' };
    const messageId = event?.context?.open_message_id || event?.open_message_id;
    if (messenger && typeof messageId === 'string' && messageId) {
      await messenger.updateCard(messageId, buildTaskConfirmationProcessingCard(parsed.action));
    }
    try {
      const result = parsed.action === 'confirm_task_change'
        ? await taskService.confirm(parsed.confirmationId, parsed.actorOpenId)
        : await taskService.cancel(parsed.confirmationId, parsed.actorOpenId);
      const card = buildTaskConfirmationResultCard(result.text);
      if (messenger && typeof messageId === 'string' && messageId) {
        await messenger.updateCard(messageId, card);
      }
      return messenger && messageId ? undefined : card;
    } catch (error) {
      if (messenger && typeof messageId === 'string' && messageId) {
        try {
          await messenger.updateCard(messageId, buildTaskConfirmationResultCard('操作失败，请稍后重试。'));
        } catch (updateError) {
          logger.error('Task confirmation failure card update failed', { messageId, error: updateError });
        }
      }
      throw error;
    }
  };
}
