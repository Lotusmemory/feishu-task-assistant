# 飞书多人私聊聊天总结 MVP 详细实施方案

日期：2026-07-15
适用项目：`feishu-task-assistant`
目标场景：多名员工私聊同一个智能客服，分别总结自己当天有权查看的聊天
文档状态：可执行实施稿

## 0. 结论先行

第一版最合理的实现方式是：

```text
一个统一飞书智能客服
+ 每名员工独立 OAuth 授权
+ 请求者、Token 所属人、聊天读取身份、摘要接收者四方强绑定
+ 仅私聊主动触发“总结今天的聊天”
+ 只处理当天文本消息
+ 有限并发队列与处理中卡片
+ 原始正文不落盘、摘要不外发
```

> “多人共用”只表示共用同一个机器人入口、服务和代码；每个人的授权凭证、可读取消息、摘要结果和任务草稿必须完全隔离。

第一版先服务 5～10 名内部试点用户，不直接全员开放。推荐的 MVP 指令只有：

```text
总结今天的聊天
```

第一版成功的判断标准是：

- 至少 5 名不同用户能分别完成 OAuth 授权并生成自己的当天摘要。
- 请求者、Token 所属人、读取身份和摘要接收者不一致时，100% 拒绝且不调用消息读取 API。
- 群聊触发私人总结时，消息读取 API 调用次数为 0。
- 摘要中不出现 `ou_...`、`cli_...` 等内部 ID。
- 原始聊天正文、OAuth code、access token、refresh token 不进入日志、Base 或其他用户消息。
- 排除用户主动撤销授权后，试点端到端成功率不低于 95%。
- 用户发出请求后 3 秒内收到授权、排队或处理中反馈；95% 的当天摘要在 180 秒内成功或返回明确失败状态。

第一版暂不建议做：

- 不让多人共用服务器上的 `lark-cli` 登录身份。
- 不使用管理员账号或公共员工账号代替员工读取消息。
- 不允许群聊中发起私人聊天总结。
- 不自动定时读取员工聊天。
- 不处理图片、文件、语音、视频和卡片资源。
- 不自动创建任务，任务草稿必须由本人再次确认。
- 不建设管理后台、复杂租户体系、Redis 集群或多实例高可用。

## 1. 背景与现状

当前项目已经具备：

- 飞书机器人私聊消息入口。
- “总结今天的聊天”和明确日期范围的意图解析。
- `lark-cli` 单用户消息搜索、分页读取、文本过滤与排序。
- MiniMax 分块摘要、非空校验、一次重试和中文分节输出。
- 处理中卡片与后台更新。
- 发送者 ID 到姓名的转换和安全兜底。
- OAuth Server、一次性 state、Token Vault、Token 刷新等基础代码。
- `launchd` 单实例托管和全量自动化测试。

当前单用户试点配置使用：

```env
CHAT_HISTORY_PROVIDER=lark-cli
ALLOWED_CHAT_SUMMARY_OPEN_ID=<唯一试点用户>
```

这个模式不能直接开放给多人。原因是所有请求最终都会使用同一台机器上的同一个 `lark-cli` 用户身份读取聊天。即使增加多个允许用户，也只会扩大入口，不会建立权限隔离。

多人版本必须切换为：

```env
CHAT_HISTORY_PROVIDER=oauth
```

并确保每次读取都使用请求者本人授权产生的 `user_access_token`。

## 2. 第一版产品定义

### 2.1 “自己的聊天”如何定义

“自己的聊天”不是“只总结由本人发出的消息”，而是：

> 使用请求者本人的飞书用户身份，读取该账号在当天本来就有权限查看的文本消息集合。

系统不得读取：

- 用户未加入的群聊。
- 用户无权查看的其他员工私聊。
- 已被飞书权限系统拒绝的消息。
- 管理员凭证额外可见、但用户本人不可见的消息。

### 2.2 时间范围

第一版固定使用 `Asia/Shanghai`：

```text
开始：当天 00:00:00 +08:00
结束：当天 23:59:59 +08:00
```

历史日期范围查询可以保留代码能力，但不作为第一版推广入口。这样可以控制消息规模、模型耗时和用户理解成本。

### 2.3 输出结构

输出固定包含：

- 重点信息
- 已确认决策
- 待办事项
- 风险与待确认项
- 相关人员

空栏目不展示。发送者优先显示飞书姓名；无法解析时显示“未知成员”；机器人显示“智能客服”。

### 2.4 用户流程

首次使用：

```text
用户私聊“总结今天的聊天”
  → 服务校验私聊、请求者和试点范围
  → 未发现该用户 Token
  → 回复 OAuth 授权入口
  → 用户在飞书页面确认授权
  → callback 将 Token 加密绑定到该用户 open_id
  → 页面提示授权成功
  → 用户重新发送“总结今天的聊天”
  → 服务读取消息并生成摘要
  → 原卡片更新为最终结果
```

后续使用：

```text
用户私聊“总结今天的聊天”
  → 找到该用户 Token
  → Token 临近过期则自动刷新
  → 读取当天文本消息
  → 生成并仅回复本人
```

第一版不实现“授权成功后自动恢复原请求”。要求用户授权后重新发送一次指令，可以显著减少 pending request、重复回调和进程重启恢复的复杂度。

## 3. 总体架构

