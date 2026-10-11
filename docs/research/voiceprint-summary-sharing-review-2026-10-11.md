# 固定纪要分享与跨端打开走查

日期：2026-10-11（Asia/Shanghai）。后端／Web 及 Android 分支：`feature/speaker-identity-voiceprint`。Android 提交：`d5782b32`。本记录接续[人工纪要身份与权限走查](voiceprint-human-summary-identity-review-2026-10-11.md)。

## 问题与修复

从固定 AI 或人工历史纪要页面复制链接、生成聊天卡片时，原分享入口只带记录 ID 与 `tab=summary`，收件人打开的是当前纪要；聊天预览也读取当前内容。Android 链接解析只支持固定 AI 版本，没有将固定人工版本交给原生记录路由。因此，身份确认后的旧纪要虽然保持冻结，分享却无法保留原版本。

现在固定页面的分享入口传递 AI `summary_id` 或人工 `human_id`，复制链接分别使用 `?summary=<id>`、`?human=<id>`。聊天卡片保留现有 v1 协议，增加可选版本字段；两端解析、转发和打开都保留该字段。选择器必须为规范 UUID、二选一且属于纪要作用域，非法值不会被丢弃并转换成最新纪要。旧的无版本卡片及记录列表分享继续使用原有当前内容入口。

Web 的实际聊天点击处理使用同一个链接构造函数；固定页面的分享面板随版本切换重新初始化。Android 将人工版本贯穿链接解析、待处理链接、导航参数和 `RecordDetailScreen`；固定人工页面使用自身版本仓库读取，仓库或版本缺失时显示不可用，不进入 AI／当前版分支。页面切换和返回保留原有固定版本语义。

`GET meeting-records/<record>/collaboration/minutes/preview/` 新增可选 `summary_id` 或 `human_id` 查询参数。后端只在已授权记录的关联版本中查找，返回所选 ID、该版本冻结的概览和只读 `identity_updated`，人工版本使用自身基准 snapshot 比较。无版本请求维持原逻辑；缺失／其他记录版本返回 404，非法、重复、双选择器或记录作用域附带版本返回 400。

两端预览缓存或状态按版本隔离，并核对服务器回显的版本 ID；缺少或替换回显时隐藏正文，不接受最新内容冒充固定内容。Web 展示既有身份更新提示，固定页面提示在五种语言中改为通用“固定纪要版本”文案，适用于通知和手动分享。

## 权限与兼容边界

链接和卡片只选择内容，不授予权限；协作者管理仍沿用记录及作用域授权。预览保持 `Cache-Control: private, no-store`，在正文和身份状态读取后再次检查权限，期间撤权返回 404。提示不包含当前姓名、声纹候选或原文；未新增模型调用、自动重新生成或修改历史正文、引用及任务。

新后端兼容不带选择器的旧客户端。旧客户端可能忽略新增卡片字段，不能保证固定版本打开，因此固定分享契约需要配套更新 Web／Android；新客户端面对忽略选择器的旧服务器会因缺少回显拒绝展示预览。工具没有向真实聊天发送消息或变更协作者权限。

## 验证证据

| 范围            | 结果及覆盖                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 后端            | 49 项组合回归通过，51.21 秒；其中新增 13 项覆盖 AI／人工冻结预览、最新入口兼容、其他记录／缺失版本、非法／重复／双选择器、错误作用域、只读权限及读取中撤权；组合包含协作、固定链接及 AI／人工身份状态测试                                        |
| Web             | 6 个文件共 90 项通过，31.41 秒；涵盖版本卡片与转发、非法选择器、固定预览和错误回显、复制及聊天分享字段、无授权写入，以及工作区、人工历史与 AI 面板回归                                                                                           |
| Web 浏览器      | 实际 Chromium、真实卡片组件与 `MeetingRecordWorkspace` 路由，AI／人工各在 1280px、390px 完成打开、固定正文／身份提示、分享复制、版本缺失和撤权检查；最终 4 组流程、66 次 GET、0 次写入、0 次未预期 API／页面异常／外部请求；窄屏截图人工检查通过 |
| Android JVM     | 12 项通过：9 项 `RecordLinksTest`，3 项 `MeetingRecordVersionCardTest`；覆盖旧卡片兼容、AI／人工链接、转发／预览选择器及非法选择器拒绝                                                                                                           |
| Android 原生 UI | API 29 隔离模拟器 22 项不同测试通过：固定分享导航／Retrofit HTTP、人工历史与 AI 历史组合 16 项（27.688 秒），记录工作区相关 6 项（14.822 秒）；覆盖固定人工原负责人／截止时间、固定 AI、版本缺失不回退、只读权限、后台清除与撤权                 |
| 制品及静态检查  | 独立 `.fixturespeakeridentity` debug 与 AndroidTest APK 构建通过；TypeScript、修改文件 ESLint／Prettier、五语言 JSON／键一致性、后端修改文件 Ruff／格式及两库差异空白检查通过                                                                    |

浏览器复现入口位于 `src/frontend/scripts/review-speaker-identity-summary-sharing.mjs`，从 `src/frontend` 运行 `npm run review:speaker-summary-sharing`。需要项目依赖及 Playwright Chromium；默认仅监听本机 5319 端口，通过 `SPEAKER_SUMMARY_REVIEW_PORT` 可改端口。默认截图与结果写入已忽略的 `test-results/speaker-summary-sharing`，可用 `SPEAKER_SUMMARY_REVIEW_ARTIFACT_DIR` 指定其他目录。入口使用本地合成账号和 HTTP fixture，拒绝外部请求，复制操作仅记录到测试页面，不写入系统剪贴板。

本次浏览器最终结果保留在工作目录 `pinned-summary-share-browser-2026-10-11/result.json` 及 `pinned-summary-share-browser-result-final-2026-10-11.log`。后端、Web、Android 输出分别为 `backend-summary-sharing-final-2026-10-11.log`、`web-pinned-summary-sharing-final-2026-10-11.log`、`android-pinned-summary-sharing-ui-2026-10-11.log`、`android-pinned-summary-sharing-workspace-result-2026-10-11.log`；Android JVM XML 位于各模块 `build/test-results/testDebugUnitTest`。

最初新增测试修正了隔离 fixture 的权限码与不可删除版本假设；浏览器入口补齐虚拟 JSX 编译和合法通知查询 fixture，并显式返回失败退出码。补充 Android 工作区回归发现四条旧测试仍点击已移除的纪要页签，已改为当前纪要入口，其他测试的辅助入口保持原样。不累加重复运行作为独立测试数量。

## 尚未完成的验收

浏览器使用真实组件／路由与本地 API，Android 使用真实导航／Retrofit 和本地 HTTP；这些证据扩大了组件验证范围，但不代表真实 IM 投递、生产登录、完整生产 Application 或生产后端联合分享验收。Android 使用 `IsolatedRecordsRunner`，没有初始化生产账户、推送及其他仓库。

获授权真人效果及门限校准、真实设备／更多系统与媒体条件、可信外部墓碑恢复、集群网络／TLS／容量及正式发布验收仍待完成。未采集真人声音、调用付费 ASR或部署生产。Qwen 优先，未满足要求再考虑私有化 CAM++ 的路线和完整开发目标保持不变。
