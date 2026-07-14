# 飞书卡片知识发布实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让两位白名单管理员通过飞书交互卡片快速或完整录入知识，安全地保存待审核或幂等发布并立即同步 RAG，同时彻底过滤面向用户输出中的 `<think>` 内容。

**Architecture:** 保留现有消息、Base、同步和 WebSocket 结构，新增纯函数卡片构建器、内存草稿仓库和卡片动作处理器。消息入口只负责识别精确命令，动作处理器每次按服务端白名单重新鉴权，并只从服务端草稿读取知识内容；Base 创建成功后将草稿置为终态，发布成功再调用现有 `knowledgeSync.sync()` 更新当前索引。

**Tech Stack:** Node.js 20+、ES modules、`node:test`、`@larksuiteoapi/node-sdk` 1.70.0、飞书 WebSocket / `card.action.trigger`、飞书 Base、MiniMax Chat Completions。

## Global Constraints

- 只允许 `KNOWLEDGE_ADMIN_OPEN_IDS` 中的两个 `open_id` 打开、提交、保存和发布卡片；不得按姓名鉴权，也不得在文档、日志或回复中输出真实 ID。
- 快速录入只整理用户提供的事实；完整录入不改写事实内容。
- 来源链接仅接受 `http:` 或 `https:`；无有效来源可保存“待审核”，但不可发布。
- 卡片仅携带不可猜测的 `draftId` 和动作标识，知识正文、状态、权限均以服务端为准。
- 同一草稿保存或发布最多写入一条 Base 记录；已保存、已发布、已取消或过期草稿不能再次执行写操作。
- Base 写入失败时草稿保持可重试；发布后索引同步失败时保留 Base 记录并明确提示由定时同步恢复。
- 不新增知识版本、会签、撤回、批量导入、后台页面或草稿持久化。
- 不修改现有无关文件，不提交或推送旧 Git 历史；真实密钥只存在 `.env`。

---

### Task 1: 安全配置与统一模型文本清理

**Files:**
- Modify: `src/config.js`
- Create: `src/model-output.js`
- Modify: `src/minimax-client.js`
- Test: `test/config.test.js`
- Create: `test/model-output.test.js`
- Modify: `test/minimax-client.test.js`

**Interfaces:**
- Produces: `stripThink(text: string): string`；`loadConfig()` 新增 `knowledgeAdminOpenIds: string[]`；MiniMax 客户端新增 `organizeKnowledge(rawKnowledge): Promise<KnowledgeFields>`。

- [ ] **Step 1: 为白名单配置写失败测试**

```js
test('loads exactly two knowledge administrator open ids', () => {
  const config = loadConfig({ ...requiredEnv, KNOWLEDGE_ADMIN_OPEN_IDS: 'ou_admin_1, ou_admin_2' });
  assert.deepEqual(config.knowledgeAdminOpenIds, ['ou_admin_1', 'ou_admin_2']);
});

test('rejects a missing or non-pair administrator whitelist', () => {
  assert.throws(() => loadConfig(requiredEnv), /KNOWLEDGE_ADMIN_OPEN_IDS/);
  assert.throws(() => loadConfig({ ...requiredEnv, KNOWLEDGE_ADMIN_OPEN_IDS: 'ou_only_one' }), /exactly two/);
});
```

- [ ] **Step 2: 运行 `node --test test/config.test.js`，确认新增测试因配置尚未实现而失败**

- [ ] **Step 3: 最小扩展配置读取**

```js
const knowledgeAdminOpenIds = (env.KNOWLEDGE_ADMIN_OPEN_IDS || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
if (new Set(knowledgeAdminOpenIds).size !== 2) {
  throw new Error('KNOWLEDGE_ADMIN_OPEN_IDS must contain exactly two unique open_ids');
}
```

- [ ] **Step 4: 为 `<think>` 清理和结构化知识解析写失败测试**

```js
test('removes complete, multiline and orphan think tags', () => {
  assert.equal(stripThink('<think>秘密\n推理</think>最终回答'), '最终回答');
  assert.equal(stripThink('答案</think>'), '答案');
  assert.equal(stripThink('<think>未闭合'), '');
});

test('organizes knowledge into validated fields and strips think output', async () => {
  const result = await client.organizeKnowledge('原始事实');
  assert.deepEqual(result, {
    title: 'VPN 使用', category: 'IT', questions: '如何连接 VPN',
    body: '按原始事实操作', keywords: 'VPN,远程办公', sourceUrl: '',
  });
});
```

