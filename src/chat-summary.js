const SYSTEM_PROMPT = `你是聊天任务摘要器，只返回 JSON，不要返回 Markdown。只能根据输入消息总结，不得推断未出现的事实。讨论、建议和假设应归入 risks，不得当作已确认任务。顶级字段只能是 summary 和 taskDrafts。summary 只能包含 important、decisions、todos、risks、people 五个字符串数组。taskDrafts 每项只能包含任务名、截止日期、优先级、来源摘要。`;
const SUMMARY_KEYS = ['important', 'decisions', 'todos', 'risks', 'people'];
const SUMMARY_LABELS = {
  important: '重点信息', decisions: '已确认决策', todos: '待办事项', risks: '风险与待确认项', people: '相关人员',
};
const MAX_CHARS = 24_000;

function parseJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanSummary(value) {
  const summary = {};
  for (const key of SUMMARY_KEYS) {
    summary[key] = Array.isArray(value?.[key])
      ? value[key].filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [];
  }
  return summary;
}

function hasSummaryContent(summary) {
  return SUMMARY_KEYS.some((key) => summary[key].length > 0);
}

function formatSummary(summary) {
  return SUMMARY_KEYS.flatMap((key) => {
    if (summary[key].length === 0) return [];
    return [`**${SUMMARY_LABELS[key]}**\n${summary[key].map((item) => `- ${item}`).join('\n')}`];
  }).join('\n\n');
}

function cleanDrafts(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((draft) => {
    if (!draft || typeof draft['任务名'] !== 'string' || !draft['任务名'].trim()) return [];
    const result = { 任务名: draft['任务名'].trim() };
    if (typeof draft['截止日期'] === 'string' && draft['截止日期'].trim()) result['截止日期'] = draft['截止日期'].trim();
    if (typeof draft['优先级'] === 'string' && draft['优先级'].trim()) result['优先级'] = draft['优先级'].trim();
    return [{ fields: result, sourceSummary: typeof draft['来源摘要'] === 'string' ? draft['来源摘要'].trim() : '' }];
  });
}

function chunks(messages) {
  const result = [];
  let current = '';
  for (const message of messages) {
    const senderName = message.senderName
      || (/^cli_/.test(message.senderId || '') ? '智能客服' : '未知成员');
    const line = `${message.createTime || ''}\t${senderName}\t${message.text || ''}\n`;
    if (current && current.length + line.length > MAX_CHARS) {
      result.push(current);
      current = '';
    }
    current += line.slice(0, MAX_CHARS);
  }
  if (current) result.push(current);
  return result;
}

export function createChatSummary({ minimax, taskService }) {
  async function complete(prompt) {
    return parseJson(await minimax.completeWithSystem(SYSTEM_PROMPT, prompt));
  }

  return {
    async summarize(messages, actorOpenId) {
      if (messages.length === 0) {
        const summary = cleanSummary();
        return { summary, summaryText: '当天没有可总结的文本消息。', drafts: [] };
      }
      const inputs = chunks(messages);
      let candidate;
      let retryPrompt;
      if (inputs.length <= 1) {
        candidate = await complete(inputs[0]);
        retryPrompt = `上次摘要错误地返回了空内容。请重新总结以下非空聊天；有实质信息时，至少填写一个 summary 数组。\n${inputs[0]}`;
      }
      else {
        const partials = [];
        for (const input of inputs) partials.push(await complete(input));
        const mergePrompt = `合并以下分块摘要，去重并保持固定 JSON 结构：\n${JSON.stringify(partials)}`;
        candidate = await complete(mergePrompt);
        retryPrompt = `上次合并错误地返回了空内容。请重新合并，并至少填写一个非空 summary 数组：\n${JSON.stringify(partials)}`;
      }

      let summary = cleanSummary(candidate.summary);
      if (!hasSummaryContent(summary)) {
        candidate = await complete(retryPrompt);
        summary = cleanSummary(candidate.summary);
      }
      if (!hasSummaryContent(summary)) throw new Error('Chat summary returned no content');
      const drafts = [];
      for (const draft of cleanDrafts(candidate.taskDrafts)) {
        const fields = { ...draft.fields, 负责人: actorOpenId };
        const prepared = await taskService.prepare({ operation: 'create_task', selector: {}, fields }, actorOpenId);
        if (prepared?.kind === 'confirmation') {
          drafts.push({ draftId: prepared.confirmationId, fields, sourceSummary: draft.sourceSummary });
        }
      }
      return { summary, summaryText: formatSummary(summary), drafts };
    },
  };
}