```text
飞书员工 A ─┐
飞书员工 B ─┼─ 私聊 ─> 同一个智能客服机器人
飞书员工 C ─┘                    │
                                  ▼
                         Message Handler
                         ├─ 私聊门禁
                         ├─ 试点名单门禁
                         ├─ actorOpenId 提取
                         └─ 单用户任务去重
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
          OAuth 未授权                       OAuth 已授权
          ├─ 创建一次性 state                ├─ Token Vault.get(actor)
          ├─ 跳转飞书授权页                  ├─ 必要时刷新 Token
          └─ callback 加密存 Token           └─ OAuth ChatHistory
                                                    │
                                                    ▼
                                      搜索、分页、mget、文本过滤
                                                    │
                                                    ▼
                                       OAuth Contact Resolver
                                       ├─ open_id → 姓名
                                       ├─ bot → 智能客服
                                       └─ 无权限 → 未知成员
                                                    │
                                                    ▼
                                           Summary Job Queue
                                           ├─ 全局并发上限
                                           ├─ 单用户单任务
                                           └─ 超时与失败释放
                                                    │
                                                    ▼
                                              MiniMax 摘要
                                                    │
                                                    ▼
                                      仅更新请求者本人的结果卡片
```

必须始终成立的身份不变量：

```text
event.sender.open_id
= oauth_state.open_id
= token_vault.owner_open_id
= chat_history.actor_open_id
= summary_job.actor_open_id
= card_recipient.open_id
= task_draft.owner_open_id
```

任意两项不一致，必须停止处理，并且不得调用聊天搜索接口。

## 4. 职责与前置条件

| 事项 | Codex/开发人员可以完成 | 必须由用户或管理员完成 |
| --- | --- | --- |
| Node、OAuth、Token、队列代码 | 可以 | — |
| 自动化测试与本地验证 | 可以 | — |
| Caddy、systemd 配置文件 | 可以生成和部署 | 需要服务器权限 |
| 域名 DNS | 可以给出记录值和验证命令 | 必须拥有域名管理权限 |
| 飞书权限申请 | 可以列出最小 scope 和检查错误 | 必须由飞书应用管理员开通 |
| 飞书回调地址登记 | 可以给出精确 URL | 必须在开发者后台配置 |
| 飞书应用发布 | 可以提供检查单 | 必须由管理员审批并发布 |
| 真实员工授权 | 不能代替员工确认 | 每位试点员工亲自完成 |
| 安全与隐私批准 | 可以提供数据流和风险清单 | 公司安全/合规责任人确认 |

开始实施前必须准备：

1. 一个实际域名，例如 `assistant.example.com`。
2. 一台持续在线、有公网入口的 Linux 服务器。
3. 域名 DNS 管理权限。
4. 服务器部署权限。
5. 飞书企业自建应用管理员权限。
6. 3～5 名首批试点员工名单。

不得在需求文档、聊天、Git 或普通日志中提交 App Secret、Token、OAuth code 和真实加密密钥。

## 5. 实施步骤 1：建立稳定 HTTPS OAuth 入口

### 5.1 目标与完成标志

目标：让飞书浏览器能够通过稳定公网 HTTPS 地址访问当前 Node OAuth Server，同时保证 Node 的 3000 端口不直接暴露公网。

完成标志：

```text
https://assistant.example.com/oauth/start
https://assistant.example.com/oauth/callback
```

均能经过 Caddy 到达 Node；缺少合法 state 时返回固定 400；公网无法直接访问 `服务器IP:3000`。

### 5.2 推荐部署拓扑

建议将整个机器人服务部署到同一台持续在线服务器：

```text
公网用户/飞书
  → assistant.example.com:443
  → Caddy
  → 127.0.0.1:3000 Node OAuth Server
  → 同一 Node 进程中的飞书 WS Client、Token Vault 和摘要服务
```

不建议只把 Caddy 放在云服务器、Node 继续留在个人 Mac，除非已有稳定受控隧道。否则会引入断网、睡眠、动态地址和 Token 状态分裂问题。

### 5.3 DNS 配置

假设：

```text
域名：assistant.example.com
服务器公网 IP：203.0.113.10
```

在 DNS 管理后台增加：

```text
记录类型：A
主机记录：assistant
记录值：203.0.113.10
TTL：默认或 300 秒
```

验证：

```bash
dig +short assistant.example.com
```

预期返回服务器公网 IP。若返回旧 IP，先等待 DNS 生效，不要继续申请证书。

### 5.4 网络与防火墙

只开放：

```text
22/TCP   SSH 管理
80/TCP   证书申请和 HTTP → HTTPS
443/TCP  HTTPS
```

不要开放：

```text
3000/TCP
```

服务器本机验证 Node 可以访问：

```bash
curl -i http://127.0.0.1:3000/oauth/start
```

公网验证 3000 不可访问：

```bash
curl --connect-timeout 5 http://203.0.113.10:3000/oauth/start
```

预期连接失败或超时。

### 5.5 Node 监听地址与安全响应头

修改 `src/oauth-server.js`：

```js
server.listen(port, '127.0.0.1', () => {
  server.off('error', reject);
  resolve(server.address());
});
```

所有 OAuth 响应增加：

```http
Cache-Control: no-store
Pragma: no-cache
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

自动化测试：

- Server 只绑定 loopback。
- `/oauth/start` 缺少 state 返回 400。
- `/oauth/callback` 缺少 state/code 返回 400。
- 响应包含 `Cache-Control: no-store`。
- 错误响应不包含底层 SDK 错误、code 或 Token。

### 5.6 Caddy 配置

以 Caddy 为例：

```caddyfile
assistant.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy 在 DNS 正确、80/443 可达时自动申请和续期证书。

验证配置：

```bash
caddy validate --config /etc/caddy/Caddyfile
```

加载配置：

```bash
sudo systemctl reload caddy
```

不要为 OAuth 路径开启包含完整 URI/query 的访问日志。callback query 中包含一次性 `code` 和 `state`。

### 5.7 Node 服务托管

推荐 systemd：

