import { millisecondsUntilNextRun, shanghaiDayWindow } from './date-window.js';
import {
  buildLeaderSummaryCards,
  buildOwnerReminderCards,
  buildReminderActionProcessingCard,
  buildReminderActionStatusCard,
  buildReminderReasonCard,
  buildTaskConfirmationResultCard,
  buildStartTaskPickerCard,
  buildStartTaskDeadlineCard,
  buildStartTaskProcessingCard,
  parseCardAction,
  parseReminderReasonAction,
  parseStartTaskSelectionAction,
  parseStartTaskFormAction,
} from './feishu-messenger.js';

const OWNER_ACTIONS = new Set(['complete', 'continue', 'block', 'postpone']);
const ACTION_INTENTS = {
  complete: { operation: 'complete_task', fields: {} },
  continue: null,
  block: { operation: 'block_task', fields: {} },
  postpone: { operation: 'postpone_task', fields: {} },
};

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function windowFor(date) {
  const { dateKey, startSeconds, endSeconds } = shanghaiDayWindow(date);
  return { dateKey, window: { startMs: startSeconds * 1000, endMs: endSeconds * 1000 + 999 } };
}

function deadlineAtShanghai1830(value) {
  const match = typeof value === 'string' ? value.match(/^(\d{4}-\d{2}-\d{2})(?:\s+[+-]\d{4})?$/) : null;
  return match ? Date.parse(`${match[1]}T18:30:00+08:00`) : Number.NaN;
}

