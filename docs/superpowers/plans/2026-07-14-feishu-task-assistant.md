# 飞书客服机器人任务助理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有飞书客服机器人中增加受控任务增删改查、每天 18:00 的负责人确认与 leader 只读汇总，以及逐人授权的当天聊天总结和任务草稿。

**Architecture:** 保留现有 WebSocket 消息入口和 RAG 回答链路，在其前面增加确定性的意图路由与确认会话。Base、成员关系、提醒计划、授权和聊天读取分别封装；MiniMax 只生成结构化候选或总结，所有写入由代码校验并在用户确认后执行。提醒与回调使用本地 JSON 持久化幂等账本，个人聊天使用飞书 OAuth 用户令牌并加密落盘。

**Tech Stack:** Node.js 20+、ES Modules、`node:test`、`@larksuiteoapi/node-sdk@1.70.0`、MiniMax Chat Completions、飞书 Base/OpenAPI/WebSocket、Node.js `http`/`crypto`/`fs`。

## Global Constraints

- 任务 Base 固定为 `XO9fbDo43aXczZs3OuocVocjnAZ`，任务表固定为 `tbliLNuRPkP4KXlH`，Members 表固定为 `tblWZXTAt5stHJLg`；运行配置仍通过环境变量注入，不在源码写凭证。
- 提醒时区固定为 `Asia/Shanghai`；每天 18:00 只处理当天截止、负责人非空且状态不是`已完成`的任务。
- 负责人收到可操作卡片；leader 只收到按下属聚合的只读快照，不能修改任务，也不能看到聊天正文或总结。
- 每位当天有截止任务的负责人在 18:00 收到个人聊天授权询问；拒绝、超时或未授权时不得读取聊天。
- 原始聊天正文只在本次内存处理，不写入 Base、持久化文件或普通日志。
- 聊天任务草稿默认负责人为授权人本人，允许确认前修改；未经明确确认不得写入。
- 删除、负责人变更、延期、阻塞和聊天任务批量创建均走确认流程；重复回调不得重复写入。
- 不新增数据库、Web 框架或队列；第一版复用现有 SDK 和 Node.js 标准库，以最少代码完成可验证闭环。
- 当前目录不是 Git 仓库。计划中的提交步骤只有在用户另行授权初始化 Git 或接入已有仓库后执行；在此之前跳过提交，不擅自创建远端仓库。

---

## 文件结构

### 新增文件

- `src/json-store.js`：原子写入 JSON 状态，供确认、提醒和 OAuth 令牌存储复用。
- `src/date-window.js`：计算 Asia/Shanghai 当天范围和下次 18:00。
- `src/task-intent.js`：把自然语言解析为有限任务意图并进行形状校验。
- `src/task-service.js`：任务定位、草稿预览、确认后写入和业务不变量。
- `src/confirmation-store.js`：保存短期确认草稿和幂等消费状态。
- `src/member-service.js`：按人员 ID 映射 Members 记录与 leaders。
- `src/reminder-service.js`：构造负责人提醒与 leader 汇总计划。
- `src/reminder-scheduler.js`：在 18:00 触发并用持久化账本避免重复。
- `src/feishu-messenger.js`：发送文本、卡片和解析卡片回调。
- `src/token-vault.js`：AES-256-GCM 加密用户 OAuth 令牌。
- `src/oauth-server.js`：最小 HTTP OAuth 回调入口。
- `src/chat-history.js`：用户身份搜索当天消息并分页取回文本内容。
- `src/chat-summary.js`：生成个人总结和结构化任务草稿。
- 对应 `test/*.test.js`：每个模块的单元测试。

### 修改文件

- `src/config.js`：增加任务表、Members 表、状态文件、OAuth 和监听端口配置。
- `src/base-client.js`：增加任务与 Members 的最小 Base 操作。
- `src/minimax-client.js`：增加带专用 system prompt 的通用完成入口。
- `src/message-handler.js`：接入任务路由，不破坏现有知识问答。
- `src/index.js`：组装模块、注册消息与卡片回调、启动调度器和 OAuth HTTP 服务。
- `README.md`、`.env.example`：补充权限、配置、部署和验收步骤。

---

### Task 1: 配置、日期窗口与 JSON 持久化基础

**Files:**
- Create: `src/date-window.js`
- Create: `src/json-store.js`
- Modify: `src/config.js`
- Test: `test/date-window.test.js`
- Test: `test/json-store.test.js`
- Modify: `test/config.test.js`

