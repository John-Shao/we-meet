# 会议 AI 最终技术评审与代码走查

日期：2026-09-13。范围：阶段 0–3 首版开发及阶段 4 开发侧检查，累计批次 136–139。评审方式：代码走查、隔离数据库/协议测试、Web 全量回归、Android JVM 与已有设备测试、部署模板渲染；未执行生产部署或真实业务音频验收。

结论：本轮发现的阻塞开发缺陷已修复并推送，当前未发现尚未处理的阻塞开发问题，可以交接用户部署测试。**这不是生产发布批准，也不表示 M3/M4 已验收通过。** 真实模型质量、端设备与环境验证仍是阶段 4 的退出条件。部署版本、顺序、开关、边界与反馈格式见[部署交接](meeting-ai-deployment-handoff-2026-09-13.md)。

## 1. 发现与修复

| 问题 | 影响与处理 | 证据 |
| --- | --- | --- |
| 切换账号时旧请求可能使用新账号重试，迟到刷新结果可能覆盖新登录 | Web/Android 为请求绑定登录会话；刷新只更新准确的原凭据；旧响应不能清除新会话。Web 仅身份发现允许 Cookie 回退，业务请求与 SSE 不切换主体重试 | 批次 136，Meet `bcccac96`，Android `76c97d32`；13 项 Web 定向测试、6 项原生鉴权测试 |
| 不确定 HTTP 结果清除了待处理请求；空成功响应可能被误认已完成 | 保留 401/403/404/408/429/5xx 等不确定状态的原请求；只有明确校验/冲突结果释放。成功写接口回传 key 与 source scope，Web 严格核验后完成恢复 | 批次 137，`5f46b81e`；111 项后端及 104 项 Web 定向回归 |
| 私人翻译页面重开丢失待确认请求，恢复可能改变播放状态 | 按账号/房间场次保存原操作元数据；手动重提复用同一 key/body，页面重开不发请求、不自动启声；8 秒取消与卸载取消，迟到结果不擦除恢复标记 | 批次 138，`9cd6d38e`；包含卸载后迟到成功、重开后精确重提和静音断言 |
| 导出/分享/通知/同传把损坏恢复记录当作没有待处理操作 | 区分不存在和不可读取；损坏时暂停相关操作，保留标记，不生成替代请求 | 批次 138；64 项定向组件场景，包括非法 JSON、非法结构和空值 |
| 交接文档首页仍停留在早期批次，迁移号和待实现项过时 | 重写当前交接、核实迁移 0178/5 类 Worker/原生构建开关；旧记录移入历史文档，更新总计划状态 | 批次 139，本文件及部署交接 |

实现位置：Web [鉴权与回执](../../src/frontend/src/api/fetchApi.ts)、[SSE](../../src/frontend/src/api/sseStream.ts)、[登录快照](../../src/frontend/src/features/auth/utils/tokenStorage.ts)、[私人翻译生命周期](../../src/frontend/src/features/meetings/components/PrivateTranslationProvider.tsx)、[恢复标记](../../src/frontend/src/features/meetings/hooks/readRecovery.ts)；后端[回执封装](../../src/backend/core/api/meeting_command_receipt.py)。原生鉴权见 Android 仓库 `data/auth/TokenStore.kt`、`AuthInterceptor.kt`、`TokenRefreshAuthenticator.kt`。回执只证明已接受的准确请求，不替代业务层的权限、内容一致性和单次执行检查。

## 2. 架构与边界走查

- **来源与权限**：在线资料绑定实际 meeting session 和 LiveKit SID，独立录音绑定 record/capture；列表、原文、纪要、媒体、问答和译文读取分别鉴权。参与记录与说话人标签不自动等于原文/音频权限。分享只授予所声明的纪要范围，独立文档沿用 Docs 权限。
- **保存与恢复**：分片哈希/序号回执、缺片清单、已确认原文与音频覆盖分开表达；仅文字模式有实际存储清理协议。云录制使用准确来源/输出证据和 Worker 租约，不确定启动结果按原记录查询，不自动发第二次启动。
- **AI 版本**：总结使用冻结原文和模型配置，分阶段水位与长会分块；结构和引用验证后发布。人工修订、确认行动项与已关联任务不由后续生成静默覆盖。问答消费授权快照，不具备自动分享/发消息/派任务权限。
- **异步产物**：Docs/IM 使用持久幂等凭据与结果查询；重试沿用原事件/接收人/版本，未知状态不等于失败或成功。通知助手是交付层，无需额外总结模型。
- **音频与翻译**：翻译输入独立于正式原文；按来源、generation、参与连接、订阅修订及租约校验事件。停止/撤权/后台释放播放，队列有界；恢复不重播旧队列。独立录音翻译复用采集 PCM，不另开第二个麦克风。
- **部署与关闭**：服务端、Android 和可选 Worker 默认关闭；内部令牌/模型密钥不进入 Web。按能力组合启用，关闭新任务与结束已有任务分开处理；升级时保留来源、版本和幂等记录。

