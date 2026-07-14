# 飞书内部员工知识助手 RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有飞书 MiniMax M3 机器人升级为基于飞书 Base 已发布知识、本地中文向量检索和安全拒答的内部员工知识助手。

**Architecture:** 飞书 Base 是知识与待补问题的事实来源；同步器将已发布知识切分并用硅基流动 `BAAI/bge-m3` 生成向量，原子写入本地 JSON 索引。问答时检索 Top 3 片段，达到 0.52 门槛才把片段交给 MiniMax M3；未命中则匿名合并写入待补问题池。

**Tech Stack:** Node.js 20+、`@larksuiteoapi/node-sdk`、SiliconFlow `BAAI/bge-m3`、MiniMax M3、飞书 Base、`node:test`

## Global Constraints

- 只有状态为“已发布”的知识可用于回答。
- Top K 固定为 3；相关度门槛由中文样本校准后写成明确默认值。
- 嵌入在本地完成，不向第三方嵌入服务发送内部知识。
- 未命中时不得调用 MiniMax 生成公司制度答案。
- 未知问题默认匿名；明确要求回访时才记录 `open_id`。
- Base 是事实来源，本地索引只是可重建缓存。
- `.env`、模型缓存和本地索引不得进入 Git。
- 不实现文档解析、实时 Base 事件、长期对话记忆或自动发布。

## File Map

- `package.json`：增加本地嵌入依赖与索引命令。
- `.env.example`：增加 Base token、两张表 ID、模型与索引路径模板。
- `.gitignore`：排除模型缓存和索引。
- `src/chunker.js`：审核知识的自然段切分与元数据保留。
- `src/embedder.js`：本地 E5 模型加载、query/passage 前缀和归一化向量。
- `scripts/evaluate-embedding.js`：一次性中文检索门槛评估。
- `src/vector-index.js`：余弦检索、Top 3、原子保存和加载。
- `src/base-client.js`：读取已发布知识、创建或合并待补问题。
- `src/knowledge-sync.js`：全量/增量拉取、向量化和索引替换。
- `src/rag-service.js`：检索、门槛判断、MiniMax 上下文与引用拼装。
- `src/unknown-question.js`：问题归一化、匿名与回访策略。
- `src/index.js`：启动检查、定时同步和消息处理接线。
- `test/*.test.js`：每个模块的行为测试。
- `README.md`：Base 配置、模型下载、同步与验收说明。

---

### Task 1: 创建飞书 Base 与安全配置