- [ ] **Step 5: 运行 `node --test test/model-output.test.js test/minimax-client.test.js`，确认失败原因分别是导出和方法不存在**

- [ ] **Step 6: 实现清理函数，并让 `complete()` 在任何调用方拿到文本前统一清理**

```js
export function stripThink(text = '') {
  return String(text)
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<\/?think\b[^>]*>/gi, '')
    .trim();
}
```

- [ ] **Step 7: 为 `organizeKnowledge()` 使用严格 JSON 提示、`JSON.parse`、字段白名单和分类白名单；解析或字段缺失统一抛出 `Knowledge organization failed`**

```js
const CATEGORIES = new Set(['HR', '行政', 'IT', '业务流程', '其他']);
const parsed = JSON.parse(stripThink(answer));
const fields = ['title', 'category', 'questions', 'body', 'keywords'];
if (fields.some((key) => typeof parsed[key] !== 'string' || !parsed[key].trim()) || !CATEGORIES.has(parsed.category)) {
  throw new Error('Knowledge organization failed');
}
return Object.fromEntries(fields.map((key) => [key, parsed[key].trim()]));
```

- [ ] **Step 8: 运行 `node --test test/config.test.js test/model-output.test.js test/minimax-client.test.js`，预期全部通过**

### Task 2: 字段校验、草稿状态机与卡片构建

**Files:**
- Create: `src/knowledge-drafts.js`
- Create: `src/knowledge-cards.js`
- Create: `test/knowledge-drafts.test.js`
- Create: `test/knowledge-cards.test.js`

**Interfaces:**
- Produces: `cleanKnowledgeFields(input)`、`isValidSourceUrl(value)`、`createDraftStore({ randomId? })`，方法为 `create/get/update/claimWrite/completeWrite/releaseWrite/cancel`。
- Produces: `buildEntryCard()`、`buildQuickFormCard()`、`buildFullFormCard()`、`buildPreviewCard()`、`buildSuccessCard()`、`buildErrorCard()`；所有 action value 仅含 `{ action, draftId? }`。

- [ ] **Step 1: 写字段清理、URL 与状态机失败测试**

```js
test('accepts only http and https source urls', () => {
  assert.equal(isValidSourceUrl('https://example.test/policy'), true);
  assert.equal(isValidSourceUrl('javascript:alert(1)'), false);
  assert.equal(isValidSourceUrl(''), false);
});

test('claims one Base write and returns the completed result on repeated clicks', () => {
  const store = createDraftStore({ randomId: () => 'draft-1' });
  store.create({ mode: 'full', submitterOpenId: 'ou_admin', fields });
  assert.equal(store.claimWrite('draft-1', 'published').kind, 'claimed');
  store.completeWrite('draft-1', { state: 'published', recordId: 'rec-1' });
  assert.deepEqual(store.claimWrite('draft-1', 'published'), {
    kind: 'completed', state: 'published', recordId: 'rec-1', syncSucceeded: undefined,
  });
});
```

- [ ] **Step 2: 运行 `node --test test/knowledge-drafts.test.js`，确认模块不存在**

- [ ] **Step 3: 用 `Map` 和 `crypto.randomUUID()` 实现最小内存草稿仓库；状态仅允许 `editing -> preview -> writing -> saved|published|cancelled`，`releaseWrite()` 仅将失败写入恢复为 `preview`**

- [ ] **Step 4: 写卡片结构测试，断言入口按钮、两种表单字段、预览按钮齐全，且序列化后的卡片不包含管理员 ID；预览 action value 不包含标题、正文或来源**

```js
assert.deepEqual(preview.elements.at(-1).actions.map((item) => item.value.action),
  ['publish', 'save_review', 'edit', 'cancel']);
assert.equal(JSON.stringify(preview).includes('正文内容'), true);
assert.deepEqual(preview.elements.at(-1).actions[0].value, { action: 'publish', draftId: 'draft-1' });
```

- [ ] **Step 5: 运行 `node --test test/knowledge-cards.test.js`，确认失败后实现六个纯函数卡片构建器，沿用飞书卡片 JSON 2.0 支持的 `input`、`select_static` 和 `button` 元素**

- [ ] **Step 6: 运行 `node --test test/knowledge-drafts.test.js test/knowledge-cards.test.js`，预期全部通过**

### Task 3: Base 知识记录写入

**Files:**
- Modify: `src/base-client.js`
- Modify: `test/base-client.test.js`