主要服务路径：[记录权限](../../src/backend/core/services/meeting_records.py)、[版本总结](../../src/backend/core/services/meeting_summary_versions.py)、[自动调度](../../src/backend/core/services/meeting_summary_automation.py)、[独立原文来源](../../src/backend/core/services/capture_summary_source.py)、[云录制传输](../../src/backend/core/services/cloud_egress.py)、[文档交付](../../src/backend/core/services/summary_export_delivery.py)、[通知交付](../../src/backend/core/services/summary_notification_delivery.py)、[录音翻译网关](../../src/agents/capture_translation_gateway.py)。

## 3. 本轮最终验证

| 检查 | 结果 | 范围与限制 |
| --- | --- | --- |
| Meet 后端回归 | **684 通过**，44 个服务测试文件加回执测试 | 隔离 PostgreSQL/Redis/存储测试环境；覆盖采集/ASR/清理/云录制/总结/任务/问答/交付/权限/翻译；供应商与外部交付按 fixture 模拟 |
| Web 全量 Vitest | **991 通过，152 个文件** | 包括鉴权、恢复、音频控制和既有模块回归 |
| Web TypeScript / ESLint / 生产构建 | **通过** | ESLint 检查本批改动；保留已有产物 chunk-size 警告 |
| Agent 全量 unittest | **150 通过** | ASR、翻译、同传、送达、独立录音/翻译网关；无真实模型质量结论 |
| Android JVM 全量测试 | **373 通过，50 个类** | `:app:testDebugUnitTest`；0 failure/error/skip |
| Android 构建与规范 | **通过** | 批次 136 Debug/test APK 构建通过；本轮 `checkDesignTokens` 再次通过，生成的 5 个新增 BuildConfig 开关均为 false |
| Android 隔离设备回归 | **14 通过**（批次 136） | 6 项鉴权加 8 项录音翻译控制器；此前批次 133/134 已验证录音翻译 UI 和译文记录阅读；模拟器不替代真机 |
| 部署模板/脚本 | **8 通过，Helm lint 通过** | 默认禁用、Secret 引用、WSS/TLS、镜像 tag、部分发布；mock 命令/模板渲染，无集群变更 |

可复现命令：

```text
# we-meet/src/frontend
npx vitest run
npx tsc -b
npm run build

# we-meet/src/agents（安装锁定依赖的环境）
python -m unittest discover -s tests -p "test_*.py" -q

# we-meet-android（JDK 17，依赖已缓存）
gradlew.bat :app:testDebugUnitTest checkDesignTokens --offline --console=plain

# we-meet
python deploy/aliyun/test_meeting_ai_chart.py -v
helm lint src/helm/meet
```

后端使用 `pytest core/tests/services/<selected test files> core/tests/test_meeting_command_receipt.py -q --no-cov --reuse-db --tb=short --show-capture=no`，在隔离容器运行；选择范围为 capture、cloud、meeting records/captures/interpretation/translation/record services、versioned summaries/requests/review/tasks/exports/sharing/notifications、online、archives、delivery、summary automation/chunks/links。未将这 684 项称为整个后端仓库的全量测试。测试的静态目录等环境警告未影响结果。

## 4. 部署测试保留项

1. 原文/译文语义质量、专业术语、重叠发言、长会前后矛盾、总结事实支持率与行动项准确性。引用字符串匹配无法证明模型理解正确。
2. 实际 LiveKit Webhook/Egress、私有对象存储、版本化对象清理、Celery/Beat、Docs/IM 身份配置及异常恢复；迁移与回填需要在实际数据副本演练。
3. 真机麦克风、蓝牙、锁屏/来电/后台、系统回收、音频回灌、播放延迟，以及浏览器存储和后台限制。
4. 实际模型地域/额度/并发、供应商故障、资源使用、费用和告警阈值。缺失 usage 保持未知，不能从模拟测试推导成本承诺。
5. 已知产品边界：单轮问答原文 250,000 字节；Web 未提交编辑草稿刷新会丢失；Android 会中笔记弹层的任务/文档操作需转到完整记录页；分片回放可能缓冲；录音 ASR 失败需先恢复转写，自动总结等待原文。

这些事项已进入交接验收清单。阶段 5 的上传、说话人校正、评论/@、裁剪、视觉增强和硬件同步未自动追加到本轮首版范围。用户部署测试期间反馈的问题继续按严重程度修复，完成验证后自动提交与推送。
