function assertSuccess(response, operation) {
  if (response?.code !== 0) throw new Error(`${operation} failed: ${response?.msg || 'unknown error'}`);
  return response.data;
}

export function createBaseClient({ client, baseToken, knowledgeTableId, questionsTableId }) {
  return {
    async listPublishedKnowledge() {
      const records = [];
      let pageToken;
      do {
        const response = await client.bitable.v1.appTableRecord.list({
          path: { app_token: baseToken, table_id: knowledgeTableId },
          params: { page_size: 500, page_token: pageToken, filter: 'CurrentValue.[状态] = "已发布"' },
        });
        const data = assertSuccess(response, 'List knowledge');
        records.push(...(data.items || []));
        pageToken = data.has_more ? data.page_token : undefined;
      } while (pageToken);

      return records.map(({ record_id: recordId, fields }) => ({
        recordId,
        title: fields['标题'] || '',
        category: fields['分类'] || '其他',
        questions: fields['适用问题'] || '',
        body: fields['正文'] || '',
        keywords: fields['关键词'] || '',
        sourceUrl: fields['来源链接']?.link || fields['来源链接'] || '',
        status: fields['状态'],
        updatedAt: fields['更新时间'],
      }));
    },

    async createQuestion({ original, normalized, category = '其他', now, callbackUser }) {
      const fields = {
        原始问题: original,
        归一化问题: normalized,
        分类: category,
        出现次数: 1,
        首次提问时间: now,
        最后提问时间: now,
        状态: '待补充',
        是否要求回访: Boolean(callbackUser),
      };
      if (callbackUser) fields['回访用户'] = callbackUser;
      const response = await client.bitable.v1.appTableRecord.create({
        path: { app_token: baseToken, table_id: questionsTableId },
        data: { fields },
      });
      return assertSuccess(response, 'Create unknown question').record;
    },

    async findQuestion(normalized) {
      const response = await client.bitable.v1.appTableRecord.search({
        path: { app_token: baseToken, table_id: questionsTableId },
        params: { page_size: 1 },
        data: { filter: { conjunction: 'and', conditions: [
          { field_name: '归一化问题', operator: 'is', value: [normalized] },
        ] } },
      });
      const item = assertSuccess(response, 'Find unknown question').items?.[0];
      return item ? { recordId: item.record_id, count: Number(item.fields['出现次数'] || 0) } : null;
    },

    async incrementQuestion(recordId, { count, now, callbackUser }) {
      const fields = { 出现次数: count, 最后提问时间: now };
      if (callbackUser) {
        fields['是否要求回访'] = true;
        fields['回访用户'] = callbackUser;
      }
      const response = await client.bitable.v1.appTableRecord.update({
        path: { app_token: baseToken, table_id: questionsTableId, record_id: recordId },
        data: { fields },
      });
      return assertSuccess(response, 'Increment unknown question').record;
    },
  };
}