```ini
[Unit]
Description=Feishu Task Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=feishu-bot
Group=feishu-bot
WorkingDirectory=/opt/feishu-task-assistant
EnvironmentFile=/etc/feishu-task-assistant.env
ExecStart=/usr/local/bin/node src/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

环境文件权限：

```bash
sudo chown root:feishu-bot /etc/feishu-task-assistant.env
sudo chmod 640 /etc/feishu-task-assistant.env
```

数据目录只允许服务账号访问：

```bash
sudo chown -R feishu-bot:feishu-bot /opt/feishu-task-assistant/.data
sudo chmod 700 /opt/feishu-task-assistant/.data
```

### 5.8 外网验收

```bash
curl -i https://assistant.example.com/oauth/start
```

缺少 state 时应返回：

```text
HTTP 400
授权失败：请求已失效，请重新发起授权。
```

这说明 HTTPS、证书、DNS、Caddy 和 Node 路由均已连通。

### 5.9 失败处理与回滚

| 故障 | 排查 | 回滚 |
| --- | --- | --- |
| 证书申请失败 | 检查 DNS、80/443、防火墙 | 暂停 OAuth，不开放 HTTP callback |
| Caddy 502 | 检查 Node 是否监听 127.0.0.1:3000 | 恢复上一服务版本 |
| 域名可访问但 callback 404 | 检查路径和反向代理 | 恢复旧 Caddyfile |
| 3000 暴露公网 | 立即关闭安全组端口并绑定 loopback | 暂停多人授权 |

## 6. 实施步骤 2：配置飞书 OAuth、最小权限与应用发布

### 6.1 目标与完成标志

目标：让每名试点员工通过飞书授权页面，授予应用读取其本人可见消息所需的最小权限。

完成标志：两名不同测试用户分别授权后，服务获得两份绑定不同 `open_id` 的 user token；任一用户未授权时，消息搜索调用次数为 0。

### 6.2 配置 redirect URI

在飞书开发者后台登记：

```text
https://assistant.example.com/oauth/callback
```

以下三处必须完全一致：

1. 飞书后台登记值。
2. 环境变量 `OAUTH_REDIRECT_URI`。
3. OAuth code exchange 时传入的 `redirectUri`。

必须一致的部分包括 `https`、域名、端口、路径和尾部 `/`。

### 6.3 最小权限清单

当前消息读取至少需要：

```text
search:message
im:message:get_as_user
offline_access
```

姓名解析还需要通讯录基础信息的最小只读权限，例如：

```text
contact:contact.base:readonly
```

实施时以飞书后台目标 API 显示的实际权限项为准，不申请管理员级聊天读取权限。

权限必须同时满足两层：

```text
应用管理员在后台开通 scope
+
员工本人通过 OAuth 同意 scope
```

只完成其中一层，user token 都无法调用目标接口。

### 6.4 发布与可用范围

后台操作顺序：

1. 增加 redirect URI。
2. 申请用户身份消息搜索、消息读取、离线刷新和基础姓名权限。
3. 创建应用新版本。
4. 提交管理员审批。
5. 将应用可用范围先设置为 3～5 名试点员工。
6. 发布版本。
7. 用试点账号打开机器人私聊。

第一版不要直接把可用范围设置为全公司。

### 6.5 权限验证

用户完成授权后，真实调用：

- 消息搜索接口。
- 批量消息读取接口。
- 姓名解析接口。
- Token 刷新接口。

记录每个调用的：

```text
requestId、actorHash、API 名、HTTP 状态、飞书错误码、耗时
```

不得记录请求正文、Authorization Header、Token 或返回消息正文。

### 6.6 缺少权限时的行为

| 场景 | 用户提示 | 系统行为 |
| --- | --- | --- |
| 应用后台未开 scope | “当前应用尚未开通聊天读取权限，请联系管理员” | 不重复刷新、不调用模型 |
| 用户未同意 scope | “请重新授权聊天总结权限” | 删除不完整 Token，重新授权 |
| 姓名权限不足 | 摘要继续，姓名显示“未知成员” | 不暴露 open_id |
| offline_access 缺失 | 提示授权过期需重新授权 | 不长期保存不可刷新 Token |

### 6.7 自动化与真实验收

- 缺少任一消息读取 scope 时返回安全提示。
- 姓名 scope 缺失不阻断摘要。
- 无 user token 时搜索 API 调用次数为 0。
- bot token 不能作为 user token 回退。
- 两名员工分别授权成功。
- 用户撤销授权后再次请求，系统停止读取并要求重新授权。

## 7. 实施步骤 3：切换到多用户 OAuth ChatHistory Provider

### 7.1 目标与完成标志

目标：生产环境彻底停止使用公共 `lark-cli` 身份读取私人聊天，每次读取都使用当前请求者自己的 OAuth Token。

完成标志：关闭或卸载服务器上的 `lark-cli` 登录态后，多名已授权用户仍能分别生成摘要；未授权用户不能触发消息搜索。

### 7.2 配置切换

生产配置：

```env
ENABLE_CHAT_SUMMARY=true
CHAT_HISTORY_PROVIDER=oauth
OAUTH_REDIRECT_URI=https://assistant.example.com/oauth/callback
PORT=3000
TOKEN_ENCRYPTION_KEY=<32字节Base64密钥>
USER_TOKEN_PATH=.data/user-tokens.json
```

多人模式下不再依赖：

```env
ALLOWED_CHAT_SUMMARY_OPEN_ID
LARK_CLI_PATH
```

### 7.3 组装逻辑

`src/index.js` 必须明确二选一：

```js
const chatHistory = config.chatHistoryProvider === 'oauth'
  ? createChatHistory({ client: safeUserClient, vault })
  : createLarkCliChatHistory({ command: config.larkCliPath });
