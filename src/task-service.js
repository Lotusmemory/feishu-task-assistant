function candidates(tasks) {
  return tasks.map(({ recordId, name, ownerName, deadline }) => ({ recordId, name, ownerName, deadline }));
}

function formatTask(task) {
  const deadline = task.deadline ? `，截止时间：${task.deadline}` : '';
  return `${task.name}（负责人：${task.ownerName || '未指定'}，状态：${task.status || '未设置'}${deadline}）`;
}

async function resolveOwner(fields, members) {
  if (!('负责人' in fields) || typeof fields['负责人'] !== 'string') return fields;
  const matches = await members.resolveByName(fields['负责人']);
  if (matches.length !== 1) return null;
  return { ...fields, 负责人: matches[0].openId };
}

export function createTaskService({ base, members, confirmations, clock = Date.now }) {
  async function prepareConfirmation(actorOpenId, action, before, after) {
    const confirmationId = await confirmations.create(actorOpenId, action);
    return { kind: 'confirmation', confirmationId, preview: { operation: action.operation, before, after } };
  }

  return {
    async prepare(intent, actorOpenId) {
      const { operation, selector = {}, fields = {} } = intent;

      if (operation === 'create_task') {
        const resolvedFields = await resolveOwner(fields, members);
        if (!resolvedFields) return { kind: 'result', text: '无法唯一确定负责人。' };
        return prepareConfirmation(
          actorOpenId,
          { operation, fields: resolvedFields },
          null,
          resolvedFields,
        );
      }

      const searchSelector = {};
      if (selector.name) searchSelector.name = selector.name;
      if (selector.ownerOpenId) searchSelector.ownerOpenId = selector.ownerOpenId;
      let tasks = await base.searchTasks(searchSelector);
      if (selector.recordId) tasks = tasks.filter((item) => item.recordId === selector.recordId);

      if (operation === 'query_tasks') {
        return {
          kind: 'result',
          text: tasks.length ? tasks.map(formatTask).join('\n') : '没有找到匹配的任务。',
        };
      }
      if (tasks.length === 0) return { kind: 'result', text: '没有找到匹配的任务。' };
      if (tasks.length > 1) return { kind: 'disambiguation', candidates: candidates(tasks) };

      const task = tasks[0];
      if (operation === 'delete_task') {
        return prepareConfirmation(actorOpenId, { operation, recordId: task.recordId }, task, null);
      }

      let patch;
      if (operation === 'complete_task') {
        patch = { 状态: '已完成', 进度: 100, 完成时间: clock() };
      } else if (operation === 'block_task') {
        if (!fields['阻塞原因']) return { kind: 'need_input', field: '阻塞原因', text: '请提供阻塞原因。' };
        patch = { ...fields, 状态: '已阻塞' };
      } else if (operation === 'postpone_task') {
        if (!fields['截止日期']) return { kind: 'need_input', field: '截止日期', text: '请提供新的截止日期。' };
        patch = { ...fields };
      } else if (operation === 'update_task') {
        patch = { ...fields };
      } else {
        return { kind: 'result', text: '不支持的任务操作。' };
      }

      patch = await resolveOwner(patch, members);
      if (!patch) return { kind: 'result', text: '无法唯一确定负责人。' };
      return prepareConfirmation(
        actorOpenId,
        { operation, recordId: task.recordId, fields: patch },
        task,
        { ...task, ...patch },
      );
    },

    async confirm(confirmationId, actorOpenId) {
      const action = await confirmations.consume(confirmationId, actorOpenId);
      if (!action) return { kind: 'result', text: '该操作已处理。' };

      if (action.operation === 'create_task') await base.createTask(action.fields);
      else if (['update_task', 'complete_task', 'block_task', 'postpone_task'].includes(action.operation)) {
        await base.updateTask(action.recordId, action.fields);
      }
      else if (action.operation === 'delete_task') await base.deleteTask(action.recordId);
      else return { kind: 'result', text: '不支持的任务操作。' };

      return { kind: 'result', text: '操作成功。' };
    },
  };
}
