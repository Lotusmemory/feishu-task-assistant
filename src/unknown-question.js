export function normalizeQuestion(question) {
  return question.trim().toLowerCase().replace(/[，。！？、,.!?]/g, '').replace(/\s+/g, ' ');
}

export function createUnknownQuestionService({ base, now = Date.now }) {
  return {
    async record({ question, category = '其他', requesterOpenId, callbackRequested = false }) {
      const normalized = normalizeQuestion(question);
      const existing = await base.findQuestion(normalized);
      const callbackUser = callbackRequested ? requesterOpenId : undefined;
      if (existing) {
        await base.incrementQuestion(existing.recordId, { count: existing.count + 1, now: now(), callbackUser });
        return;
      }
      await base.createQuestion({ original: question, normalized, category, now: now(), callbackUser });
    },
  };
}
