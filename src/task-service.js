function candidates(tasks) {
  return tasks.map(({ recordId, name, ownerName, deadline }) => ({ recordId, name, ownerName, deadline }));
}

function formatTask(task) {
  const deadline = task.deadline ? `，截止时间：${task.deadline}` : '';
  return `${task.name}（负责人：${task.ownerName || '未指定'}，状态：${task.status || '未设置'}${deadline}）`;
}

const EDITABLE_TASK_STATUSES = new Set(['未开始', '进行中', '阻塞中', '已延期']);

async function resolveOwner(fields, members) {
  if (!('负责人' in fields) || typeof fields['负责人'] !== 'string') return fields;
  if (/^ou_[a-zA-Z0-9]+$/.test(fields['负责人'])) return fields;
  const matches = await members.resolveByName(fields['负责人']);
  if (matches.length === 1) return { ...fields, 负责人: matches[0].openId };
  if (matches.length > 1) return null;
  if (typeof members.refresh !== 'function') return null;
  const openIdMatches = (await members.refresh()).filter((member) => member.openId === fields['负责人']);
  if (openIdMatches.length !== 1) return null;
  return { ...fields, 负责人: openIdMatches[0].openId };
}

function shanghaiDefaultDeadline(now) {
  const dateKey = new Date(now + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  return Date.parse(`${dateKey}T18:30:00+08:00`);
}

function defaultPriority(activeTaskCount) {
  return ['P0', 'P1', 'P2', 'P3'][Math.min(activeTaskCount, 3)];
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
        if (typeof fields['任务名'] !== 'string' || !fields['任务名'].trim()) {
          return { kind: 'need_input', field: '任务名', text: '请提供任务名。' };
        }
        const now = clock();
        const createFields = {
          状态: '未开始',
          开始日期: now,
          截止日期: shanghaiDefaultDeadline(now),
          ...fields,
          负责人: '负责人' in fields ? fields['负责人'] : actorOpenId,
        };
        let resolvedFields = await resolveOwner(createFields, members);
        if (!resolvedFields) return { kind: 'result', text: '无法唯一确定负责人。' };
        if (!('优先级' in resolvedFields)) {
          const ownerTasks = await base.searchTasks({ ownerOpenId: resolvedFields['负责人'] });
          const activeTaskCount = ownerTasks.filter((task) => task.status === '进行中').length;
          resolvedFields = { ...resolvedFields, 优先级: defaultPriority(activeTaskCount) };
        }
        return prepareConfirmation(
          actorOpenId,
          { operation, fields: resolvedFields },
          null,
          resolvedFields,
        );
      }

      const searchSelector = {};
      if (selector.name) searchSelector.name = selector.name;
      if (selector.ownerOpenId) searchSelector.ownerOpenId = selector.ownerOpenId === 'me' ? actorOpenId : selector.ownerOpenId;
      let tasks = await base.searchTasks(searchSelector);
      if (selector.recordId) tasks = tasks.filter((item) => item.recordId === selector.recordId);

      if (operation === 'query_tasks') {
        return {
          kind: tasks.length ? 'task_list' : 'result',
          tasks,
          text: tasks.length ? tasks.map(formatTask).join('\n') : '没有找到匹配的任务。',
        };
      }
      if (operation === 'edit_task_form') {
        if (selector.ownerOpenId && !selector.name && !selector.recordId) {
          const editableTasks = tasks.filter((task) => EDITABLE_TASK_STATUSES.has(task.status));
          return {
            kind: editableTasks.length ? 'edit_task_picker' : 'result',
            tasks: editableTasks,
            text: editableTasks.length ? editableTasks.map(formatTask).join('\n') : '没有找到可修改的任务。',
          };
        }
        if (tasks.length === 0) return { kind: 'result', text: '没有找到匹配的任务。' };
        if (tasks.length > 1) return { kind: 'disambiguation', candidates: candidates(tasks) };
        return { kind: 'edit_form', task: tasks[0] };
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
      const action = await confirmations.begin(confirmationId, actorOpenId);
      if (!action) return { kind: 'result', text: '该操作已处理。' };

      try {
        if (action.operation === 'create_task') await base.createTask(action.fields);
        else if (['update_task', 'complete_task', 'block_task', 'postpone_task'].includes(action.operation)) {
          await base.updateTask(action.recordId, action.fields);
        }
        else if (action.operation === 'delete_task') await base.deleteTask(action.recordId);
        else throw new Error(`Unsupported confirmed operation: ${action.operation}`);
      } catch (error) {
        await confirmations.markFailed(confirmationId, actorOpenId);
        throw error;
      }

      await confirmations.markSucceeded(confirmationId, actorOpenId);
      return { kind: 'result', text: '操作成功。' };
    },

    async cancel(confirmationId, actorOpenId) {
      const cancelled = await confirmations.cancel(confirmationId, actorOpenId);
      return { kind: 'result', text: cancelled ? '操作已取消。' : '该操作已处理。' };
    },
  };
}