**Interfaces:**
- Consumes: 已清理的 `KnowledgeFields`、`status: '待审核'|'已发布'`、提交人和审核人 `open_id`。
- Produces: `base.createKnowledge({ fields, status, submitterOpenId, reviewerOpenId?, now }): Promise<{ recordId: string }>`。

- [ ] **Step 1: 写失败测试，分别断言待审核不带审核人、已发布带实际审核人，来源字段使用 `{ text, link }`，时间为调用方传入值**

```js
await base.createKnowledge({ fields, status: '已发布', submitterOpenId: 'ou_submitter', reviewerOpenId: 'ou_reviewer', now: 1783987200000 });
assert.deepEqual(payload.data.fields, {
  标题: fields.title, 分类: fields.category, 适用问题: fields.questions,
  正文: fields.body, 关键词: fields.keywords,
  来源链接: { text: fields.sourceUrl, link: fields.sourceUrl },
  状态: '已发布', 更新时间: 1783987200000,
  提交人: [{ id: 'ou_submitter' }], 审核人: [{ id: 'ou_reviewer' }],
});
```

- [ ] **Step 2: 运行 `node --test test/base-client.test.js`，确认因 `createKnowledge` 不存在而失败**

- [ ] **Step 3: 只在现有 Base client 中增加 `createKnowledge()`，复用 `assertSuccess()`；空来源时省略来源字段，失败不得吞错**

- [ ] **Step 4: 运行 `node --test test/base-client.test.js`，预期全部通过**

### Task 4: 卡片动作处理器与幂等发布编排

**Files:**
- Create: `src/knowledge-card-handler.js`
- Create: `test/knowledge-card-handler.test.js`

**Interfaces:**
- Consumes: `{ adminOpenIds, drafts, minimax, base, syncKnowledge, updateIndex, sendCard, updateCard, now? }`。
- Produces: `createKnowledgeCardHandler(dependencies)` 返回 `handleCardAction(event)`；识别 `open_quick/open_full/submit_quick/submit_full/edit/save_review/publish/cancel`。

- [ ] **Step 1: 写权限失败测试：非白名单对每类动作均只收到无权限卡片，并断言 `drafts`、MiniMax、Base、同步均无调用**

- [ ] **Step 2: 写快速与完整录入失败测试：快速模式调用 `organizeKnowledge(rawKnowledge)` 后合并用户来源；完整模式只调用 `cleanKnowledgeFields()`，不调用模型；两者生成同一预览**

- [ ] **Step 3: 写来源和终态失败测试：无效来源发布返回错误且保留草稿；同一输入允许保存待审核；过期、取消和已完成草稿返回明确提示**

- [ ] **Step 4: 写幂等发布集成测试，用两个并发 `publish` 调用断言 `base.createKnowledge` 只调用一次；成功后 `syncKnowledge()` 只调用一次并将返回索引交给 `updateIndex(index)`**

```js
const [first, second] = await Promise.all([handler(publishEvent), handler(publishEvent)]);
assert.equal(baseCalls, 1);
assert.equal(syncCalls, 1);
assert.equal(drafts.get('draft-1').recordId, 'rec-1');
```

- [ ] **Step 5: 运行 `node --test test/knowledge-card-handler.test.js`，确认模块不存在**

- [ ] **Step 6: 最小实现动作路由；每次动作第一行调用 `adminOpenIds.has(event.operator.openId)`；表单值从 `event.action.value` 读取后立即校验，预览之后的动作只使用 `draftId` 查服务端草稿**

- [ ] **Step 7: 写入前调用 `claimWrite()`；Base 失败调用 `releaseWrite()`；Base 成功立即 `completeWrite()`，再处理发布同步，从而保证同步失败或重复点击都不会重复创建记录**

- [ ] **Step 8: 运行 `node --test test/knowledge-card-handler.test.js`，预期权限、录入、校验、失败恢复、并发幂等和同步测试全部通过**

### Task 5: 文本入口路由与飞书 WebSocket 集成

**Files:**
- Modify: `src/message-handler.js`
- Modify: `test/message-handler.test.js`
- Modify: `src/index.js`
- Create: `test/index-wiring.test.js`

**Interfaces:**
- Consumes: `knowledgeEntry.open({ requesterOpenId, messageId })`，卡片处理器和飞书 SDK `card.action.trigger`。
- Produces: 精确命令 `补充知识` 的管理员入口；普通问答行为不变。

- [ ] **Step 1: 写消息入口失败测试：精确文本 `补充知识` 调用入口服务并不调用 RAG；`补充知识：内容` 仍按普通问题处理；非管理员入口由入口服务安全拒绝**

