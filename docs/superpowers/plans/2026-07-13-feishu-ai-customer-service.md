# 飞书 AI 智能客服演示版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个本地 Node.js 飞书机器人，通过长连接接收私聊及群聊 `@机器人` 文本，并使用 MiniMax M3 单轮回复。

**Architecture:** 飞书官方 SDK负责长连接、事件分发和消息回复；纯函数模块负责事件解析与触发判断；独立 MiniMax 客户端负责带超时的 HTTP 调用。入口只做依赖装配，使核心行为可通过 Node 内置测试框架测试。

**Tech Stack:** Node.js 20+、ES Modules、`@larksuiteoapi/node-sdk`、`dotenv`、Node 内置 `fetch` 与 `node:test`

## Global Constraints

- 仅处理私聊文本和群聊中明确 `@机器人` 的文本。
- 每条消息独立回答，不保存会话上下文。
- 图片、文件、语音、卡片和空消息静默忽略。
- 同一 `message_id` 在单次进程生命周期内只处理一次。
- 模型固定默认值为 `MiniMax-M3`，只发送最终回答，不发送推理内容。
- 真实凭证只存在于 `.env`，不得写入日志或 Git。
- 第一版不包含知识库、转人工、工单、管理后台和云端部署。

## File Map

- `package.json`：运行时依赖、脚本和 Node 版本约束。
- `.gitignore`：排除凭证与本地产物。
- `.env.example`：不含真实密钥的配置模板。
- `src/config.js`：读取并验证环境变量。
- `src/message-policy.js`：解析飞书文本、判断私聊/群聊触发条件、清理 mention。
- `src/deduplicator.js`：进程内消息去重。
- `src/minimax-client.js`：调用 MiniMax M3 并规范化错误。
- `src/message-handler.js`：编排消息策略、去重、模型调用和飞书回复。
- `src/index.js`：创建飞书 SDK客户端、事件分发器和长连接。
- `test/*.test.js`：对应模块的行为测试。
- `README.md`：飞书权限、事件、配置、启动和人工验收步骤。

---

### Task 1: 项目配置与环境变量校验

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: `NodeJS.ProcessEnv` 风格的键值对象。
- Produces: `loadConfig(env): { feishuAppId, feishuAppSecret, minimaxApiKey, minimaxBaseUrl, minimaxModel }`。

- [ ] **Step 1: 写失败测试**

```js
// test/config.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loads required values and defaults', () => {
  assert.deepEqual(loadConfig({
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'secret',
    MINIMAX_API_KEY: 'key',
  }), {
    feishuAppId: 'cli_test',
    feishuAppSecret: 'secret',
    minimaxApiKey: 'key',
    minimaxBaseUrl: 'https://api.minimaxi.com/v1',
    minimaxModel: 'MiniMax-M3',
  });
});

test('reports every missing required variable', () => {
  assert.throws(
    () => loadConfig({}),
    /FEISHU_APP_ID, FEISHU_APP_SECRET, MINIMAX_API_KEY/,
  );
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `node --test test/config.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/config.js`.

- [ ] **Step 3: 添加最小项目配置与实现**

```json
// package.json
{
  "name": "feishu-minimax-customer-service-demo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test"
  },
  "dependencies": {
    "@larksuiteoapi/node-sdk": "1.70.0",
    "dotenv": "^17.4.2"
  },
  "overrides": {
    "axios": "1.16.0"
  }
}
```

```gitignore
# .gitignore
node_modules/
.env
coverage/
*.log
```

```dotenv
# .env.example
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=replace_me
MINIMAX_API_KEY=replace_me
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M3
```

```js
// src/config.js
const REQUIRED = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'MINIMAX_API_KEY'];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    feishuAppId: env.FEISHU_APP_ID,
    feishuAppSecret: env.FEISHU_APP_SECRET,
    minimaxApiKey: env.MINIMAX_API_KEY,
    minimaxBaseUrl: env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
    minimaxModel: env.MINIMAX_MODEL || 'MiniMax-M3',
  };
}
```

- [ ] **Step 4: 安装依赖并运行测试**

Run: `npm install && npm test`
Expected: dependency installation succeeds; 2 tests PASS.

- [ ] **Step 5: 提交**

```bash
git add package.json package-lock.json .gitignore .env.example src/config.js test/config.test.js
git commit -m "chore: initialize feishu bot project"
```

### Task 2: 消息触发策略与进程内去重

**Files:**
- Create: `src/message-policy.js`
- Create: `src/deduplicator.js`
- Test: `test/message-policy.test.js`
- Test: `test/deduplicator.test.js`

**Interfaces:**
- Consumes: 飞书消息对象 `{ chat_type, message_type, content, mentions }`。
- Produces: `extractPrompt(message): string | null`；`createDeduplicator(): { claim(messageId): boolean }`。

- [ ] **Step 1: 写消息策略失败测试**

```js
// test/message-policy.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPrompt } from '../src/message-policy.js';

