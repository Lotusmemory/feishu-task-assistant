const OPERATIONS = new Set([
  'query_tasks', 'create_task', 'update_task', 'delete_task',
  'complete_task', 'block_task', 'postpone_task',
]);

const WRITABLE_FIELDS = new Set([
  '任务名', '负责人', '协作人', '状态', '进度', '开始日期', '截止日期',
  '完成时间', '阻塞原因', '优先级', '标签',
]);

const SELECTOR_FIELDS = new Set(['recordId', 'name', 'ownerOpenId']);

const SYSTEM_PROMPT = `你是任务意图解析器，只返回 JSON，不要返回 Markdown。\n操作只能是：${[...OPERATIONS].join(', ')}。\n可写字段只能是：${[...WRITABLE_FIELDS].join(', ')}。\n返回形状：{"operation":"...","selector":{},"fields":{}}。`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFieldValue(value) {
  return ['string', 'number', 'boolean'].includes(typeof value)
    || (Array.isArray(value) && value.every((item) => ['string', 'number'].includes(typeof item)));
}

export function createTaskIntentParser({ minimax }) {
  return {
    async parse(text) {
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
