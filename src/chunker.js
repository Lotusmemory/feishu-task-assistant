function splitLong(text, maxChars, overlapChars) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  const step = Math.max(1, maxChars - overlapChars);
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + maxChars));
    if (start + maxChars >= text.length) break;
  }
  return chunks;
}

export function chunkKnowledge(record, { maxChars = 800, overlapChars = 80 } = {}) {
  if (record.status !== '已发布') return [];
  const paragraphs = String(record.body || '').split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const answerChunks = paragraphs.flatMap((text) => splitLong(text, maxChars, overlapChars));
  return answerChunks.map((answerText, chunkIndex) => ({
    answerText,
    retrievalText: [
      `标题：${record.title || ''}`,
      `分类：${record.category || ''}`,
      `适用问题：${record.questions || ''}`,
      `关键词：${record.keywords || ''}`,
      `正文：${answerText}`,
    ].join('\n'),
    metadata: {
      recordId: record.recordId,
      title: record.title,
      category: record.category,
      updatedAt: record.updatedAt,
      sourceUrl: record.sourceUrl,
      chunkIndex,
    },
  }));
}
