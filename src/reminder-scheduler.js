import { millisecondsUntilNextRun, shanghaiDayWindow } from './date-window.js';
import {
  buildConsentCard,
  buildLeaderSummaryCards,
  buildOwnerReminderCards,
  parseCardAction,
} from './feishu-messenger.js';

const OWNER_ACTIONS = new Set(['complete', 'continue', 'block', 'postpone']);
const ACTION_INTENTS = {
  complete: { operation: 'complete_task', fields: {} },
  continue: { operation: 'update_task', fields: { 状态: '进行中' } },
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
  consentEnabled = true,
  logger = console,
}) {
  let running = false;
  let timer;

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
    if (consentEnabled) {
      for (const owner of plan.owners) {
        await sendOnce(dateKey, 'consent', owner.openId, owner.openId, () => messenger.sendCard(
          owner.openId,
          buildConsentCard(),
          `consent:${dateKey}:${owner.openId}`,
        ), recipientErrors);
      }
    }
    return { ...plan, recipientErrors };
  }

  function schedule() {
    if (!running) return;
    const now = asDate(clock());
    timer = setTimer(async () => {
      timer = undefined;
      try {
        await runNow(clock());
      } catch (error) {
        logger.error('Reminder run failed', { error });
      } finally {
        schedule();
      }
    }, millisecondsUntilNextRun(now, 18));
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

  async function handleCardAction(event) {
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
      const actionIntent = ACTION_INTENTS[parsed.action];
      const result = await taskService.prepare({
        operation: actionIntent.operation,
        selector: { recordId: parsed.taskId },
        fields: { ...actionIntent.fields },
      }, parsed.actorOpenId);

      if (parsed.action === 'block' || parsed.action === 'postpone') {
        const text = parsed.action === 'block'
          ? `请继续发送：阻塞任务 ${parsed.taskId}，阻塞原因：等待接口。`
          : `请继续发送：延期任务 ${parsed.taskId}，新截止日期：2026-07-20。`;
        await messenger.sendText(
          parsed.actorOpenId,
          text,
          `callback-help:${messageId}:${parsed.action}:${parsed.taskId}:${parsed.actorOpenId}`,
        );
        await finish(key, true);
        return { kind: 'result', text };
      }

      if (result?.kind !== 'confirmation' || typeof result.confirmationId !== 'string') {
        throw new Error('Task action did not produce a confirmation');
      }
      const currentTask = await base.getTask(parsed.taskId);
      if (!currentTask || currentTask.ownerOpenId !== parsed.actorOpenId) {
        await finish(key, false);
        return { kind: 'ignored', reason: 'forbidden' };
      }
      const confirmed = await taskService.confirm(result.confirmationId, parsed.actorOpenId);
      await finish(key, true);
      return confirmed;
    } catch (error) {
      await finish(key, false);
      throw error;
    }
  }

  return {
    start() { if (!running) { running = true; schedule(); } },
    stop() { running = false; if (timer !== undefined) clearTimer(timer); timer = undefined; },
    runNow,
    handleCardAction,
  };
}