**Interfaces:**
- Produces: `shanghaiDayWindow(now): { dateKey, startSeconds, endSeconds }`
- Produces: `millisecondsUntilNextRun(now, hour): number`
- Produces: `createJsonStore({ path, defaultValue }): { read(), update(mutator) }`
- Produces config keys: `tasksTableId`, `membersTableId`, `statePath`, `tokenPath`, `tokenEncryptionKey`, `oauthRedirectUri`, `port`

- [ ] **Step 1: 写日期边界失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { millisecondsUntilNextRun, shanghaiDayWindow } from '../src/date-window.js';

test('computes Shanghai day boundaries as epoch seconds', () => {
  assert.deepEqual(shanghaiDayWindow(new Date('2026-07-14T10:30:00Z')), {
    dateKey: '2026-07-14', startSeconds: 1783958400, endSeconds: 1784044799,
  });
});

test('schedules the next 18:00 Shanghai run', () => {
  assert.equal(millisecondsUntilNextRun(new Date('2026-07-14T09:00:00Z'), 18), 3_600_000);
  assert.equal(millisecondsUntilNextRun(new Date('2026-07-14T11:00:00Z'), 18), 82_800_000);
});
```

- [ ] **Step 2: 运行日期测试确认失败**

Run: `node --test test/date-window.test.js`

Expected: FAIL，报错为找不到 `src/date-window.js`。

- [ ] **Step 3: 实现固定时区日期函数**

```js
const OFFSET_MS = 8 * 60 * 60 * 1000;

export function shanghaiDayWindow(now = new Date()) {
  const shifted = new Date(now.getTime() + OFFSET_MS);
  const dateKey = shifted.toISOString().slice(0, 10);
  const startMs = Date.parse(`${dateKey}T00:00:00+08:00`);
  return { dateKey, startSeconds: startMs / 1000, endSeconds: (startMs + 86_400_000 - 1) / 1000 };
}

export function millisecondsUntilNextRun(now = new Date(), hour = 18) {
  const { dateKey } = shanghaiDayWindow(now);
  let target = Date.parse(`${dateKey}T${String(hour).padStart(2, '0')}:00:00+08:00`);
  if (target <= now.getTime()) target += 86_400_000;
  return target - now.getTime();
}
```

- [ ] **Step 4: 写 JSON store 失败测试并实现原子替换**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJsonStore } from '../src/json-store.js';

test('serializes concurrent updates without losing data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kefu-store-'));
  const path = join(dir, 'state.json');
  const store = createJsonStore({ path, defaultValue: { count: 0 } });
  await Promise.all([store.update((s) => ({ count: s.count + 1 })), store.update((s) => ({ count: s.count + 1 }))]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { count: 2 });
});
```

实现 `createJsonStore` 时使用单一 Promise 队列、`mkdir(dirname(path), {recursive:true})`、同目录临时文件和 `rename`；`read()` 遇到 `ENOENT` 返回结构化克隆的 `defaultValue`，其他错误继续抛出。

- [ ] **Step 5: 扩展配置并验证必填项**

在 `REQUIRED` 中增加：

```js
'FEISHU_TASKS_TABLE_ID', 'FEISHU_MEMBERS_TABLE_ID',
'TOKEN_ENCRYPTION_KEY', 'OAUTH_REDIRECT_URI',
```

在返回值中增加：

```js
tasksTableId: env.FEISHU_TASKS_TABLE_ID,
membersTableId: env.FEISHU_MEMBERS_TABLE_ID,
statePath: env.TASK_ASSISTANT_STATE_PATH || '.data/task-assistant-state.json',
tokenPath: env.USER_TOKEN_PATH || '.data/user-tokens.json',
tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
oauthRedirectUri: env.OAUTH_REDIRECT_URI,
port: Number(env.PORT || 3000),
```

测试同时断言默认路径、端口和缺失变量列表。

- [ ] **Step 6: 运行本任务测试**

Run: `node --test test/date-window.test.js test/json-store.test.js test/config.test.js`

Expected: 全部 PASS。

- [ ] **Step 7: 条件式提交**

如果执行时已有 Git 仓库：

```bash
git add src/date-window.js src/json-store.js src/config.js test/date-window.test.js test/json-store.test.js test/config.test.js
git commit -m "feat: add task assistant runtime foundations"
```

---

### Task 2: 扩展 Base 客户端与成员映射

**Files:**
- Modify: `src/base-client.js`
- Create: `src/member-service.js`
- Modify: `test/base-client.test.js`
- Create: `test/member-service.test.js`