test('accepts non-empty private text', () => {
  assert.equal(extractPrompt({
    chat_type: 'p2p', message_type: 'text', content: '{"text":"你好"}', mentions: [],
  }), '你好');
});

test('ignores a group message without a mention', () => {
  assert.equal(extractPrompt({
    chat_type: 'group', message_type: 'text', content: '{"text":"你好"}', mentions: [],
  }), null);
});

test('removes the bot mention from a group prompt', () => {
  assert.equal(extractPrompt({
    chat_type: 'group',
    message_type: 'text',
    content: '{"text":"@_user_1 帮我介绍产品"}',
    mentions: [{ key: '@_user_1', name: '客服机器人' }],
  }), '帮我介绍产品');
});

test('ignores non-text, invalid JSON and empty text', () => {
  assert.equal(extractPrompt({ chat_type: 'p2p', message_type: 'image', content: '{}' }), null);
  assert.equal(extractPrompt({ chat_type: 'p2p', message_type: 'text', content: 'bad' }), null);
  assert.equal(extractPrompt({ chat_type: 'p2p', message_type: 'text', content: '{"text":"  "}' }), null);
});
```

- [ ] **Step 2: 运行消息策略测试并确认失败**

Run: `node --test test/message-policy.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 实现消息策略**

```js
// src/message-policy.js
export function extractPrompt(message) {
  if (message?.message_type !== 'text') return null;

  let parsed;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    return null;
  }

  let text = typeof parsed.text === 'string' ? parsed.text : '';
  if (message.chat_type === 'group') {
    if (!Array.isArray(message.mentions) || message.mentions.length === 0) return null;
    for (const mention of message.mentions) {
      if (mention?.key) text = text.replaceAll(mention.key, '');
    }
  }

  text = text.trim();
  return text || null;
}
```

- [ ] **Step 4: 写去重失败测试**

```js
// test/deduplicator.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeduplicator } from '../src/deduplicator.js';

test('claims each message id once', () => {
  const deduplicator = createDeduplicator();
  assert.equal(deduplicator.claim('om_1'), true);
  assert.equal(deduplicator.claim('om_1'), false);
  assert.equal(deduplicator.claim('om_2'), true);
});
```

- [ ] **Step 5: 运行去重测试并确认失败**

Run: `node --test test/deduplicator.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 6: 实现去重并运行测试**

```js
// src/deduplicator.js
export function createDeduplicator() {
  const seen = new Set();
  return {
    claim(messageId) {
      if (!messageId || seen.has(messageId)) return false;
      seen.add(messageId);
      return true;
    },
  };
}
```

Run: `node --test test/message-policy.test.js test/deduplicator.test.js`
Expected: 5 tests PASS.

- [ ] **Step 7: 提交**

```bash
git add src/message-policy.js src/deduplicator.js test/message-policy.test.js test/deduplicator.test.js
git commit -m "feat: add feishu message policy"
```

### Task 3: MiniMax M3 客户端

**Files:**
- Create: `src/minimax-client.js`
- Test: `test/minimax-client.test.js`

**Interfaces:**
- Consumes: 构造参数 `{ apiKey, baseUrl, model, fetchImpl?, timeoutMs? }` 与 `answer(prompt)`。
- Produces: `createMiniMaxClient(options): { answer(prompt): Promise<string> }`；失败统一抛出 `MiniMax request failed`。

- [ ] **Step 1: 写成功与失败路径测试**

```js
// test/minimax-client.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiniMaxClient } from '../src/minimax-client.js';

