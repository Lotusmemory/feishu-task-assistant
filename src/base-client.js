function assertSuccess(response, operation) {
  if (response?.code !== 0) throw new Error(`${operation} failed: ${response?.msg || 'unknown error'}`);
  return response.data;
}

const WRITABLE_TASK_FIELDS = new Set([
  '任务名', '负责人', '协作人', '状态', '进度', '开始日期', '截止日期', '完成时间', '阻塞原因', '优先级', '标签',
]);

function textValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : item?.text || '').join('');
  return '';
}

function mapTask({ record_id: recordId, fields }) {
  const owner = fields['负责人']?.[0];
  const task = {
    recordId,
    name: textValue(fields['任务名']),
    ownerOpenId: owner?.id || '',
    ownerName: owner?.name || '',
    status: fields['状态'] || '',
    progress: Number(fields['进度'] || 0),
    deadline: fields['截止日期'],
    priority: fields['优先级'] || '',
    blocker: textValue(fields['阻塞原因']),
  };
  if (fields['开始日期'] !== undefined) task.start = fields['开始日期'];
  if (Array.isArray(fields['标签'])) task.tags = fields['标签'];
  return task;
}

function writableTaskFields(fields) {
  for (const field of Object.keys(fields)) {
    if (!WRITABLE_TASK_FIELDS.has(field)) throw new Error(`Task field is not writable: ${field}`);
  }

  const result = { ...fields };
  for (const field of ['负责人', '协作人']) {
    if (field in result) {
      const openIds = Array.isArray(result[field]) ? result[field] : [result[field]];
      result[field] = openIds.map((id) => ({ id }));
    }
  }
  return result;
}

export function createBaseClient({
  client, baseToken, knowledgeBaseToken = baseToken, taskBaseToken = baseToken,
  knowledgeTableId, questionsTableId, tasksTableId, membersTableId,
}) {
  async function listTaskRecords(operation) {
    const records = [];
    let pageToken;
    do {
      const response = await client.bitable.v1.appTableRecord.list({
        path: { app_token: taskBaseToken, table_id: tasksTableId },
        params: { page_size: 500, page_token: pageToken },
      });
      const data = assertSuccess(response, operation);
      records.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records.map(mapTask);
  }

  return {
    async listPublishedKnowledge() {
      const records = [];
      let pageToken;
      do {
        const response = await client.bitable.v1.appTableRecord.list({
          path: { app_token: knowledgeBaseToken, table_id: knowledgeTableId },
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
        path: { app_token: knowledgeBaseToken, table_id: questionsTableId },
        data: { fields },
      });
      return assertSuccess(response, 'Create unknown question').record;
    },

    async findQuestion(normalized) {
      const response = await client.bitable.v1.appTableRecord.search({
        path: { app_token: knowledgeBaseToken, table_id: questionsTableId },
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
        path: { app_token: knowledgeBaseToken, table_id: questionsTableId, record_id: recordId },
        data: { fields },
      });
      return assertSuccess(response, 'Increment unknown question').record;
    },

    async listDueTasks({ startMs, endMs }) {
      return (await listTaskRecords('List due tasks')).filter((task) => task.ownerOpenId
        && Number(task.deadline) >= startMs && Number(task.deadline) <= endMs
        && task.status !== '已完成');
    },

    async listTasks() {
      return listTaskRecords('List tasks');
    },

    async searchTasks({ name, ownerOpenId }) {
      return (await listTaskRecords('Search tasks')).filter((task) => (!name || task.name.includes(name))
        && (!ownerOpenId || task.ownerOpenId === ownerOpenId));
    },

    async getTask(recordId) {
      const response = await client.bitable.v1.appTableRecord.get({
        path: { app_token: taskBaseToken, table_id: tasksTableId, record_id: recordId },
      });
      return mapTask(assertSuccess(response, 'Get task').record);
    },

    async createTask(fields) {
      const response = await client.bitable.v1.appTableRecord.create({
        path: { app_token: taskBaseToken, table_id: tasksTableId },
        data: { fields: writableTaskFields(fields) },
      });
      return assertSuccess(response, 'Create task').record;
    },

    async updateTask(recordId, fields) {
      const response = await client.bitable.v1.appTableRecord.update({
        path: { app_token: taskBaseToken, table_id: tasksTableId, record_id: recordId },
        data: { fields: writableTaskFields(fields) },
      });
      return assertSuccess(response, 'Update task').record;
    },

    async deleteTask(recordId) {
      if (typeof recordId !== 'string' || !recordId.trim()) throw new Error('recordId must be non-empty');
      const response = await client.bitable.v1.appTableRecord.delete({
        path: { app_token: taskBaseToken, table_id: tasksTableId, record_id: recordId },
      });
      return assertSuccess(response, 'Delete task');
    },

    async listMembers() {
      const records = [];
      let pageToken;
      do {
        const response = await client.bitable.v1.appTableRecord.list({
          path: { app_token: taskBaseToken, table_id: membersTableId },
          params: { page_size: 500, page_token: pageToken },
        });
        const data = assertSuccess(response, 'List members');
        records.push(...(data.items || []));
        pageToken = data.has_more ? data.page_token : undefined;
      } while (pageToken);

      return records.map(({ record_id: recordId, fields }) => ({
        recordId,
        openId: fields['成员']?.[0]?.id || '',
        name: fields['成员']?.[0]?.name || fields['姓名'] || '',
        leaderOpenIds: (fields.leaders || []).map(({ id }) => id),
      }));
    },
  };
}
