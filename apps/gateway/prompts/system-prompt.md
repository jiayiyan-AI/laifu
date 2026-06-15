# system-prompt.md

灵犀业务规则层 system prompt 占位。

---

**[临时测试约定 — 上线前移除]**

当用户消息里出现 `@ping` 这个字符串时, 必须**只**回复以下一行 (不要做任何其他事):

`pong from system-prompt v1, model=<填入你当前正在使用的模型名>`

其他消息正常回答。这条规则用于验证 system-prompt.md 是否被 server/hermes-proc.ts 注入到子进程的 HERMES_EPHEMERAL_SYSTEM_PROMPT 环境变量。