**Files:**
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig()` 新增 `baseToken`、`knowledgeTableId`、`questionsTableId`、`embeddingModel`、`modelCacheDir`、`indexPath`。

- [ ] **Step 1: 用 `lark-cli base +base-create --dry-run --as user` 验证知识库字段 JSON**

首表名为“知识库”，字段严格为：标题(text)、分类(select)、适用问题(text)、正文(text)、关键词(text)、来源链接(url text)、状态(select)、更新时间(updated_at)、提交人(created_by)、审核人(user)。状态选项为待审核、已发布、已下线。

- [ ] **Step 2: 创建 Base 与知识库表**

Run:

```bash
lark-cli base +base-create --name "内部员工知识助手" --table-name "知识库" --time-zone Asia/Shanghai --as user --fields '[{"type":"text","name":"标题"},{"type":"select","name":"分类","multiple":false,"options":[{"name":"HR"},{"name":"行政"},{"name":"IT"},{"name":"业务流程"},{"name":"其他"}]},{"type":"text","name":"适用问题"},{"type":"text","name":"正文"},{"type":"text","name":"关键词"},{"type":"text","name":"来源链接","style":{"type":"url"}},{"type":"select","name":"状态","multiple":false,"options":[{"name":"待审核"},{"name":"已发布"},{"name":"已下线"}]},{"type":"updated_at","name":"更新时间","style":{"format":"yyyy-MM-dd HH:mm"}},{"type":"created_by","name":"提交人"},{"type":"user","name":"审核人","multiple":false}]'
```

Expected: 返回真实 `base_token` 与知识库 `table_id`；记录返回值，不把完整 JSON 猜写进配置。

- [ ] **Step 3: 创建待补问题表**

将上一步返回的真实 token 写入当前终端变量 `BASE_TOKEN`，再运行：

```bash
lark-cli base +table-create --base-token "$BASE_TOKEN" --name "待补问题" --as user --fields '[{"type":"text","name":"原始问题"},{"type":"text","name":"归一化问题"},{"type":"select","name":"分类","multiple":false,"options":[{"name":"HR"},{"name":"行政"},{"name":"IT"},{"name":"业务流程"},{"name":"其他"}]},{"type":"number","name":"出现次数","style":{"type":"plain","precision":0}},{"type":"datetime","name":"首次提问时间","style":{"format":"yyyy-MM-dd HH:mm"}},{"type":"datetime","name":"最后提问时间","style":{"format":"yyyy-MM-dd HH:mm"}},{"type":"select","name":"状态","multiple":false,"options":[{"name":"待补充"},{"name":"处理中"},{"name":"已解决"},{"name":"忽略"}]},{"type":"checkbox","name":"是否要求回访"},{"type":"text","name":"回访用户"},{"type":"text","name":"关联知识"}]'
```

字段严格为：原始问题(text)、归一化问题(text)、分类(select)、出现次数(number precision 0)、首次提问时间(datetime)、最后提问时间(datetime)、状态(select)、是否要求回访(checkbox)、回访用户(text)、关联知识(text)。

Expected: 返回真实待补问题 `table_id`。

- [ ] **Step 4: 写配置失败测试**

在 `test/config.test.js` 增加断言：缺少三个 Base 变量时抛错；完整环境返回默认模型 `Xenova/multilingual-e5-small`、缓存目录 `.cache/models`、索引路径 `.data/knowledge-index.json`。

- [ ] **Step 5: 运行 RED**

Run: `node --test test/config.test.js`
Expected: FAIL，因为 `loadConfig()` 尚未校验和返回 Base 配置。

- [ ] **Step 6: 最小实现并更新安全模板**

`src/config.js` 将 `FEISHU_BASE_TOKEN`、`FEISHU_KNOWLEDGE_TABLE_ID`、`FEISHU_QUESTIONS_TABLE_ID` 加入必填配置；`.env.example` 只放占位符；`.gitignore` 增加 `.cache/`、`.data/`。

- [ ] **Step 7: 运行 GREEN 并提交**

Run: `node --test test/config.test.js`
Expected: PASS。

```bash
git add .env.example .gitignore src/config.js test/config.test.js
git commit -m "feat: configure internal knowledge base"
```

### Task 2: 验证本地中文嵌入模型

**Files:**
- Modify: `package.json`
- Create: `src/embedder.js`
- Create: `scripts/evaluate-embedding.js`
- Test: `test/embedder.test.js`

**Interfaces:**
- Produces: `createEmbedder({ model, cacheDir }): Promise<{ embedQuery(text), embedPassages(texts) }>`，返回单位长度 `number[]`。

- [ ] **Step 1: 安装固定依赖**

Run: `npm install @huggingface/transformers@4.2.0`

- [ ] **Step 2: 写 RED 测试**

测试使用注入的 pipeline，断言 query 使用 `query: ` 前缀、知识使用 `passage: ` 前缀、输出为普通数组且启用 mean pooling 与 normalize。

- [ ] **Step 3: 运行 RED**

Run: `node --test test/embedder.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 4: 最小实现**

```js
// src/embedder.js
import { pipeline } from '@huggingface/transformers';

export async function createEmbedder({ model, cacheDir, pipelineFactory = pipeline }) {
  const extractor = await pipelineFactory('feature-extraction', model, { cache_dir: cacheDir });
  async function embed(texts, prefix) {
    const output = await extractor(texts.map((text) => `${prefix}: ${text}`), {
      pooling: 'mean', normalize: true,
    });
    return output.tolist();
  }
  return {
    async embedQuery(text) { return (await embed([text], 'query'))[0]; },
    async embedPassages(texts) { return embed(texts, 'passage'); },
  };
}
```

- [ ] **Step 5: 运行 GREEN**

Run: `node --test test/embedder.test.js`
Expected: PASS。

- [ ] **Step 6: 建立中文评估脚本并实际下载模型**

评估集至少包含 12 组：请假/年假、报销/发票、VPN/远程访问、账号权限、合同审批、项目交付各两种改写；每个 query 必须把正确 passage 排在第 1，并输出正例分数与最高负例分数。

Run: `node scripts/evaluate-embedding.js`
Expected: 12/12 Top-1 正确；取“最低正例分数”和“最高负例分数”的中点作为门槛。若没有可分离区间，停止并重新选择模型，不继续 Task 3。

- [ ] **Step 7: 把实测门槛写入评估脚本常量说明并提交**

