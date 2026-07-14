import { millisecondsUntilNextRun, shanghaiDayWindow } from './date-window.js';
import {
  buildConsentCard,
  buildLeaderSummaryCard,
  buildOwnerReminderCard,
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

  async function sendOnce(dateKey, category, openId, send) {
    if (await wasSent(dateKey, category, openId)) return;
    try {
      await send();
      await markSent(dateKey, category, openId);
    } catch (error) {
      logger.error('Reminder recipient failed', { dateKey, category, openId, error });
    }
  }

  async function runNow(at = clock()) {
    const date = asDate(at);
    const { dateKey, window } = windowFor(date);
    const plan = await reminderService.buildPlan(window);

    for (const owner of plan.owners) {
      await sendOnce(dateKey, 'owner', owner.openId, () => messenger.sendCard(
        owner.openId,
        buildOwnerReminderCard(owner, dateKey),
        `owner:${dateKey}:${owner.openId}`,
      ));
    }
    for (const leader of plan.leaders) {
      await sendOnce(dateKey, 'leader', leader.openId, () => messenger.sendCard(
        leader.openId,
        buildLeaderSummaryCard(leader),
        `leader:${dateKey}:${leader.openId}`,
      ));
    }
    for (const owner of plan.owners) {
      await sendOnce(dateKey, 'consent', owner.openId, () => messenger.sendCard(
        owner.openId,
        buildConsentCard(),
        `consent:${dateKey}:${owner.openId}`,
      ));
    }
    return plan;
  }

  function schedule() {
    if (!running) return;
    const now = asDate(clock());
    timer = setTimer(async () => {
      timer = undefined;
      try {
        await runNow(clock());
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
      await finish(key, true);
      return result;
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
