const OPERATIONS = new Set([
  'query_tasks', 'create_task', 'update_task', 'delete_task',
  'complete_task', 'block_task', 'postpone_task', 'edit_task_form',
]);

const WRITABLE_FIELDS = new Set([
  '任务名', '负责人', '协作人', '状态', '进度', '开始日期', '截止日期',
  '完成时间', '阻塞原因', '优先级', '标签',
]);

const SELECTOR_FIELDS = new Set(['recordId', 'name', 'ownerOpenId']);

const SYSTEM_PROMPT = `你是任务意图解析器，只返回 JSON，不要返回 Markdown。\n操作只能是：${[...OPERATIONS].join(', ')}。\n可写字段只能是：${[...WRITABLE_FIELDS].join(', ')}。\n返回形状：{"operation":"...","selector":{},"fields":{}}。`;

function normalizeStatus(value) {
  if (/完成/.test(value)) return '已完成';
  if (/阻塞/.test(value)) return '阻塞中';
  if (/延期/.test(value)) return '已延期';
  if (value === '开始') return '进行中';
  return value;
}

function explicitCreateIntent(text, now) {
  const delegated = text.match(/帮\s*([^\s，,:：]+?)\s*(?:建|建立|创建|新增)(?:个|一个)?任务[：:，,\s]*/);
  const trigger = delegated || text.match(/(?:帮我)?(?:建|建立|创建|新增)(?:个|一个)?任务[：:，,\s]*/);
  if (!trigger) return null;

  const remainder = text.slice((trigger.index || 0) + trigger[0].length).trim();
  const name = remainder.split(/\s*(?:截止(?:日期|时间)?(?:为|是)?|现在开始|立即开始|从现在开始|负责人|优先级|状态\s*(?:为|是|成|到)?)\s*/)[0]?.trim();

  const current = new Date(now());
  const fields = name ? { 任务名: name } : {};
  if (delegated?.[1] && delegated[1] !== '我') fields['负责人'] = delegated[1];
  const deadline = text.match(/截止(?:日期|时间)?(?:为|是)?\s*(今天|明天)/);
  if (deadline) {
    const shifted = new Date(current.getTime() + 8 * 60 * 60 * 1_000);
    if (deadline[1] === '明天') shifted.setUTCDate(shifted.getUTCDate() + 1);
    const dateKey = shifted.toISOString().slice(0, 10);
    fields['截止日期'] = Date.parse(`${dateKey}T23:59:59+08:00`);
  }
  if (/(?:现在|立即|从现在)开始/.test(text)) {
    fields['开始日期'] = current.getTime();
    fields['状态'] = '进行中';
  }
  const status = text.match(/状态\s*(?:为|是|成|到)?\s*(未开始|进行中|阻塞中?|已?完成|已?延期|开始)/);
  if (status) fields['状态'] = normalizeStatus(status[1]);
  return { operation: 'create_task', selector: {}, fields };
}

function explicitStatusUpdateIntent(text) {
  const trigger = text.match(/(?:帮我)?(?:把\s*)?(?:修改|更改|更新|调整)(?:一下)?任务[：:，,\s]*/);
  if (!trigger) return null;

  const remainder = text.slice((trigger.index || 0) + trigger[0].length).trim();
  const match = remainder.match(/^(.+?)\s*(?:状态\s*)?(?:修改|更改|改)?(?:为|成|到)\s*(未开始|进行中|阻塞中?|已?完成|已?延期)\s*$/);
  if (!match) return null;

  const name = match[1].trim();
  if (!name) return null;
  const requestedStatus = match[2];
  if (/完成/.test(requestedStatus)) {
    return { operation: 'complete_task', selector: { name }, fields: {} };
  }
  const status = normalizeStatus(requestedStatus);
  return { operation: 'update_task', selector: { name }, fields: { 状态: status } };
}

function explicitDeleteIntent(text) {
  const match = text.trim().match(/^(?:帮我)?(?:删除|删掉|移除)(?:一下)?任务[：:，,\s]*(.+?)\s*$/);
  const name = match?.[1]?.trim();
  return name ? { operation: 'delete_task', selector: { name }, fields: {} } : null;
}

function explicitEditFormIntent(text) {
  const match = text.trim().match(/^(?:我要|我想|帮我)?(?:修改|编辑)任务(?:[：:，,\s]*(.*?))?\s*$/);
  if (!match) return null;
  const name = match[1]?.trim();
  return { operation: 'edit_task_form', selector: name ? { name } : { ownerOpenId: 'me' }, fields: {} };
}

function explicitMyTasksIntent(text) {
  if (/(?:帮我)?(?:查看|查询|盘点|列出)(?:一下)?我的任务/.test(text)) {
    return { operation: 'query_tasks', selector: { ownerOpenId: 'me' }, fields: {} };
  }
  return /^(?:帮我)?(?:任务盘点|盘点(?:一下)?任务)$/.test(text.trim())
    ? { operation: 'query_tasks', selector: {}, fields: {} }
    : null;
}

function hasTaskDomainCue(text) {
  return /任务|待办|截止(?:日期|时间)?|优先级|负责人|协作人|进度|阻塞|延期/.test(text);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFieldValue(value) {
  return ['string', 'number', 'boolean'].includes(typeof value)
    || (Array.isArray(value) && value.every((item) => ['string', 'number'].includes(typeof item)));
}

export function createTaskIntentParser({ minimax, clock = Date.now }) {
  return {
    isLikelyTask(text) {
      return hasTaskDomainCue(text);
    },

    async parse(text) {
      const explicit = explicitCreateIntent(text, clock);
      if (explicit) return explicit;
      const statusUpdate = explicitStatusUpdateIntent(text);
      if (statusUpdate) return statusUpdate;
      const explicitDelete = explicitDeleteIntent(text);
      if (explicitDelete) return explicitDelete;
      const editForm = explicitEditFormIntent(text);
      if (editForm) return editForm;
      const myTasks = explicitMyTasksIntent(text);
      if (myTasks) return myTasks;
      if (!hasTaskDomainCue(text)) return null;

      let candidate;
      try {
        candidate = JSON.parse(await minimax.completeWithSystem(SYSTEM_PROMPT, text));
      } catch {
        return null;
      }

      if (!isObject(candidate) || !OPERATIONS.has(candidate.operation)
        || !isObject(candidate.selector) || !isObject(candidate.fields)) return null;

      if (!Object.keys(candidate.selector).every((key) => SELECTOR_FIELDS.has(key))
        || !Object.keys(candidate.fields).every((key) => WRITABLE_FIELDS.has(key))) return null;

      const { selector, fields } = candidate;
      if (!Object.values(selector).every((value) => typeof value === 'string')
        || !Object.values(fields).every(isFieldValue)) return null;

      return {
        operation: candidate.operation,
        selector,
        fields,
      };
    },
  };
}