```bash
git add package.json package-lock.json src/embedder.js scripts/evaluate-embedding.js test/embedder.test.js
git commit -m "feat: add local chinese embeddings"
```

### Task 3: 知识切分与向量索引

**Files:**
- Create: `src/chunker.js`
- Create: `src/vector-index.js`
- Test: `test/chunker.test.js`
- Test: `test/vector-index.test.js`

**Interfaces:**
- Produces: `chunkKnowledge(record, { maxChars: 800, overlapChars: 80 })`；`createVectorIndex(entries, { threshold }).search(vector, 3)`；`saveIndexAtomic(path, data)`；`loadIndex(path)`。

- [ ] **Step 1: 写 chunker RED 测试**

覆盖自然段优先、超过 800 字再切、80 字重叠、每片保留 recordId/标题/分类/更新时间/来源链接/序号；非“已发布”返回空数组。

- [ ] **Step 2: 运行 RED，最小实现，再运行 GREEN**

Run: `node --test test/chunker.test.js`
Expected before: FAIL；after: PASS。

- [ ] **Step 3: 写索引 RED 测试**

使用手工二维单位向量断言余弦排序、Top 3、低于门槛返回空数组、同条知识相邻片段可返回、损坏 JSON 抛出 `Invalid knowledge index`。

- [ ] **Step 4: 运行 RED，最小实现，再运行 GREEN**

索引 JSON 只包含 `version`、`generatedAt`、`model`、`threshold` 和 entries；原子保存写入同目录临时文件后 rename。

Run: `node --test test/vector-index.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/chunker.js src/vector-index.js test/chunker.test.js test/vector-index.test.js
git commit -m "feat: add knowledge vector index"
```

### Task 4: 飞书 Base 读写适配器

**Files:**
- Create: `src/base-client.js`
- Test: `test/base-client.test.js`

**Interfaces:**
- Produces: `createBaseClient({ client, baseToken, knowledgeTableId, questionsTableId })`，方法 `listPublishedKnowledge()`、`findQuestion(normalized)`、`createQuestion(data)`、`incrementQuestion(recordId, data)`。

- [ ] **Step 1: 写 RED 测试**

用注入的飞书 client 验证：知识查询包含“状态=已发布”服务端过滤并处理分页；返回字段映射为稳定内部类型；问题查询按归一化问题精确匹配；写入匿名问题不含回访用户；更新次数使用现有值加一。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/base-client.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 按已安装飞书 SDK 的 `base.v1.appTableRecord` 实际签名实现**

实现前用 `rg "appTableRecord" node_modules/@larksuiteoapi/node-sdk` 核对方法名；不得猜 API。分页循环直到 `has_more=false`，只投影规格字段。

- [ ] **Step 4: 运行 GREEN 并提交**

Run: `node --test test/base-client.test.js`
Expected: PASS。

```bash
git add src/base-client.js test/base-client.test.js
git commit -m "feat: add feishu base knowledge adapter"
```

### Task 5: 知识同步与索引恢复

**Files:**
- Create: `src/knowledge-sync.js`
- Test: `test/knowledge-sync.test.js`

**Interfaces:**
- Produces: `createKnowledgeSync({ base, embedder, indexPath, model, threshold, logger }).sync()`，成功返回新内存索引，失败保持调用方旧索引不变。

- [ ] **Step 1: 写 RED 测试**

