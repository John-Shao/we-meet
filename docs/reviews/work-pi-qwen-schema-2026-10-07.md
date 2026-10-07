# Qwen 复核结构稳定性回归（2026-10-07）

本轮为 Pi + `qwen3.8-flash` 只读复核增加 Gateway 固定 JSON Schema。原失败的 `missing_status` 合成样本用完全相同的目标与材料复测一次，结果成功；原五样本 4/5 对照和结构失败记录保持不变。本轮未部署生产、发布镜像或修改密钥配置。

## 实现与边界

[百炼官方说明](https://help.aliyun.com/en/model-studio/qwen-structured-output) 的 JSON Schema 支持列表包含 Qwen3.8-Flash 系列。仅对 `qwen3.8-flash` 与其 `qwen3.8-flash-` 快照名强制 `response_format.type=json_schema`、`strict=true`；其他 Qwen 模型与 DeepSeek 仍使用 JSON Object。

所有对象明确列出必填字段，并设置 `additionalProperties=false`。证据对象只允许 `file`、`sha256`、`quote`，客户端不能覆写 schema。schema 仅约束结构、类型、枚举；原有长度、数量、判定一致性、文件哈希和原文引用校验继续在 runner 与后端独立执行。

模型误写 `fle` 仍被拒绝，不自动改名、删证据或修补报告。供应商拒绝 schema 时保留失败，不降级格式、不自动重试；已发起请求但计量未知时仍保守预留。capabilities 增加格式与 schema SHA-256，便于追溯约束版本。

## 验证

| 范围 | 结果 |
| --- | --- |
| Agent 测试 | 69 项：64 通过、5 项按 opt-in 跳过 |
| 固定 Pi Docker + 模拟供应商 SSE | 单独启用其中 1 项，通过；真实 Pi 1.0.4 收发 schema 请求并交付报告，无供应商网络调用 |
| 原字段拼写错误 | `fle` 继续被校验拒绝，不修补 |
| 供应商拒绝 schema | 一次请求后保留计量未知与预算预留；第二次请求被调用上限阻断，无降级调用 |
| 模型范围与客户端覆盖 | Flash 系列使用固定 schema，其他模型保留原格式，客户端传入 text 无法覆盖 |
| Ruff、diff 检查 | 通过 |

真实回归仅新增一次 Qwen 调用，使用现有百炼凭据，仅注入当前子进程内存。样本快照 SHA-256 与原失败记录一致，镜像改为本轮新构建的固定 image ID。关闭 thinking/search，最多一次调用、预留 20,000 tokens、输出上限 4096 tokens。

模型返回 `needs_changes`，证据分别引用结果中的验收声明、订单 B 的 pending 状态与状态字典。runner 校验、成果哈希校验与后端独立证据校验均通过；输入未变，唯一成果为 `pi-review.json`。

实际用量：输入 801、输出 480、缓存读取 0，总计 **1,281 tokens**；计量完整，任务耗时 9,494 ms，无付费重试。完整结果、镜像身份、schema 哈希与原失败摘要见 [JSON 记录](work-pi-qwen-schema-2026-10-07.json)。

这是一个失败样本的定向回归，不能合并为旧对照的 5/5，也不能推导模型总体可靠性。本轮代码与旧 DeepSeek 基线的镜像不同；完整新对照须让两种模型使用新的相同镜像，并重新验证全部固定样本。原始状态与候选文件仍保存在 Git 忽略的 `.work-acceptance` 中。

生产复核仍关闭。下一阶段为桌面任务执行、用户授权选择成果、Pi 复核与状态/用量展示的完整流程验收。
