const SYSTEM_PROMPT = '你是一个简洁、友善的客服助手。信息不足时明确说明，不要编造事实。';

function stripThinking(value) {
  return String(value || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function createMiniMaxClient({ apiKey, baseUrl, model, fetchImpl = fetch, timeoutMs = 30_000 }) {
  async function complete(messages) {
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const answer = stripThinking(data?.choices?.[0]?.message?.content);
      if (!answer) throw new Error('Empty answer');
      return answer;
    } catch (error) {
      throw new Error('MiniMax request failed', { cause: error });
    }
  }

  return {
    async completeWithSystem(system, prompt) {
      return complete([{ role: 'system', content: system }, { role: 'user', content: prompt }]);
    },
    async answer(prompt) {
      return complete([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }]);
    },
    async answerWithKnowledge(question, passages) {
      const context = passages.map(({ answerText, metadata }, index) => [
        `资料 ${index + 1}`, `标题：${metadata.title}`, `更新时间：${metadata.updatedAt}`,
        `来源：${metadata.sourceUrl || '未提供'}`, `正文：${answerText}`,
      ].join('\n')).join('\n\n');
      return complete([
        { role: 'system', content: '你是公司内部知识助手。只能依据提供的已审核资料回答；资料不足时明确说明，不得编造公司制度。先给结论，再给步骤和注意事项。资料冲突时指出冲突，不自行裁决。' },
        { role: 'user', content: `员工问题：${question}\n\n已审核资料：\n${context}` },
      ]);
    },
  };
}