**Interfaces:**
- Produces: `base.listDueTasks({ startMs, endMs })`
- Produces: `base.searchTasks({ name, ownerOpenId })`
- Produces: `base.createTask(fields)`, `base.updateTask(recordId, fields)`, `base.deleteTask(recordId)`
- Produces: `base.listMembers()`
- Produces: `createMemberService({ base }).leadersByOwner(openId): string[]`

- [ ] **Step 1: 写 Base 查询和映射失败测试**

覆盖以下真实负载：

```js
const due = await base.listDueTasks({ startMs: 1783958400000, endMs: 1784044799999 });
assert.equal(calls[0].path.table_id, 'tbl_tasks');
assert.match(calls[0].data.filter.conditions[0].field_name, /截止日期/);
assert.deepEqual(due[0], {
  recordId: 'rec1', name: '首页设计', ownerOpenId: 'ou_owner', ownerName: '张三',
  status: '进行中', progress: 60, deadline: 1784041200000, priority: 'P1', blocker: '',
});
```

同时测试 `createTask`、`updateTask`、`deleteTask` 使用 `tasksTableId`，以及 `listMembers` 把`leaders`映射为 `leaderOpenIds`。

- [ ] **Step 2: 运行测试确认接口不存在**

Run: `node --test test/base-client.test.js test/member-service.test.js`

Expected: FAIL，报错为目标方法不存在。

- [ ] **Step 3: 最小扩展 Base 客户端**

把 `createBaseClient` 参数扩展为：

```js
export function createBaseClient({
  client, baseToken, knowledgeTableId, questionsTableId, tasksTableId, membersTableId,
})
```

新增任务映射函数，只保留业务需要字段。`listDueTasks` 使用 `appTableRecord.search` 的 `and` filter：`截止日期 >= startMs`、`截止日期 <= endMs`、`负责人 isNotEmpty`、`状态 isNot 已完成`，并遍历 `has_more/page_token`。所有人员字段读取 `id`，不使用姓名作为键。

写入规则：

```js
const WRITABLE_TASK_FIELDS = new Set([
  '任务名', '负责人', '协作人', '状态', '进度', '开始日期', '截止日期', '完成时间', '阻塞原因', '优先级', '标签',
]);
```

`createTask` 和 `updateTask` 遇到集合外字段立即抛错。人员字段写成 `[{ id: openId }]`。`deleteTask` 只接受非空 `recordId`。

- [ ] **Step 4: 实现成员服务**

```js
export function createMemberService({ base }) {
  let cache = null;
  return {
    async refresh() { cache = await base.listMembers(); return cache; },
    async leadersByOwner(openId) {
      const members = cache || await this.refresh();
      return members.find((item) => item.openId === openId)?.leaderOpenIds || [];
    },
    async resolveByName(name) {
      const members = cache || await this.refresh();
      return members.filter((item) => item.name === name);
    },
  };
}
```

成员缓存只用于一次进程内减少请求；每天提醒前显式 `refresh()`，避免长期陈旧。

- [ ] **Step 5: 运行 Base 与成员测试**

Run: `node --test test/base-client.test.js test/member-service.test.js`

Expected: 全部 PASS，现有知识库测试仍通过。

- [ ] **Step 6: 条件式提交**

```bash
git add src/base-client.js src/member-service.js test/base-client.test.js test/member-service.test.js
git commit -m "feat: add task and member base access"
```

---

### Task 3: 任务意图解析、确认状态与确定性写入

**Files:**
- Modify: `src/minimax-client.js`
- Create: `src/task-intent.js`
- Create: `src/confirmation-store.js`
- Create: `src/task-service.js`
- Modify: `test/minimax-client.test.js`
- Create: `test/task-intent.test.js`
- Create: `test/confirmation-store.test.js`
- Create: `test/task-service.test.js`

**Interfaces:**
- Produces: `minimax.completeWithSystem(system, prompt): Promise<string>`
- Produces: `createTaskIntentParser({ minimax }).parse(text): TaskIntent | null`
- Produces: `createConfirmationStore({ store, ttlMs }).create/get/consume`
- Produces: `createTaskService({ base, members, confirmations, clock }).prepare(intent, actorOpenId)`
- Produces: `taskService.confirm(confirmationId, actorOpenId)`

- [ ] **Step 1: 暴露受控 MiniMax 完成接口**

测试断言 `completeWithSystem('系统', '输入')` 只发送两条消息且保留既有错误归一化。实现：