覆盖：只索引已发布记录；新增/修改后替换旧片段；下线后删除；完整构建失败不覆盖旧文件；损坏索引时能全量重建；空知识生成有效空索引。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/knowledge-sync.test.js`
Expected: FAIL。

- [ ] **Step 3: 最小实现**

流程固定为 `list → chunk → embed all passages → build → save atomic → return`，不在原索引上原地修改。

- [ ] **Step 4: 运行 GREEN 并提交**

Run: `node --test test/knowledge-sync.test.js`
Expected: PASS。

```bash
git add src/knowledge-sync.js test/knowledge-sync.test.js
git commit -m "feat: sync published knowledge"
```

### Task 6: RAG 回答与未知问题策略

**Files:**
- Modify: `src/minimax-client.js`
- Create: `src/rag-service.js`
- Create: `src/unknown-question.js`
- Test: `test/rag-service.test.js`
- Test: `test/unknown-question.test.js`

**Interfaces:**
- `minimax.answerWithKnowledge(question, passages): Promise<string>`。
- `rag.answer(question): Promise<{ text, matched, sources }>`。
- `unknown.record({ question, category, requesterOpenId?, callbackRequested }): Promise<void>`。

- [ ] **Step 1: 写 MiniMax RAG RED 测试**

断言 system prompt 明确“只能依据资料、冲突时指出冲突、不得编造”；请求只含 Top 3 正文与必要元数据；不含提交人、审核人、向量分数。

- [ ] **Step 2: 运行 RED，扩展 MiniMax 客户端，运行 GREEN**

Run: `node --test test/minimax-client.test.js`
Expected: 全部 PASS。

- [ ] **Step 3: 写 RAG RED 测试**

覆盖：命中才调用 MiniMax；未命中返回固定安全文案且不调用 MiniMax；回答追加去重后的标题/更新时间/链接；空索引进入知识收集模式。

- [ ] **Step 4: 实现并运行 GREEN**

Run: `node --test test/rag-service.test.js`
Expected: PASS。

- [ ] **Step 5: 写未知问题 RED 测试**

归一化仅做 trim、空白合并、大小写标准化和明确的常见标点移除；不让 LLM决定业务主键。已有记录累加次数；默认不传 open_id；`callbackRequested=true` 才写回访用户。

- [ ] **Step 6: 实现并运行 GREEN，提交**

Run: `node --test test/unknown-question.test.js`
Expected: PASS。

```bash
git add src/minimax-client.js src/rag-service.js src/unknown-question.js test/minimax-client.test.js test/rag-service.test.js test/unknown-question.test.js
git commit -m "feat: answer from approved knowledge"
```

### Task 7: 接入机器人、定时同步与文档

**Files:**
- Modify: `src/message-handler.js`
- Modify: `src/index.js`
- Modify: `README.md`
- Test: `test/message-handler.test.js`
- Test: `test/startup.test.js`

**Interfaces:**
- 消息处理器使用 `knowledgeAssistant.answer({ text, senderOpenId })` 替代直接 `minimax.answer(prompt)`。
- 启动流程暴露可测试的 `createApplication(dependencies)`，入口只负责真实依赖装配。

- [ ] **Step 1: 写消息处理 RED 测试**

断言现有私聊/群聊/去重行为不变；命中回复含来源；未命中写匿名待补记录；员工回复明确“需要回访”后才记录身份。第一版不增加长期上下文，只把回访请求限定为同一事件内的明确短语，例如“需要回访：<问题>”。

- [ ] **Step 2: 运行 RED，最小改造，运行 GREEN**

Run: `node --test test/message-handler.test.js`
Expected: PASS。

- [ ] **Step 3: 写启动与同步 RED 测试**

断言：启动先加载模型与最后索引，再尝试 Base 同步；Base 失败且存在旧索引时继续启动；没有旧索引且首次同步失败时启动失败；每五分钟调用同步；停止时清理 timer。

- [ ] **Step 4: 实现可测试装配并运行 GREEN**

Run: `node --test test/startup.test.js`
Expected: PASS。

- [ ] **Step 5: 更新 README**

写明 Base 两表字段、机器人应用权限、环境变量、首次模型下载、索引路径、五分钟同步、知识发布/下线流程、未知问题与回访语法。

- [ ] **Step 6: 执行完整质量门**

Run: `npm test && node --check src/index.js && npm audit --omit=dev && git diff --check`
Expected: 0 tests failed，0 vulnerabilities，所有命令 exit 0。

- [ ] **Step 7: 人工验收**

在 Base 创建三条已发布测试知识和一条待审核知识，验证：同义问法命中；回答附来源；待审核不泄露；未知问题匿名合并；“需要回访：问题”才写身份；下线后不再命中；Base 暂时不可用时旧索引继续回答。

- [ ] **Step 8: 提交**

```bash
git add src/index.js src/message-handler.js test/message-handler.test.js test/startup.test.js README.md
git commit -m "feat: run internal knowledge assistant"
```

## Security Gate Before GitHub Backup

当前本地旧 Git 历史曾包含真实飞书与 MiniMax 密钥。实现完成后、任何远程推送前必须：

1. 确认两类密钥均已重置。
2. 将当前干净文件树压缩成不含旧对象的新根提交，或使用可靠历史清理工具。
3. 对所有可达提交执行密钥模式扫描。
4. 确认 `.env`、`.cache/`、`.data/` 未被跟踪。
5. 只有扫描通过后才能创建私有 GitHub 仓库和推送。
