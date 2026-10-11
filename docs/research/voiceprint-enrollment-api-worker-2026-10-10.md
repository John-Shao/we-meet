# 声纹登记 API 与独立编码 worker

日期：2026-10-10。分支：`feature/speaker-identity-voiceprint`。接续[登记服务走查](voiceprint-enrollment-code-review-2026-10-10.md)。

已接通本人登记、上传、列表、试听和确认／拒绝 API，独立编码任务可执行。实际固定 Qwen 权重已经通过一次完整链路验证：API 提交合成音频 → 独立 worker 领取任务 → 子进程通过私有 HTTP 调用 Qwen → 写入加密特征 → API 返回 `quality_pending`。这是技术验证，不是声纹实名识别效果证明。

## 私有接口

路径前缀：`/api/v1.0/voiceprint/`。所有接口要求当前有效真人账户的正常鉴权，并返回 `Cache-Control: private, no-store`。不能以上传令牌代替登录，不能代替别人登记，不接收音频 URL、用户身份、特征向量或客户端声称的质量标志。

| 方法与路径 | 输入与结果 |
|---|---|
| `POST enrollments/` | `organization_id`（个人范围为 null）、整数 `expected_version`、UUID `request_key`、`locale`；201 返回登记 ID、六条随机提示、期限、上传令牌及固定音频参数。同请求键、同参数重试保持同一登记 |
| `GET enrollments/{id}/` | 本人登记状态；撤销后返回 canceled 且不提供令牌；上传到期后不提供令牌 |
| `PUT enrollments/{id}/clips/{slot}/` | 原始 `audio/wav`，必须有合法 `Content-Length` 及 `X-Voiceprint-Upload-Token`；202 返回样本状态，并创建独立任务。槽位 0–5；最大 484096 字节、24 kHz、单声道、PCM16，3–10 秒 |
| `GET samples/` | `organization_id`、`offset`；当前范围／generation 的本人样本，每页最多 25 项；返回 `results` 和 `next_offset`。只读取有界元数据，不加载音频或向量密文 |
| `GET samples/{id}/audio/` | 本人且许可仍有效的短期试听，返回 WAV；核对密文、摘要、到期与授权；禁止跨所有者访问 |
| `POST samples/{id}/decision/` | 整数 `expected_version` 和布尔 `accepted`；确认需服务端质量通过，拒绝销毁样本音频／特征并停止任务。决定单向且可幂等重试 |

组织范围同时检查功能开关、有效成员关系、本人授权及发放时的组织许可版本。授权变更、删除或许可版本变化会使旧任务失效；关闭组织功能后再开启也不恢复旧上传许可。本人权限默认关闭。“通过通话完善”本身不能授予建立／确认声纹的权限；确认候选还需本人“建立声纹”授权。

上传只按已验证长度读取有限字节，不调用 multipart/JSON 音频解析器；仍需部署入口设置请求体上限和上传时间限制。音频格式规范化后摘要去重。异常只返回固定码；服务和命令不输出音频、令牌、向量或上游错误文本。

## 独立任务执行

`process_voiceprints --limit 10` 是独立批处理命令，不借用 ASR 队列，limit 为 1–100。

1. 在同一锁顺序中领取任务：用户 → 组织 → 授权 → 档案 → 样本 → 任务。忙碌作用域使用 `skip_locked` 跳过，不等待持有锁的其他 worker。
2. 检查当前授权、样本期限、来源、特征空间和音频摘要；获取随机租约并增加尝试次数。已过期任务和失去授权的任务不调用模型。
3. 在固定模块的短期子进程内执行私有 Qwen RPC。密钥和有界音频通过匿名 stdin 传递；argv 不携带密钥／音频，不落盘，不输出 stderr。
4. 父进程以总期限 35 秒终止并回收编码子进程，包括启动、上传、慢速响应头、正文和阻塞调用。独立定时器保证授权回调暂时卡住时也会终止子进程；正常业务线程和数据库恢复仍由部署数据库超时／任务调度管理。
5. 父进程周期性复核授权与租约。写入前再次锁定并核对 token、期限、generation、授权版本、档案／来源区间／登记许可、音频摘要和密文摘要；旧 lease 结果不能覆盖新 lease。
6. 固定模型元数据、1024 维 L2 向量及信号质量契约再次验证。特征按 little-endian float32 存储并使用档案密钥加密。失败最多尝试三次；可重试任务由下一次批处理领取，终止失败清除候选载荷。

