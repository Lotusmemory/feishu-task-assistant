# 飞书 MiniMax M3 客服机器人演示

这是一个本地运行的最小演示：私聊飞书机器人或在群聊中 `@机器人`，机器人调用 MiniMax M3 并回复原消息。

## 前置条件

- Node.js 20 或更高版本
- 已启用机器人能力的飞书企业自建应用
- 飞书事件订阅使用长连接，并订阅 `im.message.receive_v1`
- 应用已开通接收私聊消息、接收群聊中提及机器人的消息及发送消息权限
- 应用已发布到测试成员可用的版本
- MiniMax API Key
- SiliconFlow API Key（用于 `BAAI/bge-m3` 向量化）
- 已创建并授权给机器人读写的飞书 Base

## 配置与启动

```bash
npm install
cp .env.example .env
```

在 `.env` 中填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和 `MINIMAX_API_KEY`。不要提交或分享该文件。

同时填写 Base 与 Embedding 配置：

```dotenv
FEISHU_BASE_TOKEN=你的BaseToken
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

## 验收

1. 私聊机器人发送“你好”，应收到一条回复。
2. 在群聊中发送普通文本，机器人应保持沉默。
3. 在群聊中 `@机器人` 并提问，应收到针对原消息的回复。
4. 图片、文件、语音和空文本应被忽略。
5. 临时使用无效 MiniMax Key 时，用户只能看到“暂时无法回答，请稍后重试”。

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

每条消息都是独立请求。本项目不保存长期对话上下文，不包含图片或文件理解、自动发布知识、工单、管理后台或云端部署。