```

多人生产环境只允许 `oauth`。禁止以下静默回退：

```text
OAuth 读取失败 → 使用 lark-cli
用户 Token 缺失 → 使用 bot token
用户 Token 失效 → 使用其他用户 Token
```

### 7.4 统一 Provider 契约

两个 Provider 保持同一接口：

```js
listTextMessages(actorOpenId, {
  startIso,
  endIso,
}) => {
  messages: [{
    messageId,
    chatId,
    createTime,
    senderId,
    senderName,
    text,
  }],
  incomplete: boolean,
}
```

摘要层不得知道消息来自 CLI 还是 OAuth。

### 7.5 OAuth 读取过程

1. 使用事件发送者的 `open_id` 调用 `vault.get(actorOpenId)`。
2. Token 不存在时抛出 `UserAuthorizationRequired`。
3. Token 五分钟内过期时先刷新。
4. 使用该 user token 搜索当天消息 ID。
5. 完整处理分页。
6. 每批最多读取 50 个消息详情。
7. 只保留 `text` 消息。
8. 去重并按创建时间排序。
9. 达到分页上限时返回 `incomplete:true`。

### 7.6 数据规模保护

第一版固定一天，并增加：

```text
最大搜索页数：100
单批 mget：50
最大文本消息数：建议 2,000
最大累计正文字符：建议 500,000
模型单分块字符：24,000
```

超过上限时不得截断后假装完整，应返回：

```text
今天的聊天量过大，本次摘要可能不完整。请缩小范围或稍后重试。
```

### 7.7 自动化测试

- 搜索全分页。
- mget 正确分批。
- 图片、文件和卡片被过滤。
- 消息去重和排序正确。
- 达到上限时 `incomplete:true`。
- A 用户请求只调用 A 的 Token。
- Token 缺失时不调用搜索。
- OAuth 失败时不调用 CLI。

### 7.8 真实验收与回滚

真实验收：

1. 用户 A 和 B 分别准备只有自己可见的测试消息。
2. A、B 分别请求摘要。
3. 人工确认 A 结果不含 B 的私有测试消息，B 结果不含 A 的私有测试消息。
4. 删除服务器 CLI 登录态后重试。

回滚：将 `ENABLE_CHAT_SUMMARY=false`，只关闭总结功能，不影响客服、任务和提醒；不得回滚到多人共用 CLI。

## 8. 实施步骤 4：完善逐用户 OAuth Token 生命周期

### 8.1 目标与完成标志

目标：Token 创建、加密、读取、刷新、撤销和删除都按用户隔离，且服务重启后仍可安全恢复。

完成标志：两名用户的 Token 分别加密保存；交换记录位置也无法解密；撤销任一用户不会影响其他用户。

### 8.2 state 生命周期

创建 state 时保存：

```json
{
  "state随机值": {
    "openId": "ou_xxx",
    "createdAt": 1784090000000
  }
}
```

约束：

- 使用至少 32 字节安全随机数。
- state 有效期 10 分钟。
- state 绑定发起授权的 `open_id`。
- callback 处理时先原子删除 state，再交换 code。
- state 过期、缺失、重复使用全部返回固定 400。

### 8.3 Token 加密存储

当前 Token Vault 使用 AES-256-GCM，并以 `open_id` 作为 AAD。保留这一设计：

```json
{
  "users": {
    "ou_xxx": {
      "iv": "base64",
      "ciphertext": "base64",
      "tag": "base64",
      "expiresAt": 1784090000000
    }
  }
}
```

文件中不得出现：

```text
accessToken
refreshToken
聊天正文
OAuth code
```

### 8.4 密钥管理

生成密钥：

```bash
openssl rand -base64 32
```

要求：

- 密钥不进入 Git。
- 密钥不写进 `.env.example` 的真实值。
- 密钥与 Token 文件分开保存。
- 环境文件权限不高于 `640`。
- 轮换密钥前必须先设计 Token 重新加密或要求全部用户重新授权。

试点阶段可以使用加密 JSON；进入多实例或全员阶段后迁移到数据库和云密钥服务。

### 8.5 Token 刷新

读取前：

```text
expiresAt - now <= 5 分钟
  → 使用 refreshToken 刷新
  → 用返回的新 accessToken 和 refreshToken 覆盖旧记录
