# Web 本人声纹设置、登记与代码走查

日期：2026-10-10（Asia/Shanghai）。范围为 `feature/speaker-identity-voiceprint` 的 Web 声纹设置及所需 API；继续按 Qwen 优先路线开发。

## 已接通的行为

系统设置新增“我的声纹”，提供个人账号及本人所属组织的独立作用域。三类授权分别修改，组织管理员只能开放目标组织功能。界面不自动登记、不自动开启麦克风；本人明确开始登记后展示六条朗读提示及上传期限。

录音最长十秒，停止后转换为单声道、24 kHz、PCM16 WAV，先在本地试听，再明确上传。也可选择符合同一格式的本人 WAV。音频、上传许可和试听地址只保存在当前面板内存中，不进入查询缓存或 localStorage；账号、作用域、权限版本变化和面板关闭均清理相关状态。文件选择不会直接上传。

已上传片段按服务端状态显示。只有服务端 `ready` 且 `confirmable` 的片段，完成试听并明确勾选本人声音后，才提供确认动作；Qwen 当前只有信号质量结果，样本显示“质量待审核”，不能据此建立可识别模板。拒绝和删除仍由服务端复核授权、预期版本与清理状态。

新增本人组织列表、作用域内删除回执列表和单个样本元数据读取；后者复用样本列表的所有者／作用域／generation 条件，不加载音频或向量密文。登记快照返回已上传槽位，便于继续下一段录制。

## 走查发现及修复

| 问题 | 修复与验证 |
|---|---|
| 浏览器 Cookie 切换身份但页面仍显示旧用户时，旧面板可能操作新账号 | Web 每个私有请求带 `X-Voiceprint-Owner`；服务端只把它作为当前登录身份断言，不能用来选用户。请求前、实际发送前和收到响应后同时检查登录会话；不匹配读写均拒绝 |
| 声纹自定义请求头不在跨域允许列表中 | 增加所有者及上传许可头；真实 CORS 预检回归通过 |
| 最后一段实际上传成功但响应丢失，轮询得到关闭的登记后无法重试 | 保留该次上传的原 WAV、原许可及原槽位，在原期限／版本仍有效时幂等重试，不新占登记配额 |
| 麦克风授权弹窗未响应时取消会等待；后续批准可能留下录音轨道 | 取消立即结束等待，迟到的授权主动停止全部轨道；关闭、隐藏面板或切换账号同样取消 |
| 录音停止后解码卡住，取消无法结束等待且界面仍显示正在录音 | 解码等待可取消，十秒期限后释放 UI 等待；明确显示“麦克风已关闭，正在准备试听片段”。浏览器底层解码 API 本身不可由此强制终止，迟到结果不会发布 |
| 分页位移造成重复项、无效 next offset 造成循环；自动刷新丢掉旧页而保留旧试听音频 | 校验偏移单调递增及范围，按 ID 合并去重，丢弃较早组织列表响应。保留已载入旧页，并单独刷新正在试听的旧样本元数据；不存在、到期、失去授权或心跳失败时释放音频地址 |
| 载入更多样本时未复核当前档案世代 | 先读取当前设置，变化时刷新而不追加旧页；拒绝其他／已删档案的分页响应 |
| WAV 中第一个 data 块为空时，客户端可能接受重复 data 块 | 明确记录是否出现 data 块，要求先有 fmt；结构错误和时长错误分别提示；服务端严格验证仍保留 |
| 真实浏览器录音间歇性无法进入试听，并误报麦克风错误 | 合成麦克风复现到解码浮点峰值 `1.020976`；PCM 转换前按 `[-1, 1]` 饱和截断，拒绝非有限值。不会整体归一化掩盖削波，服务端仍做质量检查；正／负 `1.03` 的两项回归先失败，修复后通过。转换错误不再统一提示麦克风授权失败 |
| 元数据中的坏日期可进入 UI；错误文字使用不存在的颜色 token 且被段落样式覆盖 | 拒绝坏日期，错误提示使用随主题变化的 `danger.subtle-text` 并补足选择器优先级 |
| 390px 窄屏中设置侧栏占近半宽，声纹正文及操作难以阅读 | 小屏导航改为横向滚动，当前节自动显示；面板可用宽度从 182px 增至 358px。限制弹窗高度以适应视口，并验证 1.5 倍字号 |

