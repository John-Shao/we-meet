# R0a maxOutputTokens 4096 决策记录

日期：2026-10-31  
范围：R0a 默认模型参数 `maxOutputTokens`，不改 prompt、temperature、outputFormat 或供应商路由。

## 背景

E8 黄金任务的受控执行在 `450d...` 之前持续出现 `provider_unknown`。2026-10-31 给 `work-egress` 增加非敏感失败码日志后，受控任务 `86d90d67…` / Run `94429a5c…` 返回：

```
outcome=unknown code=partial_answer sent=true
```

egress 在 55.2s 完成调用，不是 429/供应商配额；`partial_answer` 表示 provider 的 `finish_reason` 不是 `stop`。E8 G01/G02 要求正文 600–2500 字，而当时默认 `maxOutputTokens=1024`，与目标输出长度不匹配。

## 决策

John 于 2026-10-31 决定：R0a 新任务的默认 `maxOutputTokens` 从 **1024** 提高到 **4096**；`temperatureMilli=0`、`outputFormat=markdown` 不变。

- 代码：`src/work/internal/modelparams/modelparams.go`（提交 `3ee6340ef`）。
- 生效范围：只影响新任务写入的 capability snapshot；既有任务 snapshot 保持原参数。
- 部署：Work API 二进制 sha256 `22058609…` 已安装并 restart。
- 复核：Lily 尚未对本次参数变更给出本人书面复核；本文不写成 Lily 已接受。

## 证据

- 3 个受控 G02 类任务 succeeded：`a2bb5a58…`（12,396B）、`86a0f5e5…`（12,330B）、`82b9f2f5…`（10,271B），Task 均 `awaiting_acceptance`。
- 其中一个 4096 任务 `10e23ed1…` 曾出现一次 `partial_answer`（疑 provider 瞬时），随后 3/3 成功。
- E8 runner 补充 golden 长度指令（提交 `1b3dd2d7e`），受控任务 `3170cb90…` 输出 3,239B，Task `awaiting_acceptance`。
- `work-egress` 进一步区分 `partial_answer_length` / `partial_answer_content_filter`（提交 `1b3ed9177`，二进制 sha256 `92b71943…`）。
- 相关提交的 `Work R0a gates`、`Release guard` 通过；完整 E8 18 次仍未重跑。

## 边界

- 完整 E8 suite 需要真实登录 session；本次浏览器登录态在后续操作中失效（401），未用测试 session 冒充真实登录。
- 本文是参数决策记录，不是 E8 通过或 R0a 全部验收的证据。