const options = { apiKey: 'key', baseUrl: 'https://example.test/v1', model: 'MiniMax-M3' };

test('returns final answer and sends no conversation history', async () => {
  let request;
  const client = createMiniMaxClient({
    ...options,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '最终回答' } }] }) };
    },
  });
  assert.equal(await client.answer('你好'), '最终回答');
  assert.equal(request.url, 'https://example.test/v1/chat/completions');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'MiniMax-M3');
  assert.deepEqual(body.messages.map(({ role }) => role), ['system', 'user']);
  assert.equal(request.init.headers.Authorization, 'Bearer key');
});

test('normalizes HTTP and empty-answer failures', async () => {
  const httpClient = createMiniMaxClient({ ...options, fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(() => httpClient.answer('x'), /MiniMax request failed/);
  const emptyClient = createMiniMaxClient({
    ...options,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }),
  });
  await assert.rejects(() => emptyClient.answer('x'), /MiniMax request failed/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/minimax-client.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 实现带超时的客户端**

```js
// src/minimax-client.js
const SYSTEM_PROMPT = '你是一个简洁、友善的客服助手。信息不足时明确说明，不要编造事实。';

export function createMiniMaxClient({
  apiKey,
  baseUrl,
  model,
  fetchImpl = fetch,
  timeoutMs = 30_000,
}) {
  return {
    async answer(prompt) {
      try {
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const answer = data?.choices?.[0]?.message?.content?.trim();
        if (!answer) throw new Error('Empty answer');
        return answer;
      } catch (error) {
        throw new Error('MiniMax request failed', { cause: error });
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/minimax-client.test.js`
Expected: 2 tests PASS.

- [ ] **Step 5: 提交**

```bash
git add src/minimax-client.js test/minimax-client.test.js
git commit -m "feat: add minimax m3 client"
```

### Task 4: 消息处理编排与飞书长连接入口

**Files:**
- Create: `src/message-handler.js`
- Create: `src/index.js`
- Test: `test/message-handler.test.js`

**Interfaces:**
- Consumes: `createMessageHandler({ minimax, reply, deduplicator, logger? })`，事件形状 `{ message, sender }`。
- Produces: 异步飞书事件处理函数；`src/index.js` 注册 `im.message.receive_v1` 并启动 `WSClient`。

- [ ] **Step 1: 写处理器测试**

```js
// test/message-handler.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeduplicator } from '../src/deduplicator.js';
import { createMessageHandler } from '../src/message-handler.js';

function event(overrides = {}) {
  return {
    message: {
      message_id: 'om_1', chat_type: 'p2p', message_type: 'text',
      content: '{"text":"你好"}', mentions: [], ...overrides,
    },
    sender: { sender_type: 'user' },
  };
}

test('answers a valid message once', async () => {
  const calls = [];
  const handler = createMessageHandler({
    minimax: { answer: async (prompt) => { calls.push(prompt); return '您好'; } },
    reply: async (messageId, text) => calls.push([messageId, text]),
    deduplicator: createDeduplicator(),
    logger: { error() {} },
  });
  await handler(event());
  await handler(event());
  assert.deepEqual(calls, ['你好', ['om_1', '您好']]);
});

test('ignores bot and non-triggering messages', async () => {
  let calls = 0;
  const handler = createMessageHandler({
    minimax: { answer: async () => { calls += 1; return 'x'; } },
    reply: async () => { calls += 1; },
    deduplicator: createDeduplicator(),
    logger: { error() {} },
  });
  await handler({ ...event(), sender: { sender_type: 'app' } });
  await handler(event({ message_id: 'om_2', chat_type: 'group', mentions: [] }));
  assert.equal(calls, 0);
});

test('replies with a safe message when MiniMax fails', async () => {
  const replies = [];
  const handler = createMessageHandler({
    minimax: { answer: async () => { throw new Error('secret upstream detail'); } },
    reply: async (_messageId, text) => replies.push(text),
    deduplicator: createDeduplicator(),
    logger: { error() {} },
  });
  await handler(event());
  assert.deepEqual(replies, ['暂时无法回答，请稍后重试']);
});
```

- [ ] **Step 2: 运行处理器测试并确认失败**

Run: `node --test test/message-handler.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 实现消息编排**

```js
// src/message-handler.js
import { extractPrompt } from './message-policy.js';

export function createMessageHandler({ minimax, reply, deduplicator, logger = console }) {
  return async function handle(event) {
    const { message, sender } = event;
    if (sender?.sender_type === 'app') return;
    if (!deduplicator.claim(message?.message_id)) return;
    const prompt = extractPrompt(message);
    if (!prompt) return;

    try {
      const answer = await minimax.answer(prompt);
      await reply(message.message_id, answer);
    } catch (error) {
      logger.error('Message processing failed', { messageId: message.message_id, error });
      try {
        await reply(message.message_id, '暂时无法回答，请稍后重试');
      } catch (replyError) {
        logger.error('Fallback reply failed', { messageId: message.message_id, error: replyError });
      }
    }
  };
}
```

- [ ] **Step 4: 运行处理器测试**

Run: `node --test test/message-handler.test.js`
Expected: 3 tests PASS.

- [ ] **Step 5: 创建飞书入口并连接现有模块**

```js
// src/index.js
import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config.js';
import { createDeduplicator } from './deduplicator.js';
import { createMiniMaxClient } from './minimax-client.js';
import { createMessageHandler } from './message-handler.js';

const config = loadConfig();
const client = new lark.Client({
  appId: config.feishuAppId,
  appSecret: config.feishuAppSecret,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

const minimax = createMiniMaxClient({
  apiKey: config.minimaxApiKey,
  baseUrl: config.minimaxBaseUrl,
  model: config.minimaxModel,
});

const reply = async (messageId, text) => {
  await client.im.message.reply({
    path: { message_id: messageId },
    data: { msg_type: 'text', content: JSON.stringify({ text }) },
  });
};

const handler = createMessageHandler({
  minimax,
  reply,
  deduplicator: createDeduplicator(),
});

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': handler,
});

const wsClient = new lark.WSClient({
  appId: config.feishuAppId,
  appSecret: config.feishuAppSecret,
  domain: lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.info,
});

await wsClient.start({ eventDispatcher });
```

- [ ] **Step 6: 运行完整自动化测试**

Run: `npm test`
Expected: 12 tests PASS and no unhandled rejection.

- [ ] **Step 7: 提交**

```bash
git add src/message-handler.js src/index.js test/message-handler.test.js
git commit -m "feat: connect feishu messages to minimax"
```

### Task 5: 操作文档与端到端验收

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: 已创建且启用机器人的飞书企业自建应用、长连接模式、MiniMax API Key。
- Produces: 可重复执行的配置、启动和人工验收说明。

- [ ] **Step 1: 编写 README**

```markdown
# 飞书 MiniMax M3 客服机器人演示

## 前置条件

- Node.js 20 或更高版本
- 已启用机器人能力的飞书企业自建应用
- 飞书事件订阅使用长连接，并订阅 `im.message.receive_v1`
- 应用具有接收消息及回复消息所需权限，且已发布到测试成员可用的版本
- MiniMax API Key

## 配置与启动

```bash
npm install
cp .env.example .env
```

在 `.env` 中填写飞书 App ID、App Secret 和 MiniMax API Key，然后运行：

```bash
npm test
npm start
```

看到长连接成功日志后，在飞书中进行测试。不要提交或分享 `.env`。

## 验收

1. 私聊机器人发送“你好”，应收到一条回复。
2. 在群聊中发送普通文本，机器人应保持沉默。
3. 在群聊中 `@机器人` 并提问，应收到针对原消息的回复。
4. 图片、文件、语音和空文本应被忽略。
5. 临时使用无效 MiniMax Key 时，用户只能看到“暂时无法回答，请稍后重试”。

## 当前范围

本项目不保存上下文，不包含知识库、转人工、工单、管理后台或云端部署。
```

- [ ] **Step 2: 执行质量门**

Run: `npm test && node --check src/index.js && node --check src/message-handler.js && node --check src/minimax-client.js`
Expected: all tests PASS; every syntax check exits 0.

- [ ] **Step 3: 使用真实凭证进行人工验收**

Run: `cp .env.example .env`, fill the three secrets locally, then `npm start`.
Expected: 长连接启动成功；README 中五项验收行为全部符合预期；终端日志不显示任何真实密钥。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: add setup and acceptance guide"
```