```js
async completeWithSystem(system, prompt) {
  return complete([{ role: 'system', content: system }, { role: 'user', content: prompt }]);
}
```

- [ ] **Step 2: 写意图白名单失败测试**

```js
test('rejects unknown operations and strips unknown fields', async () => {
  const minimax = { completeWithSystem: async () => JSON.stringify({ operation: 'run_shell', fields: { secret: 'x' } }) };
  const parser = createTaskIntentParser({ minimax });
  assert.equal(await parser.parse('执行命令'), null);
});

test('accepts a create task candidate', async () => {
  const minimax = { completeWithSystem: async () => JSON.stringify({
    operation: 'create_task', selector: {}, fields: { 任务名: '首页设计', 截止日期: '2026-07-17 18:00', 优先级: 'P1' },
  }) };
  assert.deepEqual(await createTaskIntentParser({ minimax }).parse('创建任务'), {
    operation: 'create_task', selector: {}, fields: { 任务名: '首页设计', 截止日期: '2026-07-17 18:00', 优先级: 'P1' },
  });
});
```

白名单操作固定为 `query_tasks/create_task/update_task/delete_task/complete_task/block_task/postpone_task`；字段固定为 Task 2 的可写字段。JSON 解析失败、未知操作或错误形状返回 `null`，由现有 RAG 回答链路接管。

- [ ] **Step 3: 写确认存储的所有权和幂等测试**

测试必须证明：A 不能消费 B 的确认、过期确认不可用、同一确认只能消费一次。持久化形状固定为：

```js
{
  confirmations: {
    "cfm-id": { actorOpenId: "ou_a", action: {}, createdAt: 1784000000000, expiresAt: 1784000600000, consumedAt: null }
  }
}
```

- [ ] **Step 4: 实现任务服务业务不变量**

`prepare()` 返回以下联合形状之一：

```js
{ kind: 'result', text: '...' }
{ kind: 'disambiguation', candidates: [{ recordId, name, ownerName, deadline }] }
{ kind: 'confirmation', confirmationId, preview: { operation, before, after } }
{ kind: 'need_input', field: '阻塞原因' | '截止日期', text: '...' }
```

规则必须由代码执行：

- `complete_task` 强制 patch 为 `{状态:'已完成', 进度:100, 完成时间:clock()}`。
- `block_task` 无`阻塞原因`时返回 `need_input`。
- `postpone_task` 无新`截止日期`时返回 `need_input`。
- `delete_task`、负责人变更、阻塞、延期和创建任务都返回确认预览，不直接写入。
- 查询可以直接返回结果。
- 匹配多条任务返回 `disambiguation`。

`confirm()` 先原子消费确认，再调用对应 Base 写方法；重复调用返回“该操作已处理”，不得第二次写入。

- [ ] **Step 5: 运行任务域测试**

Run: `node --test test/minimax-client.test.js test/task-intent.test.js test/confirmation-store.test.js test/task-service.test.js`

Expected: 全部 PASS。

- [ ] **Step 6: 条件式提交**

```bash
git add src/minimax-client.js src/task-intent.js src/confirmation-store.js src/task-service.js test/minimax-client.test.js test/task-intent.test.js test/confirmation-store.test.js test/task-service.test.js
git commit -m "feat: add confirmed conversational task operations"
```

---

### Task 4: 消息路由与任务确认交互

**Files:**
- Create: `src/feishu-messenger.js`
- Modify: `src/message-handler.js`
- Create: `test/feishu-messenger.test.js`
- Modify: `test/message-handler.test.js`

**Interfaces:**
- Consumes: `taskIntent.parse`, `taskService.prepare`, `taskService.confirm`
- Produces: `createFeishuMessenger({ client }).sendText/sendCard/replyText`
- Changes: `createMessageHandler({ taskIntent, taskService, assistant, reply, deduplicator, logger })`

- [ ] **Step 1: 写路由失败测试**

新增测试证明：

```js
const taskIntent = { parse: async () => ({ operation: 'query_tasks', selector: {}, fields: {} }) };
const taskService = { prepare: async () => ({ kind: 'result', text: '你有 2 个任务' }) };
```

此时 handler 回复任务结果且不调用 `assistant.answer`；当 `parse()` 返回 `null` 时保持现有 RAG 行为。

- [ ] **Step 2: 修改消息处理器保持兼容**

核心顺序固定为：