## 验证证据

- 后端 127 项：组织／回执 API、登记 API、登记服务和本人授权生命周期，覆盖账号断言、跨所有者／组织、撤销、删除世代、类型约束、幂等、真实私有 WAV 读取和 CORS。
- Web 50 项：声纹 API／控制器／录音／StrictMode 面板 43 项，以及既有设置编辑组件 7 项。包括迟到响应、原槽位重试、解码挂起取消与超时、音频地址释放、分页去重、坏响应和版本冲突。
- TypeScript、修改文件 ESLint／Ruff、locale 对齐、颜色及基础 token 检查通过；生产构建通过。构建仍报告既有大 bundle 和两项运行时静态素材引用提示。
- [可复现浏览器脚本](../../src/frontend/scripts/review-voiceprint-web.mjs)挂载真实 `SettingsDialog`、真实授权请求辅助函数和真实录音／解码 API，使用回环 HTTP fixture、Playwright 合成麦克风，并阻断外部 HTTP 请求。4.26 秒录音输出 204524 字节 WAV，浏览器 `Content-Length` 同为 204524，采样率／声道／位深分别为 24000／1／16。未自动修改权限，只有显式操作创建一次登记；上传后显示待审核且无确认入口。
- 取消录音及 Escape 关闭弹窗后，全部测试音轨为 `ended`；桌面浅色／暗色、390px 窄屏及 1.5 倍字号截图已人工检查，正文无横向溢出，浏览器无未处理异常。

截图：[桌面浅色](voiceprint-web-review-2026-10-10/desktop-light.png)、[桌面暗色](voiceprint-web-review-2026-10-10/desktop-dark.png)、[窄屏暗色](voiceprint-web-review-2026-10-10/mobile-dark.png)、[窄屏大字体](voiceprint-web-review-2026-10-10/mobile-large-dark.png)。数据均为测试 fixture。

在已安装项目依赖及 Playwright Chromium 的 `src/frontend` 中运行：

```powershell
node node_modules/vitest/vitest.mjs run src/features/voiceprint src/features/settings/components/EditableRow.test.tsx
node scripts/review-voiceprint-web.mjs
npm run build
node scripts/check-locale-parity.mjs
node scripts/check-color-system.mjs
node scripts/check-foundation-system.mjs
```

浏览器脚本仅监听回环，使用本地端口 5188；截图与脱敏结果默认写入系统临时目录 `we-meet-voiceprint-web-review`，可通过 `VOICEPRINT_REVIEW_ARTIFACT_DIR` 指定目录。它不连接生产后端，不采集真人声音，不记录真实凭证。

## 边界与后续工作

授权及有效性以服务端复核为准。可见面板每五秒轮询，收到撤销状态或读取失败时释放缓存试听；这不代表在其他端撤销后浏览器能瞬时获知。网络错误后的原片段上传重试与丢弃仍由本人选择，服务端再次验证许可。

当前验证只证明 Web 登记和服务端边界；服务端真实语音／单人质量、模板生成、多人实名匹配、可信通话采样、Android 声纹设置与登记、生产部署及获授权真人评测继续待完成。没有识别准确率结论，也没有触发 CAM++ 替换或开放自动归属。

录音行为参考：`MediaRecorder.stop()` 会结束录制并交付末尾数据，[MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/stop)；音轨释放调用 `MediaStreamTrack.stop()`，[MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop)。完整录制容器经 `decodeAudioData()` 解码时会按音频上下文采样率重采样，[MDN](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)。这些 API 说明不能替代本项目实际浏览器和服务端验证。