export function createReminderScheduler({
  clock = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  store,
  reminderService,
  messenger,
  base,
  taskService,
  onConsent,
  logger = console,
}) {
  let running = false;
  let reminderTimer;
  let startTaskTimer;

  async function wasSent(dateKey, category, openId) {
    return (await store.read()).reminderRuns?.[dateKey]?.[category]?.[openId] === 'sent';
  }

  async function markSent(dateKey, category, openId) {
    await store.update((state) => {
      state.reminderRuns ||= {};
      state.reminderRuns[dateKey] ||= { owner: {}, leader: {}, consent: {} };
      state.reminderRuns[dateKey][category] ||= {};
      state.reminderRuns[dateKey][category][openId] = 'sent';
      return state;
    });
  }

  async function sendOnce(dateKey, category, ledgerKey, openId, send, recipientErrors) {
    if (await wasSent(dateKey, category, ledgerKey)) return;
    try {
      await send();
      await markSent(dateKey, category, ledgerKey);
    } catch (error) {
      recipientErrors.push({ category, openId, ledgerKey, reason: error.message });
      logger.error('Reminder recipient failed', { dateKey, category, openId, ledgerKey, error });
    }
  }

  async function reminderSnapshot(dateKey, category, openId, build) {
    const existing = (await store.read()).reminderSnapshots?.[dateKey]?.[category]?.[openId];
    if (existing) return structuredClone(existing);

    const created = build();
    let selected;
    await store.update((state) => {
      state.reminderSnapshots ||= {};
      state.reminderSnapshots[dateKey] ||= { owner: {}, leader: {} };
      state.reminderSnapshots[dateKey][category] ||= {};
      selected = state.reminderSnapshots[dateKey][category][openId];
      if (!selected) {
        state.reminderSnapshots[dateKey][category][openId] = structuredClone(created);
        selected = state.reminderSnapshots[dateKey][category][openId];
      }
      return state;
    });
    return structuredClone(selected);
  }

  async function sendTaskRecipient(dateKey, category, openId, buildCards, recipientErrors) {
    let parts;
    try {
      parts = await reminderSnapshot(dateKey, category, openId, () => {
        const cards = buildCards();
        return cards.map((card, index) => {
          const part = `${index + 1}/${cards.length}`;
          return {
            key: `${openId}:${part}`,
            uuid: `${category}:${dateKey}:${openId}:${part}`,
            card,
          };
        });
      });
    } catch (error) {
      recipientErrors.push({ category, openId, reason: error.message });
      logger.error('Reminder recipient failed', { dateKey, category, openId, error });
      return;
    }

    for (const part of parts) {
      await sendOnce(
        dateKey,
        category,
        part.key,
        openId,
        () => messenger.sendCard(openId, part.card, part.uuid),
        recipientErrors,
      );
    }
  }

  async function runNow(at = clock()) {
    const date = asDate(at);
    const { dateKey, window } = windowFor(date);
    const plan = await reminderService.buildPlan(window);
    const recipientErrors = [];
    let savedSnapshots = {};
    try {
      savedSnapshots = (await store.read()).reminderSnapshots?.[dateKey] || {};
    } catch (error) {
      logger.error('Reminder snapshot index failed', { dateKey, error });
    }
    const ownerByOpenId = new Map(plan.owners.map((owner) => [owner.openId, owner]));
    const leaderByOpenId = new Map(plan.leaders.map((leader) => [leader.openId, leader]));
    const ownerOpenIds = new Set([...Object.keys(savedSnapshots.owner || {}), ...ownerByOpenId.keys()]);
    const leaderOpenIds = new Set([...Object.keys(savedSnapshots.leader || {}), ...leaderByOpenId.keys()]);

    for (const openId of ownerOpenIds) {
      const owner = ownerByOpenId.get(openId);
      await sendTaskRecipient(
        dateKey,
        'owner',
        openId,
        () => buildOwnerReminderCards(owner, dateKey),
        recipientErrors,
      );
    }
    for (const openId of leaderOpenIds) {
      const leader = leaderByOpenId.get(openId);
      await sendTaskRecipient(
        dateKey,
        'leader',
        openId,
        () => buildLeaderSummaryCards(leader),
        recipientErrors,
      );
    }
    return { ...plan, recipientErrors };
  }

  async function runStartTaskPrompts(at = clock()) {
    const { dateKey } = windowFor(asDate(at));
    const tasks = await base.listTasks();
    const activeOwners = new Set(tasks.filter((task) => task.status === '进行中').map((task) => task.ownerOpenId));
    const candidatesByOwner = new Map();
    for (const task of tasks) {
      if (!task.ownerOpenId || task.status !== '未开始' || task.start || activeOwners.has(task.ownerOpenId)) continue;
      const candidates = candidatesByOwner.get(task.ownerOpenId) || [];
      candidates.push(task);
      candidatesByOwner.set(task.ownerOpenId, candidates);
    }
    const recipientErrors = [];
    for (const [openId, candidates] of candidatesByOwner) {
      await sendOnce(
        dateKey, 'startTask', openId, openId,
        () => messenger.sendCard(openId, buildStartTaskPickerCard(candidates), `start-task:${dateKey}:${openId}`),
        recipientErrors,
      );
    }
    return { candidatesByOwner, recipientErrors };
  }

  function scheduleReminder() {
    if (!running) return;
    const now = asDate(clock());
    reminderTimer = setTimer(async () => {
      reminderTimer = undefined;
      try {
        await runNow(clock());
      } catch (error) {
        logger.error('Reminder run failed', { error });
      } finally {
        scheduleReminder();
      }
    }, millisecondsUntilNextRun(now, 18));
  }

  function scheduleStartTaskPrompt() {
    if (!running) return;
    const now = asDate(clock());
    startTaskTimer = setTimer(async () => {
      startTaskTimer = undefined;
      try {
        await runStartTaskPrompts(clock());
      } catch (error) {
        logger.error('Start task prompt run failed', { error });
      } finally {
        scheduleStartTaskPrompt();
      }
    }, millisecondsUntilNextRun(now, 9, 30));
  }

  async function claim(key) {
    let claimed = false;
    await store.update((state) => {
      state.confirmations ||= {};
      if (!(key in state.confirmations)) {
        state.confirmations[key] = 'processing';
        claimed = true;
      }
      return state;
    });
    return claimed;
  }

  async function finish(key, succeeded) {
    await store.update((state) => {
      state.confirmations ||= {};
      if (succeeded) state.confirmations[key] = 'succeeded';
      else delete state.confirmations[key];
      return state;
    });
  }

  async function updateActionCard(event, card) {
    const messageId = event?.context?.open_message_id || event?.open_message_id;
    if (typeof event?.token === 'string' && event.token && typeof messenger.updateCardByToken === 'function') {
      await messenger.updateCardByToken(event.token, card);
      return;
    }
    if (typeof messageId === 'string' && messageId && typeof messenger.updateCard === 'function') {
      await messenger.updateCard(messageId, card);
    }
  }

  async function handleCardAction(event) {
    const startSelection = parseStartTaskSelectionAction(event);
    if (startSelection) {
      const messageId = event?.context?.open_message_id || event?.open_message_id;
      const key = `${messageId}:select_start_task:${startSelection.actorOpenId}`;
      if (!await claim(key)) return { kind: 'ignored', reason: 'duplicate' };
      try {
        await updateActionCard(event, buildStartTaskProcessingCard('正在准备开始任务'));
        const tasks = await base.listTasks();
        const task = tasks.find((item) => item.recordId === startSelection.taskId);
        const valid = task && task.ownerOpenId === startSelection.actorOpenId && task.status === '未开始' && !task.start;
        const hasActive = tasks.some((item) => item.ownerOpenId === startSelection.actorOpenId && item.status === '进行中');
        if (!valid || hasActive) {
          await finish(key, true);
          await updateActionCard(event, buildTaskConfirmationResultCard(hasActive ? '你已有进行中的任务，本次不再启动新任务。' : '任务已发生变化，请重新操作。'));
          return { kind: 'ignored', reason: 'stale' };
        }
        await finish(key, true);
        await updateActionCard(event, buildStartTaskDeadlineCard(task));
        return { kind: 'result', text: '请选择截止日期。' };
      } catch (error) {
        await finish(key, false);
        await updateActionCard(event, buildTaskConfirmationResultCard('加载失败，请稍后重试。')).catch(() => {});
        throw error;
      }
    }

    const startForm = parseStartTaskFormAction(event);
    if (startForm) {
      const messageId = event?.context?.open_message_id || event?.open_message_id;
      const key = `${messageId}:submit_start_task:${startForm.taskId}:${startForm.actorOpenId}`;
      if (!await claim(key)) return { kind: 'ignored', reason: 'duplicate' };
      const now = asDate(clock()).getTime();
      const deadline = deadlineAtShanghai1830(startForm.deadlineDate);
      try {
        await updateActionCard(event, buildStartTaskProcessingCard('正在启动任务'));
        if (!Number.isFinite(deadline) || deadline <= now) throw new Error('Selected deadline is not in the future');
        const tasks = await base.listTasks();
        const task = tasks.find((item) => item.recordId === startForm.taskId);
        const valid = task && task.ownerOpenId === startForm.actorOpenId && task.status === '未开始' && !task.start;
        const hasActive = tasks.some((item) => item.ownerOpenId === startForm.actorOpenId && item.status === '进行中');
        if (!valid || hasActive) throw new Error('Task is no longer startable');
        const prepared = await taskService.prepare({
          operation: 'update_task', selector: { recordId: task.recordId },
          fields: { 状态: '进行中', 开始日期: now, 截止日期: deadline },
        }, startForm.actorOpenId);
        if (prepared?.kind !== 'confirmation') throw new Error('Start task did not produce a confirmation');
        const result = await taskService.confirm(prepared.confirmationId, startForm.actorOpenId);
        await finish(key, true);
        await updateActionCard(event, buildTaskConfirmationResultCard(result.text || '任务已开始。'));
        return result;
      } catch (error) {
        await finish(key, false);
        const text = error.message === 'Selected deadline is not in the future'
          ? '截止日期无效，请重新选择未来日期。'
          : '启动失败，任务可能已发生变化，请重新操作。';
        await updateActionCard(event, buildTaskConfirmationResultCard(text)).catch(() => {});
        throw error;
      }
    }

    const reasonAction = parseReminderReasonAction(event);
    if (reasonAction) {
      const task = await base?.getTask(reasonAction.taskId);
      if (!task || task.ownerOpenId !== reasonAction.actorOpenId) return { kind: 'ignored', reason: 'forbidden' };
      try {
        await updateActionCard(event, buildReminderActionStatusCard(
          '正在更新任务状态',
          `正在保存“${task.name || '未命名任务'}”的原因，请稍候…`,
        ));
        const status = reasonAction.action === 'block' ? '阻塞中' : '已延期';
        const prepared = await taskService.prepare({
          operation: 'update_task', selector: { recordId: reasonAction.taskId },
          fields: { 状态: status, 阻塞原因: reasonAction.reason },
        }, reasonAction.actorOpenId);
        if (prepared?.kind !== 'confirmation') throw new Error('Task reason action did not produce a confirmation');
        const result = await taskService.confirm(prepared.confirmationId, reasonAction.actorOpenId);
        await updateActionCard(event, buildTaskConfirmationResultCard('操作成功。'));
        return result;
      } catch (error) {
        await updateActionCard(event, buildTaskConfirmationResultCard('操作失败，请稍后重试。')).catch((updateError) => {
          logger.error('Reminder reason failure card update failed', { error: updateError });
        });
        throw error;
      }
    }

    const parsed = parseCardAction(event);
    if (!parsed) return { kind: 'ignored', reason: 'invalid' };

    if (!OWNER_ACTIONS.has(parsed.action)) {
      if (typeof onConsent !== 'function') return { kind: 'ignored', reason: 'unsupported' };
      return onConsent(parsed);
    }

    const task = await base?.getTask(parsed.taskId);
    if (!task || task.ownerOpenId !== parsed.actorOpenId) return { kind: 'ignored', reason: 'forbidden' };
    const messageId = event?.context?.open_message_id || event?.open_message_id;
    if (typeof messageId !== 'string' || !messageId) return { kind: 'ignored', reason: 'invalid' };
    const key = `${messageId}:${parsed.action}:${parsed.taskId}:${parsed.actorOpenId}`;
    if (!await claim(key)) return { kind: 'ignored', reason: 'duplicate' };

    try {
      await updateActionCard(event, buildReminderActionProcessingCard(task, parsed.action));

      if (parsed.action === 'continue') {
        await finish(key, true);
        await updateActionCard(event, buildReminderActionStatusCard(
          '已继续处理',
          '任务状态未修改。',
          { template: 'green' },
        ));
        return { kind: 'result', text: '已继续处理，任务状态未修改。' };
      }

      if (parsed.action === 'block' || parsed.action === 'postpone') {
        await messenger.sendCard(
          parsed.actorOpenId,
          buildReminderReasonCard(task, parsed.action),
          `callback-reason:${messageId}:${parsed.action}:${parsed.taskId}:${parsed.actorOpenId}`,
        );
        await finish(key, true);
        const reasonName = parsed.action === 'block' ? '阻塞原因' : '延期原因';
        await updateActionCard(event, buildReminderActionStatusCard(
          `请填写${reasonName}`,
          '原因填写卡片已发送，请在新卡片中提交。',
        ));
        return { kind: 'result', text: '请填写原因。' };
      }

      const actionIntent = ACTION_INTENTS[parsed.action];
      const result = await taskService.prepare({
        operation: actionIntent.operation,
        selector: { recordId: parsed.taskId },
        fields: { ...actionIntent.fields },
      }, parsed.actorOpenId);

      if (result?.kind !== 'confirmation' || typeof result.confirmationId !== 'string') {
        throw new Error('Task action did not produce a confirmation');
      }
      const currentTask = await base.getTask(parsed.taskId);
      if (!currentTask || currentTask.ownerOpenId !== parsed.actorOpenId) {
        await finish(key, false);
        await updateActionCard(event, buildTaskConfirmationResultCard('任务已变更，请重新操作。'));
        return { kind: 'ignored', reason: 'forbidden' };
      }
      const confirmed = await taskService.confirm(result.confirmationId, parsed.actorOpenId);
      await finish(key, true);
      if (typeof event?.token === 'string' && event.token && typeof messenger.updateCardByToken === 'function') {
        await messenger.updateCardByToken(event.token, buildTaskConfirmationResultCard(confirmed.text));
      } else if (typeof messageId === 'string' && typeof messenger.updateCard === 'function') {
        await messenger.updateCard(messageId, buildTaskConfirmationResultCard(confirmed.text));
      }
      return confirmed;
    } catch (error) {
      await finish(key, false);
      await updateActionCard(event, buildTaskConfirmationResultCard('操作失败，请稍后重试。')).catch((updateError) => {
        logger.error('Reminder action failure card update failed', { error: updateError });
      });
      throw error;
    }
  }

  return {
    start() { if (!running) { running = true; scheduleReminder(); scheduleStartTaskPrompt(); } },
    stop() {
      running = false;
      if (reminderTimer !== undefined) clearTimer(reminderTimer);
      if (startTaskTimer !== undefined) clearTimer(startTaskTimer);
      reminderTimer = undefined;
      startTaskTimer = undefined;
    },
    runNow,
    runStartTaskPrompts,
    handleCardAction,
  };
}