```js
const intent = taskIntent ? await taskIntent.parse(prompt) : null;
const response = intent
  ? await taskService.prepare(intent, sender?.sender_id?.open_id)
  : { kind: 'result', text: await assistant.answer(prompt, sender?.sender_id?.open_id) };
await reply(message.message_id, response.text || formatTaskResponse(response));
```

第一版用文本展示确认 ID，并支持用户回复“确认 <id>”或“取消 <id>”。卡片按钮在 Task 6 接入，但文本确认必须保留为降级路径。

- [ ] **Step 3: 实现飞书消息适配器**

`sendText(openId, text, uuid)` 使用 `client.im.v1.message.create`，`receive_id_type=open_id`，`uuid` 作为幂等键。`sendCard` 接收已经过测试的 card 对象并序列化为 `interactive`。`replyText` 复用现有 reply API。

测试断言接收者 ID、消息类型、序列化内容和 uuid 均正确，错误响应 `code !== 0` 时抛出不含凭证的异常。

- [ ] **Step 4: 运行消息测试**

Run: `node --test test/message-handler.test.js test/feishu-messenger.test.js`

Expected: 全部 PASS，原有私聊、群聊 mention、去重和安全错误回复测试不回归。

- [ ] **Step 5: 条件式提交**

```bash
git add src/feishu-messenger.js src/message-handler.js test/feishu-messenger.test.js test/message-handler.test.js
git commit -m "feat: route task commands through confirmations"
```

---

### Task 5: 负责人提醒与 Leader 只读汇总计划

**Files:**
- Create: `src/reminder-service.js`
- Create: `test/reminder-service.test.js`

**Interfaces:**
- Consumes: `base.listDueTasks`, `members.refresh`, `members.leadersByOwner`
- Produces: `createReminderService({ base, members }).buildPlan(window)`

- [ ] **Step 1: 写聚合失败测试**

测试数据必须覆盖：两个负责人共享一个 leader、一个负责人有两个 leaders、无 Members 记录、已完成任务不在 Base 查询结果中。预期形状：

```js
{
  owners: [{ openId: 'ou_a', tasks: [{ recordId: 'r1', name: '任务A', status: '进行中' }] }],
  leaders: [{ openId: 'ou_l', owners: [{ openId: 'ou_a', name: '张三', tasks: [...] }] }],
  warnings: [{ ownerOpenId: 'ou_missing', reason: 'member_not_found' }],
}
```

- [ ] **Step 2: 实现纯聚合逻辑**

先 `members.refresh()`，再对任务按 `ownerOpenId` 分组；对每个 owner 读取 leaders，并用 `Map<leaderOpenId, Map<ownerOpenId, tasks>>` 聚合。排序固定为负责人姓名、优先级 P0→P3、截止时间、任务名，确保同一输入产生稳定消息和幂等键。

- [ ] **Step 3: 运行聚合测试**

Run: `node --test test/reminder-service.test.js`

Expected: 全部 PASS；leader 计划中不存在任何 action/button 字段。

- [ ] **Step 4: 条件式提交**

```bash
git add src/reminder-service.js test/reminder-service.test.js
git commit -m "feat: build owner and leader reminder plans"
```

---

### Task 6: 18:00 调度、卡片回调与持久化幂等

**Files:**
- Create: `src/reminder-scheduler.js`
- Modify: `src/feishu-messenger.js`
- Create: `test/reminder-scheduler.test.js`
- Modify: `test/feishu-messenger.test.js`

**Interfaces:**
- Consumes: `millisecondsUntilNextRun`, `reminderService.buildPlan`, `messenger.sendCard/sendText`, JSON store
- Produces: `createReminderScheduler({ clock, setTimer, store, reminderService, messenger, onConsent }).start/stop/runNow`
- Produces: `parseCardAction(event): { actorOpenId, action, taskId, batchId } | null`

- [ ] **Step 1: 写调度和重启幂等失败测试**

测试使用注入的 `clock` 和 `setTimer`，不得真实等待。第一次 `runNow()` 发送 owner、leader 和 consent 三类消息；使用同一状态文件创建第二个 scheduler 后再次执行，发送次数保持不变。状态形状：

```js
{
  reminderRuns: {
    "2026-07-14": {
      owner: { "ou_a": "sent" }, leader: { "ou_l": "sent" }, consent: { "ou_a": "sent" }
    }
  },
  confirmations: {}
}
```

- [ ] **Step 2: 构造两类卡片**

负责人卡片每个任务包含四个动作值：

