# 飞书客服与任务助理

这是一个单进程飞书机器人：保留 MiniMax 知识客服能力，并支持对话式任务管理、每天 18:00 任务盘点，以及用户明确授权后的私人聊天摘要与任务草稿。所有面向用户的机器人回复统一使用 Card 2.0。

## 前置条件

- Node.js 20 或更高版本
- 已启用机器人能力的飞书企业自建应用
- 飞书事件订阅使用长连接，并订阅 `im.message.receive_v1`
- 应用已开通接收私聊消息、接收群聊中提及机器人的消息及发送消息权限
- 应用已发布到测试成员可用的版本
- MiniMax API Key
- SiliconFlow API Key（用于 `BAAI/bge-m3` 向量化）
- 已创建并授权给机器人读写的飞书 Base
- Base 任务表和 Members 表；Members 以人员字段 `成员` 的 `open_id` 做唯一匹配
- 机器人发消息、Card 2.0 回调、用户身份消息搜索/读取和 `offline_access` 权限
- 应用可用范围覆盖所有任务负责人和 leaders
- 持续运行且可公开访问的 HTTPS 地址；OAuth redirect URL 必须与后台配置完全一致

## 配置与启动

```bash
npm install
cp .env.example .env
```

在 `.env` 中填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和 `MINIMAX_API_KEY`。不要提交或分享该文件。

同时填写 Base 与 Embedding 配置：

```dotenv
FEISHU_KNOWLEDGE_BASE_TOKEN=知识库BaseToken
FEISHU_TASK_BASE_TOKEN=任务看板BaseToken
FEISHU_KNOWLEDGE_TABLE_ID=知识库表ID
FEISHU_QUESTIONS_TABLE_ID=待补问题表ID
SILICONFLOW_API_KEY=你的SiliconFlow密钥
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_THRESHOLD=0.52
```

```bash
npm test
npm start
```

看到长连接成功日志后，在飞书中进行测试。程序停止后，重新运行 `npm start` 即可再次连接。

任务助理需要配置任务表、成员表和状态文件；启用聊天总结时，才需要用户令牌文件、32 字节 base64 加密密钥、OAuth 回调和端口。完整字段见 `.env.example`。生成密钥可使用：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

如果先关闭聊天总结，设置 `ENABLE_CHAT_SUMMARY=false`。此时不需要填写 `TOKEN_ENCRYPTION_KEY` 和 `OAUTH_REDIRECT_URI`，程序也不会启动公网 HTTP/OAuth 服务或发送聊天授权卡；任务管理、18:00 提醒和 Leader 汇总仍正常运行。

单人本机试点可以不走 OAuth，改用本机 `lark-cli` 用户登录态读取聊天。此模式只允许一个机器人侧 `open_id` 触发，避免其他人总结本机用户的聊天：

```dotenv
ENABLE_CHAT_SUMMARY=true
CHAT_HISTORY_PROVIDER=lark-cli
ALLOWED_CHAT_SUMMARY_OPEN_ID=允许使用者的open_id
```

试点模式需要本机 `lark-cli whoami` 显示 `identity` 为 `user` 且 `available` 为 `true`。用户可私聊机器人发送“总结今天的聊天”，或继续使用明确日期范围：“总结 2026-07-01 到 2026-07-15 的聊天”。

服务必须持续运行，18:00 调度才会执行。开发或人工验收可在测试中注入固定时钟，或调用组装后暴露的 `application.scheduler.runNow(date)`，无需等待真实 18:00。

## 验收

1. 私聊机器人发送“你好”，应收到一条回复。
2. 在群聊中发送普通文本，机器人应保持沉默。
3. 在群聊中 `@机器人` 并提问，应收到针对原消息的回复。
4. 图片、文件、语音和空文本应被忽略。
5. 临时使用无效 MiniMax Key 时，用户只能看到“暂时无法回答，请稍后重试”。
6. 创建、修改或删除任务时先收到确认预览；确认后 Base 只写一次。
7. `runNow()` 后负责人收到可操作卡片，leader 只收到无按钮汇总；同日重跑不重复发送。
8. 每日任务盘点不主动推送聊天摘要授权卡；用户主动请求摘要但未授权时不读取消息，完成 OAuth 后摘要和草稿只私聊本人。
9. 摘要草稿默认负责人是本人，确认草稿后才写入任务表。
10. 私聊机器人发送“总结 2026-07-01 到 2026-07-15 的聊天”，应读取该上海时区闭区间内可访问的文本消息并返回摘要；未授权时先返回 OAuth 链接，授权后重新发送原请求。

## 隐私与令牌运维

- 未明确同意时不调用聊天搜索 API。
- 只在用户主动发送聊天总结请求后，读取该请求明确覆盖范围内可访问的文本消息；图片、文件、音视频和卡片资源不解析。
- 原始聊天正文不写 JSON store、Base 或普通日志；leader 不接收聊天正文或摘要。
- 用户 token 使用 AES-256-GCM 加密后写入 `.data/user-tokens.json`。
- 用户撤销授权后，应停止相应摘要流程；需要本地清除全部缓存令牌时，先停服务，再删除 `.data/user-tokens.json`，重启后用户需重新授权。

## 飞书后台与部署清单

1. 配置 Base 读写、机器人消息、`im.message.receive_v1` 和 `card.action.trigger`。
2. 开通用户身份消息搜索/读取和离线刷新权限，并重新发布应用版本。
3. 配置与 `OAUTH_REDIRECT_URI` 完全相同的公开 HTTPS 回调地址。
4. 确认应用可用范围覆盖负责人及 leaders。
5. 部署为持续运行服务，并持久化 `.data/` 目录。

## 知识库维护

知识存放在飞书 Base 的“知识库”表。员工可以提交候选内容，但机器人只读取状态为“已发布”的条目。每五分钟自动同步一次；重启服务会立即同步。

知识条目应填写标题、分类、适用问题、正文、关键词、来源链接和状态。修改为“已下线”后，下次同步会从索引移除。

未命中知识时，机器人不会编造公司制度，而会匿名写入“待补问题”。员工只有发送以下格式时才会记录回访身份：

```text
需要回访：具体问题
```

向量索引保存在 `.data/knowledge-index.json`，可随时从 Base 重建，不应提交到 Git。

## 常见问题

- 长连接无法建立：确认 App ID、App Secret 正确，且飞书事件订阅已选择长连接。
- 收不到消息：确认已订阅 `im.message.receive_v1`、权限已开通，并重新发布了应用版本。
- MiniMax 调用失败：确认 API Key 有效、账户可调用 `MiniMax-M3`，并检查终端错误日志。

## 当前范围

每条客服消息仍是独立请求。本项目不包含图片或文件理解、自动发布知识、工单、管理后台或云端部署。真实聊天读取只有在飞书后台权限、公开 HTTPS OAuth 回调和应用重新发布完成后才能上线；本地 mock 测试通过不代表生产权限已经生效。
