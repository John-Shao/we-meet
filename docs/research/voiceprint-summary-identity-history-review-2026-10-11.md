# 历史纪要身份更新与追溯走查

日期：2026-10-11（Asia/Shanghai）。Web／后端及 Android 分支：`feature/speaker-identity-voiceprint`。Android 提交：`65268900`。

后续人工纪要当前／固定历史版提示、确认后刷新及读取权限／缓存修复已接通，见[人工纪要身份与权限走查](voiceprint-human-summary-identity-review-2026-10-11.md)。下文记录本阶段当时的证据与边界，后续进度以新记录为准。

## 问题与实现

原有 API 的 `is_current` 能把身份更新后的纪要标为历史版本，但 Web／Android 没有说明身份已变更。仅凭 `is_current=false` 不能判断原因：正文修订、版本切换和拒绝识别建议也可能让纪要成为历史版本。

`summary-versions` 新增只读布尔字段 `identity_updated`。它依据当前记录的最终身份决定 revision 与该版本输入 snapshot revision 比较，排除不改变归属的 `reject_suggestion`；同时比较仍对应同一原文片段的当前姓名与冻结姓名，覆盖通讯录成员改名。最终决定的审计信息在当前来源暂不可用时仍能提供提示。分页后重新读取已授权记录，返回时继续检查转写来源、版本及当前 revision；新字段不披露当前姓名、候选、评分或原文。

Web 与 Android 在每个受影响的 AI 纪要／章节版本中展示“身份已更新，可重新生成。此版本保留原有内容。”，共五组本地化。旧服务未返回该字段时保持原有读取行为。提示不触发生成；既有生成入口仍由能力和用户明确操作控制。

历史纪要、原文 snapshot、导出 payload／hash／document receipt 及已确认任务负责人保持原值。明确重新生成时才冻结当前姓名到新纪要输入，旧版本继续可按固定 ID 读取。

## 验证证据

| 范围 | 结果与实际覆盖 |
|---|---|
| 后端 | 67 项组合回归通过，68.01 秒；新增 8 项覆盖标签／通讯录／清除、显式再生成、拒绝建议与正文修订、成员改名、只读摘要访问、来源暂不可用，以及导出／已确认任务不改写；同时回归版本来源、固定 ID、原文投影、独立录音、导出与任务服务 |
| Web | `RecordSummaryPanel` 24 项通过，含新增三种元数据情况（true／false／缺省）的历史内容与固定 snapshot 引用；TypeScript 编译、修改文件 ESLint、Prettier、全部 JSON 与五语言结构检查通过 |
| Android JVM | 新增 2 项 Moshi 契约测试通过，验证旧 API 兼容、明确 true／false 及冻结内容／snapshot ID 不变 |
| Android 制品 | 普通 debug APK 与 AndroidTest APK 构建通过；另构建独立 `.fixturespeakeridentity` 包、`IsolatedRecordsRunner`，测试运行不初始化生产 Application、账户、推送或生产仓库 |
| Android 原生 UI | 隔离 API 29 模拟器 `emulator-5556` 的 2 项测试通过（最终 3.637 秒），覆盖身份提示、无身份变化的历史版本、旧内容与固定原文引用点击；中文、320dp、1.5 倍字号、暗色图已拉取并检查，提示完整换行，保留原文入口 |
| 静态检查 | 后端修改文件 Ruff、新增测试格式及两库 `git diff --check` 通过；五组 Android XML 与 Web 文案逐字一致、Unicode 正确 |

最终截图：`D:/workspace/jusi-meet/work/summary-identity-history-chinese-large-dark-2026-10-11.png`。Android 构建日志及兼容性 XML 在工作目录／测试输出内保留。最初新增文案经 PowerShell 管道写入时 Unicode 损坏，资源链接失败；已改正为 UTF-8 原文、逐字校验并重新构建。后端新增导出用例最初误将服务的两个返回值解包为三个，修正测试后最终 67 项全部通过。重复运行不累加为独立测试数量。

## 边界与后续工作

所有身份／LLM／导出场景使用本地合成或 fixture：文档“ready”回执由测试模拟，未向外部文档服务写入，不能视为生产共享文档验收。Android 为隔离组件测试，未完成生产 Application 的跨页身份编辑到纪要联动或全部真实设备验收。人工纪要编辑／历史视图的提示联动、完整历史分享链路、真实媒体条件、外部恢复墓碑、容量与获授权真人效果仍需继续；本阶段不构成完整功能或生产发布验收。
