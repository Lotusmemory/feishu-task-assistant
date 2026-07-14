function formatSources(passages) {
  const unique = new Map();
  for (const { metadata } of passages) unique.set(metadata.recordId, metadata);
  return [...unique.values()].map(({ title, updatedAt, sourceUrl }) =>
    `- ${title}（更新时间：${updatedAt || '未提供'}）${sourceUrl ? ` ${sourceUrl}` : ''}`,
  ).join('\n');
}

export function createRagService({ embedder, getIndex, minimax }) {
  return {
    async answer(question) {
      const vector = await embedder.embedQuery(question);
      const passages = getIndex().search(vector, 3);
      if (passages.length === 0) {
        return { matched: false, sources: [], text: '当前知识库暂无此信息。我已将问题记入待补清单；如需人工回访，请发送“需要回访：你的问题”。' };
      }
      const answer = await minimax.answerWithKnowledge(question, passages);
      return {
        matched: true,
        sources: passages.map(({ metadata }) => metadata),
        text: `${answer}\n\n来源：\n${formatSources(passages)}`,
      };
    },
  };
}