```js
{ action: 'complete', taskId: 'rec1', batchId: '2026-07-14:ou_a' }
{ action: 'continue', taskId: 'rec1', batchId: '2026-07-14:ou_a' }
{ action: 'block', taskId: 'rec1', batchId: '2026-07-14:ou_a' }
{ action: 'postpone', taskId: 'rec1', batchId: '2026-07-14:ou_a' }
```

leader 消息使用 markdown 或无 action 的卡片，只展示下属、任务、状态、截止时间和阻塞原因。授权卡片只包含 `consent_chat_summary` 与 `decline_chat_summary`。

- [ ] **Step 3: 实现调度器**

`start()` 用一次性 `setTimeout` 安排下次 18:00；执行结束后重新计算下一次时间，不使用固定 24 小时 interval。每个接收者发送成功后立即原子更新账本；失败只记录该接收者并继续其他人。`runNow()` 接受注入日期，供测试和人工验收使用。

- [ ] **Step 4: 实现卡片回调解析与所有权检查**

解析 `event.operator.open_id` 和 `event.action.value`。负责人操作只有当 operator 等于任务当前负责人时才交给 `taskService`；leader 或其他人员点击返回无权限。回调的幂等键为 `open_message_id + action + taskId + operatorOpenId`。

- [ ] **Step 5: 运行调度与消息测试**

Run: `node --test test/reminder-scheduler.test.js test/feishu-messenger.test.js test/task-service.test.js`

Expected: 全部 PASS，包括服务重启后不重复发送、leader 无 action、非负责人不能修改。

- [ ] **Step 6: 条件式提交**

```bash
git add src/reminder-scheduler.js src/feishu-messenger.js test/reminder-scheduler.test.js test/feishu-messenger.test.js
git commit -m "feat: schedule idempotent daily task reminders"
```

---

### Task 7: 用户 OAuth 与加密令牌存储

**Files:**
- Create: `src/token-vault.js`
- Create: `src/oauth-server.js`
- Create: `test/token-vault.test.js`
- Create: `test/oauth-server.test.js`

**Interfaces:**
- Produces: `createTokenVault({ store, encryptionKey }).put/get/delete`
- Produces: `createOAuthServer({ client, vault, redirectUri, port, stateStore }).start/stop/authorizationUrl`

- [ ] **Step 1: 写加密与篡改失败测试**

测试断言磁盘 JSON 不包含 access token 或 refresh token 明文；正确 key 能解密；修改 ciphertext 后 `get()` 抛出认证失败。密钥格式固定为 32 字节 base64，长度不符时启动失败。

- [ ] **Step 2: 实现 AES-256-GCM vault**

每个用户记录使用独立随机 12 字节 IV，存储：

```js
{ iv: 'base64', ciphertext: 'base64', tag: 'base64', expiresAt: 1784000000000 }
```

明文 JSON 只包含 `accessToken/refreshToken/expiresAt/refreshExpiresAt/scope`。AAD 固定为用户 open_id，防止密文换用户。

- [ ] **Step 3: 写 OAuth state 与 callback 测试**

测试证明：state 一次性消费、10 分钟过期、callback code 通过 `client.accessToken.retrieveByAuthorizationCode({code, redirectUri})` 换取令牌、成功后 vault key 使用发起授权的负责人 open_id；无效 state 不换 token。

- [ ] **Step 4: 实现最小 HTTP 服务**

只提供：

- `GET /oauth/start?state=...`：校验一次性 state 后 302 跳转飞书授权页；
- `GET /oauth/callback?code=...&state=...`：换取并加密保存令牌，返回中文成功/失败纯文本；
- 其他路径返回 404。

授权 URL 只请求读取个人聊天所需 user scope；`redirect_uri` 必须与飞书后台登记值完全一致。HTTP 日志不得包含 code、token 或完整 query string。

- [ ] **Step 5: 运行 OAuth 测试**

Run: `node --test test/token-vault.test.js test/oauth-server.test.js`

Expected: 全部 PASS。

- [ ] **Step 6: 人工权限门**

执行实现前由用户在飞书开发者后台完成：登记 `OAUTH_REDIRECT_URI`、开通消息搜索/读取的用户身份权限、开通卡片回调、重新发布应用。未完成时前三阶段仍可验收，聊天读取阶段标记为 `human-review`，不得用 bot token 降级读取。

- [ ] **Step 7: 条件式提交**

```bash
git add src/token-vault.js src/oauth-server.js test/token-vault.test.js test/oauth-server.test.js
git commit -m "feat: add per-user OAuth token vault"
```

---

### Task 8: 当天聊天读取、私人总结与任务草稿