命令输出仅含 `enabled` 和 succeeded/failed/canceled/expired/skipped 聚合计数。功能关闭时不领取任务；配置缺失时在领取前失败。现阶段建议单实例、顺序处理批次，部署调度与容量测试后再调整并发。

当前 Qwen 服务仍使用受保护的原生推理线程；后台 RPC 子进程退出不会终止该服务的原生线程。编码服务内部进程隔离／超时重启及容器监督仍待实现，不能据本轮测试宣称模型服务卡死恢复已完成。

## 私有配置

新增 `MEETING_VOICEPRINT_ENCODER_CONFIG_FILE`，默认空。JSON 文件最多 8192 字节，必须仅有四个字段：

```json
{
  "url": "https://voiceprint.internal",
  "api_token": "REPLACE_WITH_UNIQUE_ASCII_TOKEN_OF_AT_LEAST_32_BYTES",
  "permit_key": "REPLACE_WITH_BASE64_OF_DISTINCT_ASCII_PERMIT_KEY",
  "ca_bundle": true
}
```

以上令牌与密钥为占位文本。使用分别生成的至少 32 字节 ASCII 秘密；`permit_key` 是 Qwen 服务所挂载许可密钥文件内容（去除首尾换行后）的 Base64。两个秘密必须不同。URL 只能由运维配置；非回环地址要求 HTTPS；禁止关闭 TLS 校验、代理和重定向。私有 CA 可将 `ca_bundle` 设置为挂载的 PEM 路径。配置文件与档案 keyring 分开挂载，不提交仓库。

Qwen 模型服务启动配置见[编码器 README](../../src/voiceprint/README.md)。通过项目正常环境启动批次：

```sh
python manage.py process_voiceprints --limit 10
python manage.py expire_voiceprint_samples --limit 100
python manage.py purge_voiceprints --limit 100
```

## 验证与尚待完成的业务

- 287 项相关后端回归通过：包括登记 API 19 项、worker 23 项、子进程 12 项及已有授权、加密、离职、人工身份决策、热词与用户模型回归。
- 加入独立定时器后，最终子进程专项 13 项通过：真实 HTTP/子进程、慢速响应头、超大／畸形响应、未读取 stdin 的卡住子进程、撤销、授权回调暂时阻塞、私有配置与错误契约。
- 补充通话积累与确认权限独立性后，最终登记 API 21 项、登记服务 39 项、worker 23 项，共 83 项通过。
- 固定实际 Qwen 权重的完整登记链路 1 项通过，无跳过。实际服务与测试子进程均在验证结束后回收。
- 共验证 291 个不同用例。Ruff 与格式检查通过，迁移无漂移。本轮不改变 schema。

实际模型复现需已审核的外部权重和独立运行环境：

```powershell
$env:VOICEPRINT_FLOW_PYTHON='D:/workspace/jusi-meet/.worktrees/we-meet-speaker-identity/src/voiceprint/.venv/Scripts/python.exe'
$env:VOICEPRINT_TEST_MODEL_DIR='D:/workspace/jusi-meet/work/voiceprint-research-2026-10-10/encoder-pack-v1'
$env:VOICEPRINT_TEST_ENCODER_SHA256='f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a'
& 'D:/workspace/jusi-meet/we-meet/src/backend/.venv/Scripts/python.exe' `
  'D:/workspace/jusi-meet/work/run-speaker-identity-validation.py' `
  core/tests/test_voiceprint_qwen_flow.py -q
```

这项外部模型集成测试在未配置权重／运行环境时明确跳过；本次执行已提供真实运行环境并通过。

当前编码结果的 `speech_checked` 和 `speaker_consistency_checked` 均为 false，样本只进入 `quality_pending`。客户端不能凭信号质量确认本人声纹，worker 不创建／激活模板，不开启积累／识别权限。后续仍需完成服务端语音／单人质量检查、模板和匹配、通话采样、Web／Android 设置与登记界面，以及部署和获授权真人效果评测。