- [ ] **Step 2: 运行 `node --test test/message-handler.test.js`，确认入口依赖尚未接入**

- [ ] **Step 3: 给 `createMessageHandler` 增加可选 `knowledgeEntry`，仅在 `prompt === '补充知识'` 时调用；保持现有去重、错误降级和普通消息路径不变**

- [ ] **Step 4: 将 `reply` 扩展为 `replyText` 与 `replyCard`，卡片消息使用 `msg_type: 'interactive'` 和 `content: JSON.stringify(card)`；不要改变普通文本格式**

- [ ] **Step 5: 在 `index.js` 创建草稿仓库与动作处理器，向现有 `EventDispatcher.register` 增加 `'card.action.trigger': handleCardAction`；同步成功后执行 `currentIndex = index`**

```js
const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (event) => handler(event),
  'card.action.trigger': async (event) => cardHandler(event),
});
```

- [ ] **Step 6: 写 wiring 测试或提取 `createApplication()` 后断言两个事件键都注册，卡片处理器收到回调操作者的 `open_id`，且日志不包含 action value 与白名单**

- [ ] **Step 7: 运行 `node --test test/message-handler.test.js test/index-wiring.test.js`，预期全部通过**

### Task 6: 回归、安全门与实机验收

**Files:**
- Modify: `.env.example`（若仓库已有该文件；否则只在 `README.md` 的现有配置段增加变量名，不填真实值）
- Modify: `README.md`（仅补充启动前的卡片回调配置与验收说明，保留当前未提交内容）

**Interfaces:**
- Consumes: 前五项完成后的应用。
- Produces: 测试、语法、安全和飞书实机证据；不推送 GitHub。

- [ ] **Step 1: 运行精确新增测试**

```bash
node --test test/config.test.js test/model-output.test.js test/minimax-client.test.js \
  test/knowledge-drafts.test.js test/knowledge-cards.test.js test/base-client.test.js \
  test/knowledge-card-handler.test.js test/message-handler.test.js test/index-wiring.test.js
```

预期：全部通过，无跳过、无失败。

- [ ] **Step 2: 运行完整回归 `npm test`，预期原 27 项及所有新增测试全部通过**

- [ ] **Step 3: 运行语法检查**

```bash
for file in src/*.js test/*.test.js; do node --check "$file" || exit 1; done
```

预期：退出码 0。

- [ ] **Step 4: 运行依赖安全检查 `npm audit --omit=dev`，记录实际结果；若存在高严重度问题，先停下评估最小升级范围，不做无关大版本升级**

- [ ] **Step 5: 执行敏感信息扫描且只报告路径和规则类型，不输出匹配内容**

```bash
git grep -l -E '(FEISHU_APP_SECRET|MINIMAX_API_KEY|SILICONFLOW_API_KEY)=' -- ':!package-lock.json'
```

预期：仅示例占位文件或无输出；若命中业务文件则停止，不提交。

- [ ] **Step 6: 在飞书开发者后台确认已订阅回调 `card.action.trigger` 并发布应用版本；此步骤需要用户在后台完成，因为本地代码无法证明租户侧配置状态**

- [ ] **Step 7: 重启机器人，分别以当前管理员、吴雷鸣和普通员工验证：入口权限、快速录入、完整录入、待审核、无来源禁止发布、发布后检索、转发卡片拒绝、重复点击不重复写入**

- [ ] **Step 8: 在 Base 核对待审核与已发布记录各自状态、提交人/审核人、来源和数量；再发送普通问题、未知问题及 `需要回访：问题` 验证无回归**

- [ ] **Step 9: 保存验证证据并运行 `git status --short`，确认只包含计划内文件和原先的 3 个既有未提交文件；不得提交、推送或部署，除非用户另行授权**

## 风险与停止条件

- 飞书卡片 JSON 2.0 的表单回调字段形态必须以 SDK 收到的真实事件为准；若本地构造测试与实机字段不同，先记录一份脱敏事件结构，再调整解析器，不把客户端字段当作可信状态。
- SDK WebSocket 虽能注册 `card.action.trigger`，但租户后台回调订阅和应用发布状态无法从当前本地仓库证明；未确认前状态为 `human-review`，不能声称实机完成。
- Base 人员字段若不接受 `[{ id: openId }]`，用脱敏的 API 错误和现有字段元数据确认实际格式，再作最小修改；禁止把真实 ID 打到日志。
- 同一方案连续失败两次后停止重复补丁，重新检查回调事件结构、重复处理机制、Base 字段类型和运行中的进程是否为当前代码。

