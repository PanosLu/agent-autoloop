# Grok Bot webhook 外置适配

要部署的是这个目录，不是中台本体，也不是 Cursor 编码 CLI。它是内置 `command` 适配器调用的一组零依赖 Node 脚本：向官方 routine webhook 送出请求编号，再在本机结果目录等到 Bot 真正提交。

公开说明见 [Routines](https://cursor.com/help/grok-bot/routines.md)：POST 时带 `Authorization: Bearer <key>`，可以附 JSON 正文；**HTTP 200 只表示已接受并开始运行，不表示指令已经做完**。其他状态表示没有开始。URL 和 key 只能从该 routine 的面板复制。本目录不创建 routine，也不读取任何环境里的密钥。

## 边界

- 正文只有 `{"requestId":"<32位小写十六进制>"}`。提示词、argv 和正文都不能决定动作。
- v1 的可信任务固定为 smoke：把记录里的 `6` 与 `7` 相加。和不是预先写进提示词的。
- Bot 先执行 `show-request.mjs`。只有本机存在、状态为 `accepted`、且动作恰好是 `smoke` 的编号才会返回。
- Bot 再用 `submit-result.mjs` 交回刚算出的和。相同结果再交一次是幂等；不同结果、过期、未知编号、路径穿越和带命令的正文都会拒绝。
- `wait-receipt.mjs` 只有在结果文件与可信任务一致时才向中台打印成功回执。超时、连接失败、非 200、跳转都是非 0 退出，并且第一句是「没跑成」。
- webhook 地址和 Bearer 只放在 `GROK_BOT_HOME/webhook.json`（模式 `0600`）。不进 argv、stdout、stderr 或待办文件。生产地址必须是公网 https 域名，并且解析结果不能是内网地址；不跟随跳转。`loopback: true` 只允许测试用的 `http://127.0.0.1:端口`。
- 脚本只在 `GROK_BOT_HOME` 里建 `spool/`。不要把这个目录指到中台数据库、微信或浏览器配置上。

## 安装

在已经装有 Node 24 的助手电脑上，把本目录放到：

`/home/box/.local/share/agent-autoloop-managed/grok-bot-webhook`

专用数据目录（与上面的程序目录分开）：

`/home/box/.local/share/agent-autoloop-managed/grok-bot-home`

```bash
chmod 700 /home/box/.local/share/agent-autoloop-managed/grok-bot-webhook
chmod 755 /home/box/.local/share/agent-autoloop-managed/grok-bot-webhook/*.mjs
install -d -m 700 /home/box/.local/share/agent-autoloop-managed/grok-bot-home
```

把面板上的 POST URL 和 key 写进数据目录的 `webhook.json`，模式 `0600`。不要把 key 发给别人，也不要写进 shell 历史后留着：

```json
{
  "url": "https://从面板复制的地址",
  "bearer": "从面板复制的 key"
}
```

生产配置不要写 `loopback`。保存 routine 前先在这台电脑执行 `command -v node`，确认它是 Node 24。若 routine 的 shell 找不到这个 `node`，把 [routine-prompt.md](routine-prompt.md) 里的 `node` 换成该绝对路径，再保存。

## 中台规则

`use` 仍是内置 `command`。不要加 `{prompt}`，避免提示词进 argv。`command` 不受 `access` 沙箱约束；限制来自这组脚本本身。

```json
{
  "name": "Grok Bot",
  "worker": "这台电脑在 status 里的名字",
  "use": "command",
  "access": "read",
  "command": ["node", "/home/box/.local/share/agent-autoloop-managed/grok-bot-webhook/wait-receipt.mjs"]
}
```

启动中台的环境里要有数据目录，不能有 Bearer。继续用这份安装原来的启动方式，不要另装一份：

```bash
export AGENT_AUTOLOOP_HOME=/home/box/.local/share/agent-autoloop-managed
export GROK_BOT_HOME=/home/box/.local/share/agent-autoloop-managed/grok-bot-home
agent-autoloop up
```

中台继续只听 `127.0.0.1`。不要改成公网地址，不要登记系统服务，除非另外决定。

## 正式验证

由持有面板凭据的人做一次。会真实触发 Bot，并消耗一次 routine 额度。

1. 确认 routine 没有暂停，webhook 是当前 key。
2. 确认 `webhook.json` 是 `0600`，且本目录没有 `loopback`。
3. 选一个新的轮次编号，执行：

```bash
export GROK_BOT_HOME=/home/box/.local/share/agent-autoloop-managed/grok-bot-home
export AGENT_AUTOLOOP_RUN=1
node /home/box/.local/share/agent-autoloop-managed/grok-bot-webhook/wait-receipt.mjs
```

4. 成功时 stdout 只有一行 `smoke 完成：6+7=13`，退出码 0。Bot 聊天里应能看到同一次运行。200 之后、提交之前，这条命令仍在等待。
5. 同一 `AGENT_AUTOLOOP_RUN` 再执行一次，应直接打印同一行，且不再次 POST。
6. 失败时退出码不是 0，stderr 以「没跑成」开头。不要把网页上的 200 当成做完。

同一轮次超时或 webhook 失败后，中台按自己的节奏重试；重试会登记新编号并再次 POST。过期编号不能再提交。