**Files:**
- Create: `src/chat-history.js`
- Create: `src/chat-summary.js`
- Create: `test/chat-history.test.js`
- Create: `test/chat-summary.test.js`

**Interfaces:**
- Consumes: `client.request`, `withUserAccessToken`, `vault`, `minimax.completeWithSystem`, `taskService`
- Produces: `createChatHistory({ client, vault }).listTextMessages(openId, window)`
- Produces: `createChatSummary({ minimax, taskService }).summarize(messages, actorOpenId)`

- [ ] **Step 1: 写未授权和分页失败测试**

未找到 token 时必须抛出 `UserAuthorizationRequired`，且 search API 调用数为 0。授权存在时通过 SDK 的底层 `client.request` 调用 IM 消息搜索接口。当前 SDK 1.70.0 没有暴露该接口的生成方法，因此不能误用返回结构不同的 `client.search.v2.message.create`：

```js
client.request({
  method: 'POST',
  url: `${client.domain}/open-apis/im/v1/messages/search`,
  params: { page_size: 50, page_token },
  data: { query: '', filter: { time_range: { start_time: startIso, end_time: endIso } } },
}, withUserAccessToken(accessToken));
```

其中 `startIso/endIso` 使用带 `+08:00` 的 ISO 8601 时间。空 query 配合时间 filter 是飞书消息搜索支持的全时间段查询。遍历 `has_more/page_token` 直至完整；如果平台限制导致仍有后续页，返回明确的 `incomplete: true`，不得把部分结果描述为完整总结。

把搜索返回的 message IDs 每 50 条一组，通过同一个用户 token 批量取详情：

```js
client.request({
  method: 'GET',
  url: `${client.domain}/open-apis/im/v1/messages/mget`,
  params: { message_ids: ids },
}, withUserAccessToken(accessToken));
```

只保留 `msg_type === 'text'` 且能解析出非空文本内容的消息，并按 `create_time` 升序排序。返回给总结服务的每条消息只包含 `messageId/chatId/createTime/senderId/text`；图片、文件、音视频和卡片不取资源内容。

- [ ] **Step 2: 实现令牌刷新**

如果 access token 将在 5 分钟内过期，先调用：

```js
client.accessToken.refresh({ refreshToken: token.refreshToken, scope: token.scope })
```

成功后立即更新 vault；刷新失败删除失效令牌并返回重新授权提示。任何日志都不包含消息正文或 token。

- [ ] **Step 3: 写总结与草稿验证测试**

MiniMax 返回固定 JSON：

```json
{
  "summary": {
    "important": ["确认首页周五上线"],
    "decisions": ["使用方案A"],
    "todos": ["完成首页设计"],
    "risks": ["接口可能延期"],
    "people": ["张三"]
  },
  "taskDrafts": [
    {"任务名":"完成首页设计","截止日期":"2026-07-17 18:00","优先级":"P1","来源摘要":"项目群讨论"}
  ]
}
```

测试断言未知顶级字段被丢弃、任务草稿默认负责人强制设置为 `actorOpenId`、无任务名的草稿被丢弃、原始消息不会进入返回值或持久化 store。

- [ ] **Step 4: 实现总结服务**

system prompt 明确：只根据输入消息总结，不推断未出现的事实；输出固定 JSON；把讨论、建议和假设标为风险而不是已确认任务。每次最多传入按时间切分后的有限文本；超过模型输入上限时先分块总结，再对分块结果做最终合并，不保存原始块。

返回形状固定为：

```js
{ summaryText: '...', drafts: [{ draftId, fields: { 任务名, 负责人: actorOpenId, 截止日期, 优先级 }, sourceSummary }] }
```

草稿写入 confirmation store；负责人可以在确认前通过文本命令或卡片修改负责人，最终调用 Task 3 的确认写入。

- [ ] **Step 5: 运行聊天模块测试**

Run: `node --test test/chat-history.test.js test/chat-summary.test.js test/token-vault.test.js`

Expected: 全部 PASS；未授权路径 API 调用数为 0，日志捕获中不存在原始正文。

- [ ] **Step 6: 条件式提交**

```bash
git add src/chat-history.js src/chat-summary.js test/chat-history.test.js test/chat-summary.test.js
git commit -m "feat: summarize authorized daily chats into task drafts"
```

---

### Task 9: 应用组装、权限文档与端到端验证

**Files:**
- Modify: `src/index.js`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `test/task-assistant-integration.test.js`