```

刷新失败：

1. 删除该用户本地 Token。
2. 不读取聊天。
3. 不调用 MiniMax。
4. 提示用户重新授权。
5. 不影响其他用户。

### 8.6 撤销与删除

需要提供受控运维命令，例如：

```bash
npm run token:delete -- --open-id ou_xxx
```

命令要求：

- 只删除指定用户。
- 输出只显示脱敏用户标识。
- 删除前打印目标并要求确认，或仅供受控管理员运行。
- 不支持“模糊匹配后删除第一条”。

用户在飞书授权管理页撤销服务端授权后，下次刷新失败时自动清理本地记录。

### 8.7 自动化测试

- 正确密钥可解密。
- 错误密钥、篡改密文、交换用户记录都失败。
- state 十分钟边界正确。
- state 只能消费一次。
- A 的 state 不能写入 B 的 Token 位置。
- 刷新成功覆盖新 Token。
- 刷新失败只删除当前用户。
- Token、code 和 App Secret 不出现在错误日志。

### 8.8 备份与恢复

备份只包含加密 Token 文件，且备份存储必须与密钥分离。恢复演练：

1. 停止服务。
2. 恢复加密 Token 文件。
3. 使用原密钥启动。
4. 验证试点用户无需重新授权。
5. 验证错误密钥启动时明确失败，不覆盖原文件。

## 9. 实施步骤 5：强制端到端身份隔离

### 9.1 目标与完成标志

目标：消除所有“代表其他用户总结”的可能性。

完成标志：跨用户攻击测试 100% 被拒绝，且拒绝发生在消息搜索之前。

### 9.2 唯一可信身份来源

唯一可信身份来自飞书消息事件：

```js
const actorOpenId = event.sender.sender_id.open_id;
```

不得信任：

- 用户文本中的姓名或 ID。
- 卡片表单中提交的目标用户。
- URL query 中任意 `open_id`。
- 客户端自行传入的摘要接收人。

### 9.3 私聊门禁

总结请求必须同时满足：

```text
sender_type == user
message_type == text
chat_type == p2p
prompt 命中聊天总结意图
```

群聊即使 `@机器人` 也返回：

```text
私人聊天总结只能在与智能客服的私聊中发起。
```

且不能调用 Token Vault、消息搜索或模型。

### 9.4 身份绑定链路

代码调用必须保持：

```js
const token = await vault.get(actorOpenId);
const messages = await history.listTextMessages(actorOpenId, window);
const result = await summary.summarize(messages, actorOpenId);
await messenger.updateCard(cardMessageId, resultCard);
```

卡片消息 ID 必须来自该请求首次回复的结果，不能由用户提交。

### 9.5 任务草稿隔离

如果摘要生成任务草稿：

- 默认负责人固定为 `actorOpenId`。
- 确认记录绑定 `actorOpenId`。
- 只有同一用户点击才能确认。
- Leader、管理员和其他群成员不能看到私人摘要草稿。

### 9.6 攻击测试矩阵

| 测试 | 预期 |
| --- | --- |
| A 使用 B 的 state | 失败，不写 Token |
| A 重放已消费 state | 失败 |
| A 请求中写“总结 B 的聊天” | 不读取 B，只能总结 A 或拒绝 |
| A 构造 B 的 open_id 表单 | 忽略或拒绝 |
| A 点击 B 的任务草稿确认 | 拒绝 |
| 群聊请求私人总结 | 读取调用数 0 |
| 管理员请求员工摘要 | 不提供代查能力 |
| Token 文件中 A/B 密文交换 | GCM/AAD 校验失败 |
| A 任务失败 | B 的任务继续运行 |

### 9.7 审计要求

拒绝事件可以记录：

```json
{
  "event": "summary_access_denied",
  "actorHash": "sha256:...",
  "reason": "group_chat_not_allowed",
  "requestId": "summary_xxx"
}
```

不得记录完整 `open_id`、用户文本或消息正文。

## 10. 实施步骤 6：OAuth 模式姓名解析与 ID 隐藏

### 10.1 目标与完成标志

目标：多人 OAuth 模式输出飞书姓名，不把内部 ID 发送给 MiniMax 或展示给用户。

完成标志：真实摘要输入和输出中 `ou_`、`cli_` 出现次数均为 0。

### 10.2 Resolver 接口

新增或抽象：

```js
resolveSenderNames(actorOpenId, senderOpenIds) => Map<openId, displayName>
```

调用规则：

1. 从当天消息收集唯一 `senderId`。
2. 过滤格式合法的 `ou_...`。
3. 每批最多 30 或按目标 API 上限查询。
4. 使用被批准的用户态或应用态最小通讯录权限。
5. 建立本次请求内的姓名 Map。

### 10.3 展示规则

```text
解析成功           → 飞书 localized_name
sender_type == app → 智能客服
cli_...            → 智能客服
跨租户不可见       → 未知成员
离职/删除/无权限    → 未知成员
返回值仍等于 ou_id → 未知成员
```

任何情况下都不得用原始 ID 作为展示名回退。

### 10.4 缓存策略

第一版只做：

- 单次请求内去重。
- 可选进程内 24 小时缓存。
- 缓存键包含租户和用户可见性边界。

第一版不把全公司通讯录持久化到本地。

### 10.5 发送模型前的最后检查

摘要输入拼装后执行安全校验：

```js
if (/\b(?:ou_|cli_)[a-zA-Z0-9_]+/.test(prompt)) {
  throw new Error('Unsafe sender id in summary input');
}
```

这里应 fail-closed，而不是继续调用模型。

### 10.6 失败处理

姓名查询失败不能阻断摘要，但必须：

- 使用“未知成员”。
- 记录 `contact_resolution_failed`，不记录原始 ID。
- 不将权限错误全文回复用户。
- 不回退使用公共 CLI 通讯录。

### 10.7 自动化和真实验收

- 解析成功显示姓名。
- bot 显示“智能客服”。
- 未解析用户显示“未知成员”。
- 跨租户空字段不会泄露 ID。
- 通讯录 API 失败仍能生成摘要。
- 发送给 MiniMax 的 prompt 不包含 `ou_`/`cli_`。
- 真实两名员工摘要均通过人工检查。

## 11. 实施步骤 7：多人并发队列、去重与超时

### 11.1 目标与完成标志

目标：避免多人同时请求导致 MiniMax、飞书 API 和本机资源被耗尽，同时保证卡片与结果不串用户。

完成标志：10 名试点用户同时请求时，系统能排队、限流并分别更新正确卡片；单个失败不影响其他任务。

### 11.2 第一版队列边界

第一版采用进程内队列：

```text
全局同时执行摘要：2～3 个
同一用户同时执行：1 个
单任务总超时：180 秒
MiniMax 单请求超时：120 秒
队列最大等待任务：20 个
```

第一版单实例部署，因此不需要 Redis。进入多实例后必须迁移到共享队列。

### 11.3 Job 数据结构

```js
{
  jobId: 'summary_xxx',
  actorOpenId,
  sourceMessageId,
  cardMessageId,
  dateKey: '2026-07-15',
  status: 'queued|running|succeeded|failed',
  createdAt,
  startedAt,
  finishedAt,
}
```

不得存储消息正文或摘要全文。

### 11.4 请求流程

1. 收到私聊指令。
2. 检查该用户是否已有 `queued/running` Job。
3. 有则回复“你已有一个聊天总结正在生成”。
4. 无则创建 Job。
5. 立即回复授权、排队或处理中卡片。
6. 队列取得并发名额后开始读取。
7. 完成后只更新该 Job 保存的 `cardMessageId`。
8. 无论成功失败都释放并发名额。

### 11.5 卡片状态

排队：

```text
聊天总结排队中
当前前面还有 2 个请求，请稍候。
```

处理中：

```text
正在读取并总结今天的聊天，请稍候。
```

成功：中文分节摘要。

失败：

```text
本次聊天总结失败，没有保存聊天正文。请稍后重试。
```

不得把堆栈、模型响应或 Token 错误显示给用户。

### 11.6 模型可靠性

保留现有行为：

- 非空聊天返回全空摘要时重试一次。
- 第二次仍为空则失败，不展示伪成功。
- 长内容分块后合并。
- 固定字段清洗。

重试只允许一次，避免模型故障时形成无限重试风暴。

### 11.7 进程重启语义

进程内队列在重启后丢失。第一版可接受，但必须：

- 已提交 Token 和 state 使用持久化存储。
- 卡片不会被错误更新为其他用户结果。
- 用户可重新发送指令恢复。
- 运维重启前尽量等待正在运行任务结束。

第二版再引入持久化队列和任务恢复。

### 11.8 自动化压力与隔离测试

- 10 个用户同时请求，最大运行数不超过配置。
- 同一用户重复请求只创建一个 Job。
- 每个 Job 更新自己的 cardMessageId。
- A 超时后 B/C 继续执行。
- 队列满时返回可操作提示。
- 失败后用户可以重试。
- timeout、reject、进程 stop 都释放并发槽位。

## 12. 实施步骤 8：隐私日志、监控与告警

### 12.1 目标与完成标志

目标：能定位 OAuth、飞书读取、通讯录、MiniMax、卡片更新哪个阶段失败，同时不保存聊天内容和凭证。

完成标志：100% 请求有无正文的状态记录；对日志做静态扫描和抽样检查，敏感信息命中为 0。

### 12.2 允许记录的字段

```json
{
  "event": "chat_summary_completed",
  "requestId": "summary_xxx",
  "actorHash": "sha256:...",
  "dateKey": "2026-07-15",
  "messageCount": 72,
  "inputChars": 11385,
  "durationMs": 79087,
  "provider": "oauth",
  "status": "succeeded",
  "incomplete": false,
  "errorType": null
}
```

### 12.3 禁止记录的字段

- 聊天正文。
- 最终摘要全文。
- 姓名列表和完整 open_id。
- access token、refresh token、OAuth code。
- Authorization Header。
- 完整 OAuth URL 和 callback query。
- MiniMax 完整 prompt 与原始输出。

### 12.4 错误分类

统一成有限错误码：

```text
authorization_required
oauth_state_invalid
oauth_exchange_failed
token_refresh_failed
message_search_failed
message_read_failed
contact_resolution_failed
summary_timeout
summary_empty
card_update_failed
queue_full
```

日志只记录错误码和脱敏 requestId，不直接打印不受控 SDK response。

### 12.5 指标与告警

至少统计：

- OAuth 成功率。
- Token 刷新失败率。
- 消息读取成功率。
- 摘要成功率。
- P50/P95 完成耗时。
- MiniMax 超时率。
- 卡片更新失败率。
- 当前队列长度。
- `incomplete:true` 比例。

建议告警：

```text
10 分钟内摘要失败率 > 20%
连续 5 次 Token 刷新失败
队列长度持续 > 10
P95 > 180 秒
出现任何 cross_user_access_denied 异常增长
日志扫描命中 token/code/message content
```

### 12.6 日志轮转与权限

- 日志文件仅服务账号和运维管理员可读。
- 配置大小和时间轮转。
- 试点阶段保留 14～30 天。
- OAuth callback 反向代理日志不得包含 query。
- 删除日志不影响 Token Vault 和任务功能。

### 12.7 验收

1. 分别模拟 OAuth、飞书、MiniMax 和卡片失败。
2. 确认每类错误可以区分。
3. 用已知测试正文和假 Token 做静态扫描。
4. 确认日志中敏感字符串出现次数为 0。
5. 非开发人员根据 requestId 能定位失败阶段。

## 13. 实施步骤 9：灰度名单、产品提示与用户支持

### 13.1 目标与完成标志

目标：在权限和稳定性尚未充分验证时控制使用范围，并让用户知道系统读取什么、不读取什么、如何撤销。

完成标志：只有试点名单内用户能进入 OAuth；名单外请求不会创建 state、读取聊天或调用模型。

### 13.2 灰度配置

第一版新增可选名单：

```env
CHAT_SUMMARY_ALLOWED_OPEN_IDS=ou_a,ou_b,ou_c
```

规则：

- 配置存在时，只允许名单用户。
- 配置为空时不要自动解释为全员，除非明确设置 `CHAT_SUMMARY_ROLLOUT_MODE=all`。
- 名单校验在创建 OAuth state 之前。

### 13.3 用户提示

名单外：

```text
聊天总结目前处于小范围试用，暂未对你的账号开放。
```

未授权：

```text
聊天总结只会读取你本人有权查看的当天文本消息，结果仅回复给你本人。点击授权后，请重新发送“总结今天的聊天”。
```

无消息：

```text
今天没有找到可总结的文本消息。
```

读取不完整：

```text
由于消息量或分页限制，本次摘要可能不完整。
```

### 13.4 隐私说明

授权卡片或说明页必须明确：

- 用户主动请求时才读取。
- 只读取用户本人有权查看的消息。
- 第一版只处理文本。
- 原始聊天不写入 Base 和普通日志。
- 摘要只回复本人。
- 用户可以在飞书授权管理中撤销授权。

### 13.5 灰度阶段

| 阶段 | 人数 | 时间 | 放大条件 |
| --- | ---: | ---: | --- |
| 阶段 0 | 2 名开发/产品用户 | 2～3 天 | OAuth、隔离、日志检查通过 |
| 阶段 1 | 5 名跨职能员工 | 1 周 | 成功率 ≥ 90%，无高严重度安全问题 |
| 阶段 2 | 10～20 名员工 | 2 周 | 成功率 ≥ 95%，可用率 ≥ 70% |
| 阶段 3 | 单个部门 | 2～4 周 | 安全复核、容量和运维通过 |
| 阶段 4 | 全员 | 后续决定 | 完成正式数据与合规评审 |

### 13.6 立即停止条件

出现任一情况，立即设置：

```env
ENABLE_CHAT_SUMMARY=false
```

停止条件：

- 发现跨用户摘要或 Token 串用。
- 原始正文进入日志、Base 或其他用户消息。
- 公共账号/CLI 被用于替多人读取。
- OAuth code 或 Token 泄露。
- 一周成功率低于 80%。
- 摘要持续把未确认建议误写为已确认决策。

关闭总结功能不得影响客服问答、任务管理和每日提醒。

## 14. 实施步骤 10：运维、发布、回滚与交接

### 14.1 目标与完成标志

目标：非原开发人员也能按文档完成启动、关闭、重启、清理单个 Token、回滚和故障定位。

完成标志：由非开发人员完成一次演练，并在 15 分钟内关闭或回滚聊天总结。

### 14.2 发布前检查

```text
[ ] 全量 npm test 通过
[ ] node --check 关键入口通过
[ ] OAuth state 防重放测试通过
[ ] 跨用户隔离测试通过
[ ] prompt 无 ou_/cli_ 测试通过
[ ] 凭证与正文静态扫描通过
[ ] Caddy 配置验证通过
[ ] 3000 端口不对公网开放
[ ] DNS 与证书有效
[ ] 飞书 scope 和 redirect URI 已发布
[ ] 试点名单正确
[ ] 加密密钥与 Token 备份分离
```

### 14.3 发布步骤

1. 备份当前代码版本和加密数据文件。
2. 部署新代码到临时版本目录。
3. 安装生产依赖。
4. 运行全量测试和配置检查。
5. 原子切换当前版本软链接或部署目录。
6. 重启 systemd 服务。
7. 检查 Node、Caddy 和飞书 WS 日志。
8. 用两名测试用户执行授权与摘要。
9. 观察至少 30 分钟再扩大名单。

### 14.4 回滚步骤

1. 先设置 `ENABLE_CHAT_SUMMARY=false` 并重启，快速阻断私人读取。
2. 客服和任务功能应继续运行。
3. 必要时切回上一代码版本。
4. 不删除 Token 文件，除非确认泄露或密钥错误。
5. 如果发生凭证泄露，立即删除 Token、轮换密钥并要求用户在飞书撤销授权。

### 14.5 日常运维

- 每日查看摘要成功率和 P95。
- 每周抽查日志是否存在正文或凭证。
- 每周检查 Caddy 证书和服务状态。
- 每月演练单用户 Token 清理。
- 应用权限变化后重新审查最小权限。
- 员工离职或撤销授权后清理对应 Token。

### 14.6 交接内容

交接文档至少包含：

- 域名、部署拓扑和服务名。
- 飞书应用负责人和安全联系人。
- 不含秘密的环境变量清单。
- Token、state、日志和索引文件位置。
- 启动、停止、重启、回滚命令。
- 常见错误码及处理方式。
- 关闭聊天总结但保留其他功能的方法。

## 15. 数据对象与配置清单

### 15.1 主要配置

```env
ENABLE_CHAT_SUMMARY=true
CHAT_HISTORY_PROVIDER=oauth
OAUTH_REDIRECT_URI=https://assistant.example.com/oauth/callback
PORT=3000
TOKEN_ENCRYPTION_KEY=<secret>
USER_TOKEN_PATH=.data/user-tokens.json
CHAT_SUMMARY_ALLOWED_OPEN_IDS=ou_a,ou_b,ou_c
CHAT_SUMMARY_MAX_CONCURRENCY=2
CHAT_SUMMARY_QUEUE_LIMIT=20
CHAT_SUMMARY_TIMEOUT_MS=180000
```

第一版只新增确有使用场景的配置；如果并发和队列参数不会由运维调整，也可以先保留为代码常量，避免过度配置化。

### 15.2 OAuth state

```js
{
  openId,
  createdAt,
}
```

### 15.3 加密 Token record

```js
{
  iv,
  ciphertext,
  tag,
  expiresAt,
}
```

### 15.4 Summary Job

```js
{
  jobId,
  actorOpenId,
  sourceMessageId,
  cardMessageId,
  dateKey,
  status,
  createdAt,
  startedAt,
  finishedAt,
}
```

Job 不持久化消息正文和摘要全文。

### 15.5 Audit Event

```js
{
  requestId,
  actorHash,
  stage,
  status,
  messageCount,
  durationMs,
  errorType,
}
```

## 16. 失败与异常处理矩阵

| 阶段 | 失败 | 用户看到 | 系统动作 | 是否可重试 |
| --- | --- | --- | --- | --- |
| 灰度门禁 | 用户不在名单 | 暂未开放 | 不创建 state | 管理员开放后可重试 |
| OAuth | state 无效/过期 | 授权请求已失效 | 不交换 code | 重新发起 |
| OAuth | code 交换失败 | 授权失败 | 不保存 Token | 重新授权 |
| Token | Token 不存在 | 请先授权 | 不搜索消息 | 授权后重试 |
| Token | 刷新失败 | 授权已失效 | 删除当前用户 Token | 重新授权 |
| 消息搜索 | 权限不足 | 联系管理员或重新授权 | 不调用模型 | 权限修复后重试 |
| 消息搜索 | 达到分页上限 | 摘要可能不完整 | 标记 incomplete | 可缩小范围 |
| 姓名解析 | 通讯录失败 | 摘要正常，显示未知成员 | 不暴露 ID | 不必重试 |
| 队列 | 同用户已有任务 | 已在生成 | 不创建重复任务 | 等待完成 |
| 队列 | 队列已满 | 当前请求较多 | 不读取聊天 | 稍后重试 |
| MiniMax | 超时 | 总结失败 | 不保存正文，释放槽位 | 可以重试 |
| MiniMax | 全空结果 | 后台自动重试一次 | 第二次仍空则失败 | 可以重试 |
| 卡片 | 更新失败 | 原卡片可能停留处理中 | 记录 requestId | 可重新请求 |
| 进程 | 重启 | 当前任务中断 | Token 不丢，Job 可重发 | 可以重试 |

## 17. 第一版验收标准

| 类别 | 验收项 | 明确标准 | 验证方式 |
| --- | --- | --- | --- |
| 多用户 | 独立授权 | 至少 5 名用户分别授权成功 | 真实账号测试 |
| 多用户 | 独立摘要 | 5 名用户均收到自己的当天摘要 | 人工对照测试消息 |
| 身份隔离 | 跨用户访问 | 攻击测试 100% 拒绝 | 自动化负面测试 |
| 私聊门禁 | 群聊请求 | 消息读取调用数为 0 | 自动化与真实群聊测试 |
| OAuth | state | 十分钟过期、一次消费、绑定用户 | 边界与重放测试 |
| Token | 加密 | 文件无明文 Token，交换记录无法解密 | 文件扫描与篡改测试 |
| Token | 刷新/撤销 | 自动刷新；撤销后停止读取 | 缩短有效期和真实撤销测试 |
| 权限 | 飞书权限继承 | 用户无权消息无法被读取 | 隔离会话测试 |
| 数据范围 | 当天范围 | 只包含上海时区当天文本 | 边界时间测试 |
| 姓名 | ID 隐藏 | prompt 和结果中 `ou_`/`cli_` 为 0 | 静态断言与真实结果检查 |
| 隐私 | 原文保护 | 日志、Base、Job Store 中正文为 0 | 静态扫描与抽查 |
| 首次反馈 | 卡片反馈 | 3 秒内出现授权/排队/处理中 | 端到端计时 |
| 性能 | 完成时间 | 95% 当天摘要 ≤ 180 秒或明确失败 | 试点统计 |
| 稳定性 | 成功率 | 排除主动撤销后 ≥ 95% | 两周统计 |
| 质量 | 事实准确率 | 抽样事实正确率 ≥ 95% | 人工标注 |
| 质量 | 可用率 | ≥ 70% 仅需轻微编辑 | 用户反馈 |
| 并发 | 10 人同时请求 | 不串卡片、不串结果、不超过并发上限 | 压力测试 |
| 故障隔离 | 单用户失败 | 不影响其他用户 | 并发故障注入 |
| 运维 | 关闭/回滚 | 15 分钟内完成且不影响其他功能 | 运维演练 |
| 回归 | 自动化测试 | 全量测试通过 | CI/本地测试 |

## 18. 第二版方向

只有第一版达到验收标准后再考虑：

- 授权成功后自动恢复原摘要请求。
- 历史日期范围和自定义会话筛选。
- 多实例部署、Redis/持久化任务队列。
- Token 数据库和云 KMS。
- 图片 OCR、文件、语音转写和卡片解析。
- 任务草稿批量确认。
- 用户自行查看和撤销授权状态。
- 管理员只看运行指标、不看员工摘要的运营后台。

## 19. 最小实现批次

### 批次 1：稳定 HTTPS 与双用户 OAuth 闭环

范围：

- Node 只监听 `127.0.0.1`。
- 部署 Caddy、域名和 HTTPS。
- 配置飞书 redirect URI 与最小 scope。
- 切换 `CHAT_HISTORY_PROVIDER=oauth`。
- 两名用户分别授权并加密保存 Token。

不包含：姓名优化、多人队列、完整监控。

验收：

- 公网 3000 不可访问。
- 两名用户 Token 分别绑定不同 `open_id`。
- Token 文件无明文凭证。
- 用户 A/B 都能读取自己的测试消息。

### 批次 2：身份隔离与 CLI 回退删除

范围：

- 私聊门禁。
- 请求者、state、Token、读取身份和接收者强绑定。
- 禁止 OAuth → CLI/bot token 回退。
- 跨用户负面测试。

验收：

- 跨用户测试 100% 拒绝。
- 群聊读取调用次数为 0。
- 删除服务器 CLI 登录态后 OAuth 摘要仍成功。

### 批次 3：姓名解析与可用摘要

范围：

- OAuth 模式批量姓名解析。
- bot/未知成员安全兜底。
- prompt ID 安全检查。
- 复用现有分块、非空重试和中文分节格式。

验收：

- 真实摘要中 `ou_`/`cli_` 为 0。
- 通讯录权限失败时仍能总结且不泄露 ID。
- 两名用户人工确认摘要内容来自各自可见聊天。

### 批次 4：有限并发、排队与故障隔离

范围：

- 全局并发 2～3。
- 同一用户单任务。
- 排队/处理中/失败卡片。
- 180 秒任务超时和槽位释放。

验收：

- 10 人并发不串结果。
- A 超时不影响 B/C。
- 重复请求不创建重复模型调用。

### 批次 5：隐私日志、灰度与正式 MVP 验收

范围：

- 无正文结构化审计。
- 指标与告警。
- 5～10 人灰度两周。
- 运维、撤销、回滚和安全演练。

验收：

- 端到端成功率 ≥ 95%。
- 摘要事实准确率 ≥ 95%。
- 摘要可用率 ≥ 70%。
- 日志敏感信息扫描命中为 0。
- 15 分钟内能关闭或回滚聊天总结，客服和任务功能不受影响。
