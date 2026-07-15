import { UserAuthorizationRequired } from './chat-history.js';
import { shanghaiDayWindow } from './date-window.js';

const DATE_PATTERN = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/g;

function dateKey(match) {
  const [, year, month, day] = match;
  const key = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${key}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  const shifted = new Date(parsed.getTime() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  return shifted === key ? key : null;
}

export function parseChatSummaryRequest(prompt, at = new Date()) {
  if (!/(总结|摘要)/.test(prompt) || !/(聊天|消息|会话)/.test(prompt)) return null;
  if (/(今天|今日)/.test(prompt)) {
    const { dateKey } = shanghaiDayWindow(at);
    return {
      startDate: dateKey,
      endDate: dateKey,
      window: {
        startIso: `${dateKey}T00:00:00+08:00`,
        endIso: `${dateKey}T23:59:59+08:00`,
      },
    };
  }
  const dates = [...prompt.matchAll(DATE_PATTERN)].map(dateKey);
  if (dates.length !== 2 || dates.some((value) => !value)) {
    return { error: '请给出开始和结束日期，例如：总结 2026-07-01 到 2026-07-15 的聊天。' };
  }
  const [startDate, endDate] = dates;
  if (startDate > endDate) return { error: '开始日期不能晚于结束日期。' };
  return {
    startDate,
    endDate,
    window: {
      startIso: `${startDate}T00:00:00+08:00`,
      endIso: `${endDate}T23:59:59+08:00`,
    },
  };
}

export function createChatSummaryRequest({ history, summary, oauth, allowedOpenId, clock = () => new Date() }) {
  async function run(request, actorOpenId) {
    try {
      const result = await history.listTextMessages(actorOpenId, request.window);
      const summarized = await summary.summarize(result.messages, actorOpenId);
      const suffix = result.incomplete ? '\n注意：平台分页限制导致摘要可能不完整。' : '';
      return { kind: 'result', text: summarized.summaryText + suffix };
    } catch (error) {
      if (!(error instanceof UserAuthorizationRequired)) throw error;
      if (!oauth) return { kind: 'result', text: '当前聊天总结读取凭证不可用，请检查本机 lark-cli 登录状态或服务配置。' };
      const url = await oauth.authorizationUrl(actorOpenId);
      return { kind: 'result', text: `请先完成授权：${url}\n授权完成后，请重新发送原来的总结请求。` };
    }
  }

  return {
    parse(prompt, actorOpenId) {
      const request = parseChatSummaryRequest(prompt, clock());
      if (!request) return null;
      if (request.error) return { kind: 'result', text: request.error };
      if (allowedOpenId && actorOpenId !== allowedOpenId) {
        return { kind: 'result', text: '当前聊天总结试点只允许指定用户使用。' };
      }
      return {
        kind: 'processing',
        title: '聊天总结',
        text: `正在总结 ${request.startDate} 的聊天，请稍候。`,
        run: () => run(request, actorOpenId),
      };
    },
    async handle(prompt, actorOpenId) {
      const parsed = this.parse(prompt, actorOpenId);
      if (!parsed) return null;
      if (parsed.kind !== 'processing') return parsed;
      return parsed.run();
    },
  };
}