**Interfaces:**
- Consumes: Tasks 1–8 的所有稳定接口
- Produces: 可启动的单进程任务助理，WebSocket 接收消息与卡片回调，HTTP 仅处理 OAuth，定时器负责 18:00 运行

- [ ] **Step 1: 写集成失败测试**

用 fake Base、fake messenger、fake MiniMax、临时 JSON store 和固定时钟验证以下单一闭环：

1. 用户创建任务得到确认预览；
2. 确认后 Base 只写一次；
3. 18:00 负责人收到可操作提醒，leader 收到无 action 汇总；
4. 同日再次运行不重复发送；
5. 用户同意授权后才搜索聊天；
6. 总结草稿默认负责人是本人；
7. 草稿确认后 Base 新增一条任务。

- [ ] **Step 2: 组装应用入口**

`src/index.js` 保留现有知识同步，新增：

```js
const stateStore = createJsonStore({ path: config.statePath, defaultValue: { confirmations: {}, reminderRuns: {}, oauthStates: {} } });
const tokenStore = createJsonStore({ path: config.tokenPath, defaultValue: { users: {} } });
const base = createBaseClient({ client, baseToken: config.baseToken, knowledgeTableId: config.knowledgeTableId,
  questionsTableId: config.questionsTableId, tasksTableId: config.tasksTableId, membersTableId: config.membersTableId });
```

随后组装 member、confirmation、task intent、task service、messenger、reminder、vault、OAuth、chat history 和 chat summary。EventDispatcher 同时注册 `im.message.receive_v1` 与 `card.action.trigger`。先启动 HTTP 服务，再启动 scheduler，最后启动 WS client；任何必填配置失败都应在启动前退出。

- [ ] **Step 3: 更新环境模板**

`.env.example` 增加且不填真实值：

```dotenv
FEISHU_TASKS_TABLE_ID=tbliLNuRPkP4KXlH
FEISHU_MEMBERS_TABLE_ID=tblWZXTAt5stHJLg
TASK_ASSISTANT_STATE_PATH=.data/task-assistant-state.json
USER_TOKEN_PATH=.data/user-tokens.json
TOKEN_ENCRYPTION_KEY=
OAUTH_REDIRECT_URI=https://your-domain.example.com/oauth/callback
PORT=3000
```

`.gitignore` 必须包含 `.env`、`.data/`，避免提交令牌和运行状态。

- [ ] **Step 4: 更新 README 权限与部署清单**

README 明确列出：

- Base 读写、机器人发消息、卡片回调、用户身份消息搜索/读取权限；
- 应用可用范围必须覆盖负责人和 leaders；
- OAuth redirect URL 与公开 HTTPS 地址；
- 18:00 要求服务持续运行；
- 如何使用测试时钟或 `runNow()` 做人工验收；
- 未授权不读取、原始正文不落盘、leader 不看聊天总结；
- 令牌撤销与删除 `.data/user-tokens.json` 的运维步骤。

- [ ] **Step 5: 运行完整质量门**

Run: `npm test`

Expected: 全部测试 PASS，无 skipped、todo 或未处理 rejection。

Run: `node --check src/index.js`

Expected: 无输出，退出码 0。

Run: `rg -n "accessToken|refreshToken|APP_SECRET|聊天正文" .data README.md src test --glob '!*.test.js'`

Expected: `.data` 中无明文 token；源码只出现字段名和安全处理逻辑，不出现真实凭证或聊天正文样例。

- [ ] **Step 6: 人工飞书验收**

按设计文档第 10.2 节依次验证：任务增删改查、模糊消歧、18:00 owner/leader 消息、重启幂等、授权同意/拒绝/超时、私人总结、修改草稿负责人和最终写入。每一步记录 message ID、record ID 和结果，不记录聊天正文或 token。

- [ ] **Step 7: 条件式提交**

```bash
git add src/index.js .env.example .gitignore README.md test/task-assistant-integration.test.js
git commit -m "feat: wire the Feishu task assistant"
```

---

## 实施停止条件

- 如果 Base 字段类型与设计文档中已读取的结构不一致，停止写入并重新读取字段结构。
- 如果用户身份消息搜索权限无法获批，Task 1–6 可以完成并上线；Task 7–8 标记为 `human-review`，不得用 bot 身份替代读取个人聊天。
- 如果生产环境没有持续运行的服务或公开 HTTPS OAuth 回调地址，提醒和聊天总结不得宣称上线；只能完成本地测试。
- 同一修正方案连续失败两次后，重新检查权限、身份、重复机制、字段类型和环境，不做第三次相同补丁。
