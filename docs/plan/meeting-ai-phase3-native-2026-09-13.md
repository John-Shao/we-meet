# 会议 AI 阶段 3：Android 与跨端恢复（第 44–85 批）

整理日期：2026-09-22。

原生记录、采集、回放、任务、翻译与跨端恢复；保留少量同期 Web 修复。

本文件按原批次 / 日期合并，保留原文、验证记录和当时状态，仅调整标题层级与文档链接。正文中的“本批”“下一批”“已通过”均为历史记录，不代表本次重新验证或当前部署状态。原文件名用于追溯；阶段内批次与累计批次沿用原编号。

[返回方案目录](README.md)

## 目录

- [阶段 3 第四十四批（累计第 64 批）：Android 统一记录 API](#phase3-batch44)
- [阶段 3 第四十五批（累计第 65 批）：Android 笔记与纪要阅读](#phase3-batch45)
- [阶段 3 第四十六批（累计第 66 批）：Android 原文阅读](#phase3-batch46)
- [阶段 3 第四十七批（累计第 67 批）：Android 精确纪要链接](#phase3-batch47)
- [阶段 3 第四十八批（累计第 68 批）：私人译音挂载权限修复](#phase3-batch48)
- [阶段 3 第四十九批（累计第 69 批）：Android 独立录音协议](#phase3-batch49)
- [阶段 3 第 50 批（累计第 70 批）：Android 录音恢复日志](#phase3-batch50)
- [阶段 3 第 51 批（累计第 71 批）：Android 录音恢复控制器](#phase3-batch51)
- [阶段 3 第 52 批（累计第 72 批）：Android PCM 采集层](#phase3-batch52)
- [阶段 3 第 53 批（累计第 73 批）：Android 录音前台服务](#phase3-batch53)
- [阶段 3 第 54 批（累计第 74 批）：Android AI 录音页面](#phase3-batch54)
- [阶段 3 第 55 批（累计第 75 批）：Android 转写与付费意图](#phase3-batch55)
- [阶段 3 第 56 批（累计 76）：Android 录音转写界面](#phase3-batch56)
- [阶段 3 第 57 批（累计 77）：Android 总结与自动化协议](#phase3-batch57)
- [阶段 3 第 58 批（累计 78）：Android 分阶段总结 UI](#phase3-batch58)
- [阶段 3 第 59 批（累计 79）：Web 总结请求刷新恢复](#phase3-batch59)
- [阶段 3 第 60 批（累计 80）：Android 私有回放协议](#phase3-batch60)
- [阶段 3 第 61 批（累计 81）：Android 回放引擎](#phase3-batch61)
- [阶段 3 第 62 批（累计 82）：Android 回放与原文定位](#phase3-batch62)
- [阶段 3 第 63 批（累计 83）：Web 纪要回执校验](#phase3-batch63)
- [阶段 3 第 64 批（累计 84）：Android 人工纪要与任务协议](#phase3-batch64)
- [阶段 3 第 65 批（累计 85）：Android 人工纪要界面](#phase3-batch65)
- [阶段 3 第 66 批（累计 86）：Android 行动项任务确认](#phase3-batch66)
- [阶段 3 第 67 批（累计 87）：Android 私有问答协议](#phase3-batch67)
- [第 68 批：原始文档缺失，仅保留摘要入口](#phase3-batch68)
- [第 69 批：原始文档缺失，仅保留摘要入口](#phase3-batch69)
- [第 70 批：原始文档缺失，仅保留摘要入口](#phase3-batch70)
- [第 71 批：原始文档缺失，仅保留摘要入口](#phase3-batch71)
- [第 72 批：原始文档缺失，仅保留摘要入口](#phase3-batch72)
- [第 73 批：原始文档缺失，仅保留摘要入口](#phase3-batch73)
- [第 74 批：原始文档缺失，仅保留摘要入口](#phase3-batch74)
- [Phase 3 batch 75 (cumulative 95): native in-meeting controls](#phase3-batch75)
- [Phase 3 batch 76 (cumulative 96): native private translation protocol](#phase3-batch76)
- [Phase 3 batch 77 (cumulative 97): native translation events/audio boundary](#phase3-batch77)
- [Phase 3 batch 78 (cumulative 98): native private translation session](#phase3-batch78)
- [Phase 3 batch 79 (cumulative 99): native personal translation workspace](#phase3-batch79)
- [Phase 3 batch 80 (cumulative 100): native shared-interpretation protocol](#phase3-batch80)
- [Phase 3 batch 81 (cumulative 101): native shared-interpretation listening state](#phase3-batch81)
- [Phase 3 batch 82 (cumulative 102): native shared interpretation workspace](#phase3-batch82)
- [Phase 3 batch 83 (cumulative 103): native retained translation browsing](#phase3-batch83)
- [Phase 3 batch 84 (cumulative 104): native uncertain-write recovery alignment](#phase3-batch84)
- [Phase 3 batch 85 (cumulative 105): durable Web online-capture controls](#phase3-batch85)

---

<a id="phase3-batch44"></a>

来源：`meeting-ai-phase3-batch44-2026-09-13.md`。

## 阶段 3 第四十四批（累计第 64 批）：Android 统一记录 API

Android 增加统一资料库、准确记录、分阶段纪要和固定快照引用的 API/仓储层。现有按房间的历史页面暂未切换，下一批接入原生资料库及纪要界面。

记录/快照 UUID 校验、能力缺省关闭、源站固定、游标参数化、每页数量限制、引用坐标核对、取消传播和账号切换后的响应丢弃均已实现；新资料读取禁用缓存、重定向和调试日志。主客户端调试日志补齐 Authorization/Cookie/Set-Cookie 脱敏。

Android 仓库 `we-meet-android/main` 的详细执行记录见 `docs/meeting-ai-batch64-2026-09-13.md`。12 项 JVM 测试、Kotlin 编译、Debug APK 构建和设计规范护栏通过，全部 HTTP 拦截为夹具；没有真实后端或模型调用，没有安装/部署应用。

无后端迁移。Android 采集前台服务、录音恢复、会中功能和翻译仍未完成；完整技术评审及用户部署验收保持待办。

---

<a id="phase3-batch45"></a>

来源：`meeting-ai-phase3-batch45-2026-09-13.md`。

## 阶段 3 第四十五批（累计第 65 批）：Android 笔记与纪要阅读

实现仓库：`../we-meet-android`，分支 `main`。

会议首页通过默认关闭的 `WE_MEET_RECORDS_NATIVE` 构建开关接入原生笔记／纪要列表；支持归属与来源筛选、标题搜索和游标翻页。记录详情展示三阶段纪要、历史及 ASR 状态；引用仅在具有原文权限时按精确快照读取。后台、读错误或失权清除私有内容。

本批验证：Debug 和测试 APK 构建、12 项仓库 JVM 回归、设计 token 护栏、5 项隔离模拟器 Compose 测试通过；已查看浅色／深色截图。测试仅使用内存固定数据，未访问真实会议、AI 或通知服务。完整登录及服务器联调由用户部署后测试。

Android 详细实现与复现方式见 `../we-meet-android/docs/meeting-ai-batch65-2026-09-13.md`。无后端迁移；原生采集生命周期、更多资料能力与最终技术评审继续推进，M3/M4 尚未整体完成。

---

<a id="phase3-batch46"></a>

来源：`meeting-ai-phase3-batch46-2026-09-13.md`。

## 阶段 3 第四十六批（累计第 66 批）：Android 原文阅读

`we-meet-android/main` 接入线上原文、独立录音原文、全文搜索及独立录音发言人筛选；按记录版本翻页，源变更时丢弃结果并提示刷新。前后权限与 revision 检查避免读取后继续展示失权或变更内容，线上场次校验不回退到会议室最新内容。

验证：Debug 与仪器 APK 构建、16 项 JVM 测试、6 项隔离模拟器 UI 测试、设计 token 检查通过，原文页面截图已查看。无真实提供商调用、录音或消息发送。沿用默认关闭的原生阅读开关，无后端迁移；详细说明见 Android 仓库 `docs/meeting-ai-batch66-2026-09-13.md`。

继续精确版本通知链接及原生采集生命周期；M3/M4 与最终整体走查仍未完成。

---

<a id="phase3-batch47"></a>

来源：`meeting-ai-phase3-batch47-2026-09-13.md`。

## 阶段 3 第四十七批（累计第 67 批）：Android 精确纪要链接

Android 原生详情接入纪要助手已有的规范 record/summary 链接，严格校验配置 origin 和唯一版本选择；版本不可用时不自动回退。冷启动可在进程内等待登录，随后使用当前账户权限读取。默认关闭的原生开关同时关闭 App Link alias，避免拦截尚未启用的网页流程。

验证：21 项 JVM、7 项隔离模拟器 UI 测试、构建与设计 token 检查通过。无实际消息发送、登录或服务调用；系统域名验证及部署后联调由用户执行。无后端迁移。详见 Android `docs/meeting-ai-batch67-2026-09-13.md`。

继续原生采集与权限边界检查；总体开发与最终走查仍在进行。

---

<a id="phase3-batch48"></a>

来源：`meeting-ai-phase3-batch48-2026-09-13.md`。

## 阶段 3 第四十八批（累计第 68 批）：私人译音挂载权限修复

代码走查发现，通用音频渲染器对共享同传已有挂载校验，但私人翻译仍依赖订阅后的音量归零，存在先挂载、后静音的窗口。

本批为私人译音增加挂载前检查：登录用户、会议连接、来源参与者 SID、翻译 run 与 generation、收到 ready 的 Agent 连接 SID，以及 ready 中明确提供的 audio_track_sid 必须一致；还要求已开启声音、服务可用且状态新鲜。没有上下文、未收到授权音轨、其他设备、其他轨道和旧代次均不挂载 AudioTrack。

现有 Agent 已在 ready 发送 audio_track_sid，无需改模型或 Agent 协议。旧 ready 缺字段时可恢复文字控制，但不授权不明确的音频。音量控制保留为第二层保护。状态读取卡住时，本地单调时钟 15 秒上限使播放器卸载；停止／离开上下文后，旧音频解锁 Promise 不能重新打开声音。

验证：35 项前端回归通过，涵盖私人／共享翻译、严格 ready 解码、渲染器挂载、换设备和代次、403、卡住的状态请求及停止后延迟回调。TypeScript、ESLint 与生产构建通过；最终清理后再次执行受影响的 10 项测试。构建仍有既有 Marianne/devise 静态资产和大 bundle 提示。未播放实际会议音频，部署后的实际收听验证由用户执行。

无后端迁移、功能开关或模型变化。继续 Android 原生采集等剩余开发；这是开发过程中的边界修复，不能替代最后的完整技术评审。

---

<a id="phase3-batch49"></a>

来源：`meeting-ai-phase3-batch49-2026-09-13.md`。

## 阶段 3 第四十九批（累计第 69 批）：Android 独立录音协议

Android 接入设备租约控制、固定标识请求、规范 WAV 分片、严格上传回执以及封存清单读取。历史操作回执与当前 capture 分开处理；应用不自动更换键重试，取消／账户切换不接纳旧响应。专用 HTTP 客户端无日志、缓存、重定向或连接自动重试，总超时 20 秒。

验证：25 项 JVM 测试、Debug 构建、设计 token 护栏通过，无真实服务或麦克风操作。无后端迁移。具体 API 与音频边界见 Android `docs/meeting-ai-batch69-2026-09-13.md`。

原生加密本地缓冲、恢复控制器、前台采集服务及界面继续实施；当前不能开启原生 AI 录音。整体开发与最终技术评审未完成。

---

<a id="phase3-batch50"></a>

来源：`meeting-ai-phase3-batch50-2026-09-13.md`。

## 阶段 3 第 50 批（累计第 70 批）：Android 录音恢复日志

Android 新增按账号隔离的加密 SQLite 日志，持久保存创建幂等键、设备租约、未确认命令、封存意图和待上传音频。采用 Android Keystore AES-256-GCM，数据不参与系统备份；缺失密钥或损坏密文不会触发覆盖重建。

分片追加、编号和计数原子提交；精确上传回执确认后才清除对应音频。缓存、时长和分片数量有界；一个账号仅允许一个未完成录音，完成历史最多 100 份元数据。账号切换拒绝旧账号读写。

验证：Android Debug/test APK、设计 token 检查和 8 项断网模拟器 Keystore/SQLite 集成测试通过。本批未采集麦克风或访问真实服务。下一批为恢复控制器，随后接前台采集和 UI；M3/M4 及最终整体技术评审仍未完成。

---

<a id="phase3-batch51"></a>

来源：`meeting-ai-phase3-batch51-2026-09-13.md`。

## 阶段 3 第 51 批（累计第 71 批）：Android 录音恢复控制器

Android 接通持久创建/命令意图、状态恢复、回执核对、补传、停止和封存。加载不自动开麦或重发请求；重启后须用户显式续录或结束。未知结果重放原键和请求体；409 终止当前动作，下次操作重新读取状态。音频确认和封存保持精确、不可变边界，晚到的启动响应不能撤销本地关闭。

验证：9 项控制器测试和 8 项存储回归在断网 Android 模拟器通过；Debug/test APK 和设计 token 检查通过。内存协议替身，无真实麦克风或服务调用。下一批接前台采集服务，之后为 UI；整体评审与部署实测仍待完成。

---

<a id="phase3-batch52"></a>

来源：`meeting-ai-phase3-batch52-2026-09-13.md`。

## 阶段 3 第 52 批（累计第 72 批）：Android PCM 采集层

新增 16 kHz 单声道 PCM16 AudioRecord 适配器与 5 秒分片 pump。停止排空已读尾段，不足整毫秒补零少于 1 ms；设备切换、系统静音、读取/写盘失败和权限变化不触发自动开麦或丢失数据后的伪成功。输入 PCM 暂存使用后清零，写盘独立于上传。

验证：8 项 PCM 测试、9 项传输回归、Debug 构建与设计 token 检查通过。尚未实际开麦；前台服务和 UI 下一批接入，锁屏/蓝牙/来电需用户设备实测。API 边界依据 [Android 官方说明](https://developer.android.com/media/platform/sharing-audio-input)。

---

<a id="phase3-batch53"></a>

来源：`meeting-ai-phase3-batch53-2026-09-13.md`。

## 阶段 3 第 53 批（累计第 73 批）：Android 录音前台服务

Android 新增不可导出的 microphone 前台服务，绑定只读本地恢复、用户显式启动才采集；通知暂停先停止并排空音频，再释放设备、唤醒锁与通知。退出账号清除私有状态；进程被系统终止不会自动重启录音；未知请求继续沿用日志内意图。

保险丝 WE_MEET_CAPTURE_NATIVE 默认 false，服务 manifest 同步禁用。它独立于 WE_MEET_RECORDS_NATIVE。UI 下一批接入；部署时须配合服务端独立录音及音频协议开关，不能仅打开 Android 开关。

验证：4 项 Android 服务生命周期测试和 17 项恢复/存储回归通过，使用独立 Application、合成 PCM、内存协议；没有真实麦克风、上传或模型调用。构建和设计 token 检查通过。真机锁屏、蓝牙、来电、网络恢复尚待部署测试，M3/M4 与最终整体评审仍未完成。

---

<a id="phase3-batch54"></a>

来源：`meeting-ai-phase3-batch54-2026-09-13.md`。

## 阶段 3 第 54 批（累计第 74 批）：Android AI 录音页面

原生会议首页接独立 AI 录音页，包含本地恢复、权限申请、开始/续录、暂停、结束确认、补传、完成保存以及精确 record 跳转。页面在后台清除私有呈现并解绑；已启动前台服务维持采集，返回接回同一会话。通知按账号返回录音页，不触发自动开麦。

保险丝仍为 WE_MEET_CAPTURE_NATIVE=false；查看原生会议记录同时需要 WE_MEET_RECORDS_NATIVE。录音保存仅指音频封存，实时 ASR、纪要生成和原生回听继续实现，未标记 M3 完成。

验证：6 项新增 UI/合成音频集成测试及 7 项记录界面回归通过；构建、设计 token 检查、深浅色截图走查通过。页面退后台再返回的流程由真实服务与合成音源验证，实际麦克风、锁屏、蓝牙、来电和通知冷启动导航留待用户部署测试。

---

<a id="phase3-batch55"></a>

来源：`meeting-ai-phase3-batch55-2026-09-13.md`。

## 阶段 3 第 55 批（累计第 75 批）：Android 转写与付费意图

Android 新增独立转写状态、创建/取消及实时确认文本预览的固定路径 API，严格验证当前账号、任务 ID、代次、计数与分页坐标。首次创建发送必需的 expected_job_id:null；能力缺省不开放付费入口。

新增独立于音频历史的账号加密意图日志，发送前持久化键和请求体。未知结果复用原请求；明确拒绝结束本次操作，不自动新建任务。日志有界但不自动丢弃未解决请求，避免历史清理破坏付费请求恢复。

验证：7 项 JVM 协议测试、4 项 Android 加密存储/协调测试、构建及 token 检查通过。全部使用响应/协议替身，无真实付费请求。下一批接原生转写 UI 与实时预览；完整首版、真机验证及最终技术评审仍待完成。

---

<a id="phase3-batch56"></a>

来源：`meeting-ai-phase3-batch56-2026-09-13.md`。

## 阶段 3 第 56 批（累计 76）：Android 录音转写界面

Android main 提交 `95eaf5ff`：原生录音页接入实时/封存 ASR 手动开启、精确任务取消、状态刷新和确认文字分页。未知付费请求从加密日志恢复，保持原键/正文，只有用户点击才重放；新建能力关闭后仍可核对原请求。页面离开前台停止读取，失败隐藏旧正文。

验证：5 项新增 ASR UI/Keystore 测试、12 项录音/记录 UI 回归，隔离模拟器共 17 项通过；Debug/test APK、设计 token 和三种状态截图检查通过。没有真实网络、麦克风或模型请求。沿用默认关闭的 Android capture/records 开关，无后端迁移。

下一批继续原生总结与自动纪要控制。M3/M4 未整体完成，实体设备及部署联调由用户执行；开发后的完整技术评审与走查仍待完成。

---

<a id="phase3-batch57"></a>

来源：`meeting-ai-phase3-batch57-2026-09-13.md`。

## 阶段 3 第 57 批（累计 77）：Android 总结与自动化协议

Android main `613a7a63` 接入分阶段总结进度、生成/重新生成/重试和自动纪要开启/停止，使用固定记录 ID、版本/任务代次与加密持久化意图。自动化原命令回执与当前状态分开校验，重放不会误触发相反操作。

14 项 JVM 协议/ASR 测试、8 项隔离模拟器协调器/日志测试通过，Debug/test APK、设计 token 检查通过。推送前同步了远端两项独立通讯录提交，并补跑 Debug 构建。没有部署、真实模型、通知或共享动作，无迁移。原生 UI 操作与实时/速记内容继续下一批，完整评审仍待完成。

---

<a id="phase3-batch58"></a>

来源：`meeting-ai-phase3-batch58-2026-09-13.md`。

## 阶段 3 第 58 批（累计 78）：Android 分阶段总结 UI

Android main `e666ee5d`：录音与记录详情接入分阶段生成、精确任务重试和自动纪要开启/停止。使用服务端就绪阶段、当前生成权限和持久化原请求；录音页可查看最近三份实时/速记/最终纪要及精确原文引用。锁定历史通知版本时不展示生成控制。

7 项新增总结 UI 加 12 项记录/转写回归，共 19 项隔离模拟器测试通过；Debug/test APK、设计 token 和三种状态截图检查通过。假 API，无真实模型、通知或共享动作。无迁移，默认开关不变。

继续补齐原生播放、任务和跨端一致性。M3/M4 与全量技术评审未完成，部署联调及实体设备验证由用户负责。

---

<a id="phase3-batch59"></a>

来源：`meeting-ai-phase3-batch59-2026-09-13.md`。

## 阶段 3 第 59 批（累计 79）：Web 总结请求刷新恢复

修复 Web 总结与自动纪要意图仅存于组件内存的问题。发送之前先写入当前标签页 sessionStorage，按账号、记录和操作类型隔离；刷新或重新打开组件只读取，不自动发送。已有未知请求优先于新界面值，迟到旧响应只能清除精确匹配的请求。存储损坏、读写失败时停止新建请求并提供恢复检查；存储内容仅包含请求键与阶段/版本坐标，不保存原文。

HTTP 408、429、5xx 和网络失败保留原请求；明确的 400/401/403/404/409/422 才清除对应意图。两个写入口增加 20 秒超时、no-store 和禁止重定向。账号/记录切换时重建组件内部状态。

验证：5 项持久化 hook 测试、6 项自动化组件测试、12 项总结组件测试，共 23 项通过；TypeScript、定向 ESLint、生产构建通过。构建仍有既有 Marianne/devise 静态资源和大 bundle 提示。没有实际模型调用或部署，无迁移。

恢复范围是同一标签页的刷新/重挂载；不承诺关闭标签页后的恢复。下一批继续 Android 原生音频回放，完整开发和技术评审尚未结束。

---

<a id="phase3-batch60"></a>

来源：`meeting-ai-phase3-batch60-2026-09-13.md`。

## 阶段 3 第 60 批（累计 80）：Android 私有回放协议

Android main `f801650d` 接入已封存媒体记录的播放列表与有界认证音频下载。严格验证原文权限、精确 capture/record/版本、清单分页、音频格式/长度/哈希，下载前后重新检查权限；缺口不自动跳转。无磁盘音频缓存。

7 项新增回放协议测试与 9 项 capture 回归，共 16 项 JVM 测试通过；Debug 与设计 token 检查通过。使用拦截器假接口，无实际音频设备或网络调用。无迁移，默认开关不变。播放器与音频焦点继续下一批，完整评审仍待完成。

---

<a id="phase3-batch61"></a>

来源：`meeting-ai-phase3-batch61-2026-09-13.md`。

## 阶段 3 第 61 批（累计 81）：Android 回放引擎

Android main `e464a80f`：有界双分片回放/预取、缺口停止、访问权续检、取消清理与 AudioTrack 音频焦点输出。实例只执行一次显式播放，失焦及耳机断开不自动恢复。

15 项 JVM 引擎/协议测试与 2 项隔离模拟器 AudioTrack/焦点测试通过，Debug/test APK 和 token 检查通过。只使用静音合成 PCM，无网络/模型/麦克风调用。遵循 Android 官方 [AudioTrack](https://developer.android.com/reference/android/media/AudioTrack) 和 [音频焦点](https://developer.android.com/media/optimize/audio-focus) 规则。

无迁移，默认开关不变。原生 UI 与生命周期接入下一批，真实蓝牙/耳机和部署联调由用户验证，完整技术评审仍待完成。

---

<a id="phase3-batch62"></a>

来源：`meeting-ai-phase3-batch62-2026-09-13.md`。

## 阶段 3 第 62 批（累计 82）：Android 回放与原文定位

Android main `46e46669`：采集页/资料详情回放、逐字稿与纪要引用定位、倍速和缺口显式跳转。进入页面不播放；后台、账号失效、录音或会议启动时释放原输出，返回重新检查且不自动续播。采集页新增文字记录/纪要页签。

30 项隔离交互/前台服务回归通过，Debug/test APK、默认开关构建和设计 token 检查通过；浅色、深色、失败态截图检查通过。只使用模拟数据和合成 PCM，无真实麦克风/模型/业务网络操作。无迁移，默认开关不变。

下一批补强 Web 纪要写入回执校验。原生任务/交付闭环、独立翻译、仅文字保留链路及整体技术评审仍待完成；M3/M4 未宣告完成，部署与真机联调由用户执行。

---

<a id="phase3-batch63"></a>

来源：`meeting-ai-phase3-batch63-2026-09-13.md`。

## 阶段 3 第 63 批（累计 83）：Web 纪要回执校验

技术走查发现：纪要生成与自动纪要开关写入此前仅依赖 HTTP 成功状态，缺失/畸形 JSON 仍可能清除会话存储中的原请求凭据。

现在验证请求 UUID、任务坐标/阶段/状态、分段进度以及自动纪要的冻结回执。异常 2xx 保持未知结果，保留原 key/body，页面重载后仍须显式核对。自动纪要要求冻结结果与原操作及下一修订匹配；当前状态可以更新，不会用旧开启回执覆盖后来的关闭。

44 项回执/控件/持久请求测试通过，TypeScript、ESLint、生产构建通过；构建仍有既有 Marianne/devise 静态资源及大 bundle 提示。无迁移、默认开关不变，无真实模型/业务写入。下一批继续原生人工纪要和任务闭环，整体技术评审和首版收尾仍未完成。

---

<a id="phase3-batch64"></a>

来源：`meeting-ai-phase3-batch64-2026-09-13.md`。

## 阶段 3 第 64 批（累计 84）：Android 人工纪要与任务协议

Android main `743ce3a`：人工版本当前/历史/精确读取、显式保存、负责人搜索和任务转换协议；加密持久意图覆盖未知回执恢复。严格检查版本、结构和引用坐标，任务负责人/日期显式传递，不使用 AI 标签自动赋值；跨版本去重和删除回执继续遵循后端契约。

15 项 JVM + 8 项隔离存储/协调器测试通过，Debug/test APK、设计 token 与 diff 检查通过。原生人工保存请求上限 64,000 UTF-8 字节，以适配现有 64 KiB 加密意图边界。无迁移/默认开关变更，无真实任务、通知或模型调用。

下一批接入原生人工纪要编辑/确认界面。首版其余闭环与整体技术评审继续，部署测试仍由用户负责。

---

<a id="phase3-batch65"></a>

来源：`meeting-ai-phase3-batch65-2026-09-13.md`。

## 阶段 3 第 65 批（累计 85）：Android 人工纪要界面

Android main `50440c36`：资料详情接入人工纪要编辑、增删结构化条目、历史分页和精确原文引用。保存新增人工修订，显式切换 AI 来源；冲突保留当前页面草稿，未知结果使用原加密请求核对。撤权/后台隐藏正文和编辑器，不触发任务或通知。

20 项隔离界面回归、Debug/test APK、设计 token/diff 检查通过；浅色编辑器及深色只读态检查通过。未提交草稿仅在当前页面内存保留，已提交未知请求有加密恢复。无迁移/默认开关变更/真实业务写入。下一批任务确认与跳转，首版其余收尾及整体技术评审仍待完成。

---

<a id="phase3-batch66"></a>

来源：`meeting-ai-phase3-batch66-2026-09-13.md`。

## 阶段 3 第 66 批（累计 86）：Android 行动项任务确认

Android main `5441698b`：人工行动项明确确认、负责人搜索与手动选择、可选日历日期、任务状态/删除回执及原生任务详情跳转。未知请求使用原加密 key/body 核对；当前人工版本不匹配、读取失败或无转换权限时阻止新创建。

19 项隔离界面回归、Debug/test APK、默认构建及设计 token/diff 检查通过，浅色确认表单/深色删除态检查通过。无真实任务或通知调用，无迁移/默认开关变更。继续原生会后问答/纪要交付，首版其它收尾及整体技术评审仍待完成。

---

<a id="phase3-batch67"></a>

来源：`meeting-ai-phase3-batch67-2026-09-13.md`。

## 阶段 3 第 67 批（累计 87）：Android 私有问答协议

Android main `5fe6ee7f`：明确原文快照的私有提问、最近问题和精确读取；成功回执匹配问题/快照、答案状态和引用坐标。RECORD_QUESTION 加密意图支持原 key/body 核对，读取不产生付费请求。私有问答 HTTP 总超时 45s，超时结果仍保持未知；不改变其它会议接口 20s 上限。

16 项 JVM + 8 项隔离协调器/存储测试通过，Debug/test APK、设计 token/diff 检查通过。无真实模型/业务网络调用，无迁移/默认开关变更。下一批问答界面，整体技术评审及剩余首版功能继续。

---

<a id="phase3-batch68"></a>

## 第 68 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch68-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch68-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch68-summary)

---

<a id="phase3-batch69"></a>

## 第 69 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch69-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch69-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch69-summary)

---

<a id="phase3-batch70"></a>

## 第 70 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch70-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch70-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch70-summary)

---

<a id="phase3-batch71"></a>

## 第 71 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch71-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch71-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch71-summary)

---

<a id="phase3-batch72"></a>

## 第 72 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch72-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch72-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch72-summary)

---

<a id="phase3-batch73"></a>

## 第 73 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch73-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch73-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch73-summary)

---

<a id="phase3-batch74"></a>

## 第 74 批：原始文档缺失，仅保留摘要入口

原引用文件：`meeting-ai-phase3-batch74-2026-09-13.md`。此文件在本次整理前已不在目录中；这里不补写实现、部署或验证结论。

- [实施计划中的现存摘要](meeting-ai-implementation-plan-2026-09-12.md#phase3-batch74-summary)
- [部署历史中的现存摘要](meeting-ai-deployment-history-2026-09-13.md#phase3-batch74-summary)

---

<a id="phase3-batch75"></a>

来源：`meeting-ai-phase3-batch75-2026-09-13.md`。

## Phase 3 batch 75 (cumulative 95): native in-meeting controls

Android main `b3270475` adds exact-occurrence recording controls, explicit start/stop confirmation, encrypted unknown-request recovery and join-token-only participant notices. The notice remains visible with hidden toolbars; opening the exact record preserves the call. Reconnection closes the previous workspace.

`WE_MEET_ONLINE_AI_NATIVE=false` is a new independent Android build flag. Cloud-video recording remains its existing placeholder. No backend migration or default provider/agent flag changed.

17 isolated instrumentation tests, enabled Debug/test APK, default-disabled Debug build, design-token/diff checks and light/dark screenshot review passed. Actual connected-room layout, device reconnection and provider deployment remain user testing. Native translation alignment and remaining first-release gaps continue next.

---

<a id="phase3-batch76"></a>

来源：`meeting-ai-phase3-batch76-2026-09-13.md`。

## Phase 3 batch 76 (cumulative 96): native private translation protocol

Android main `bf8a46d2` adds exact-occurrence, account-scoped private translation state/control, validated immutable receipts and encrypted original-request recovery. Language, mode, audio and retention choices remain fixed during retries. Stop requests omit start options; malformed success and permission loss keep unknown intents.

15 JVM and 11 isolated instrumentation tests, default-disabled Debug/test APK and token/diff checks passed. No migration, provider invocation, deployment or microphone use. Native event/audio lifecycle and translation controls follow; this protocol alone does not enable translation playback.

---

<a id="phase3-batch77"></a>

来源：`meeting-ai-phase3-batch77-2026-09-13.md`。

## Phase 3 batch 77 (cumulative 97): native translation events/audio boundary

Android main `f6a40e3a` validates private data-channel events and keeps confirmed text immutable. With the existing native online-AI flag enabled, SDK auto-subscription is replaced by ordinary-track subscriptions plus exact, short-lived translation-track grants. Reconnection revokes grants; no translation UI grants playback yet.

16 JVM tests, enabled/default-disabled Debug builds and token/diff checks passed. Actual cancellation timing, ordinary audio/video and physical-device reconnection remain deployment checks. No real meeting/provider/audio invocation. Native translation workspace follows.

---

<a id="phase3-batch78"></a>

来源：`meeting-ai-phase3-batch78-2026-09-13.md`。

## Phase 3 batch 78 (cumulative 98): native private translation session

Android main `7dadce06` adds transient exact-connection translation state, dispatch-based freshness, explicit sound consent and ordered manual speech commands. Duplicated completion events cannot unlock later speech; unknown commands block further speech in the affected runtime until that run is stopped. Read failure/source changes clear playback.

24 JVM tests, default Debug and token/diff checks passed. No real meeting/provider/audio use. Native workspace and SDK transport integration follow; the state logic itself does not open an entry point or request microphone access.

---

<a id="phase3-batch79"></a>

来源：`meeting-ai-phase3-batch79-2026-09-13.md`。

## Phase 3 batch 79 (cumulative 99): native personal translation workspace

Android main `1d38d1ff` connects exact-occurrence private translation controls, reliable manual speech, translated text/captions and explicit audio grants. Start consent freezes language/mode/audio/retention. The meeting microphone is reused without automatic permission/toggle actions. Closing the panel preserves translation; backgrounding silences playback and ends held speech. Recovered unfinished turns are ended, not restarted. Unknown/pending controls block new playback/speech until reconciled.

20 distinct isolated UI/coordinator regressions passed (9 final private UI tests plus 11 companion regressions), with enabled Debug/test APK, default-disabled Debug, token/diff and light/dark checks. Native online AI remains default off. The optional archive link opens the associated record; native archive browsing still follows. No migration or real provider/audio/deployment invocation. Shared interpretation is next; actual SDK cancellation timing and connected-room/device layout remain user deployment checks.

---

<a id="phase3-batch80"></a>

来源：`meeting-ai-phase3-batch80-2026-09-13.md`。

## Phase 3 batch 80 (cumulative 100): native shared-interpretation protocol

Android main `895d5a04` adds exact-occurrence channel controls, connection-specific listening choices and renewal validation. Separate encrypted intents preserve channel consent and personal selection; historical receipts cannot create a fresh playback lease. Shared HTTP calls are bounded to 8 seconds against a 20-second listener lease.

17 JVM and 12 isolated instrumentation tests, default-disabled Debug/test APK and token/diff checks passed. No migration, provider/audio invocation or deployment. Shared event/audio lifecycle and native channel UI follow. Native archive browsing, standalone translation and true text-only cleanup remain first-release work before the overall technical review.

---

<a id="phase3-batch81"></a>

来源：`meeting-ai-phase3-batch81-2026-09-13.md`。

## Phase 3 batch 81 (cumulative 101): native shared-interpretation listening state

Android main `fe4241fd` adds channel/subscription-bound events and explicit foreground listening. Exact source/agent/track grants are bounded by both API freshness and listener leases. Old renewal replies cannot replace a newer choice; expired selections do not auto-resume. Confirmed text stays separate from originals and is bounded/redacted locally.

25 JVM tests, default Debug and token/diff checks passed. No migration or real provider/audio/deployment invocation. Native shared SDK transport, channel management and listener UI follow.

---

<a id="phase3-batch82"></a>

来源：`meeting-ai-phase3-batch82-2026-09-13.md`。

## Phase 3 batch 82 (cumulative 102): native shared interpretation workspace

Android main `cea5c3ea` adds the shared interpretation SDK transport, channel management and participant listening UI. Opening a channel does not auto-subscribe; closing confirms impact on all listeners. Leaving affects only the current device. Original encrypted intents survive unknown responses, while historical receipts cannot reactivate playback. Foreground leases and exact active-source grants bound playback; backgrounding and renewal failure silence it. Personal and shared translated voice are mutually muted when choosing listening.

23 isolated instrumentation tests (10 shared UI, 9 private UI, 4 shared coordinator), enabled/default Debug builds, design tokens and diff checks passed. Light confirmation and dark listener screens inspected. No migration or real provider/audio/deployment invocation. WE_MEET_ONLINE_AI_NATIVE remains off by default. Native retained-translation browsing and remaining first-release gaps follow; M3/M4 are not yet complete.

---

<a id="phase3-batch83"></a>

来源：`meeting-ai-phase3-batch83-2026-09-13.md`。

## Phase 3 batch 83 (cumulative 103): native retained translation browsing

Android main `182269f4` adds a translations tab under original-material access. Exact record/archive pagination keeps shared and owner-only private translations separate from original speech and minutes. Validated delivery timestamps never imply media seek positions. Incomplete archives and reverse-direction targets are explicit. Foreground reads clear private text on access failure, backgrounding and account changes.

8 protocol JVM tests and 12 isolated UI regressions, default Debug, design tokens and diff checks passed; light list and dark personal archive inspected. No migration, deployment, real material or provider invocation. Existing feature defaults remain off. Older native write-intent recovery alignment follows, then remaining first-release features and the final technical/code review. M3/M4 remain incomplete.

---

<a id="phase3-batch84"></a>

来源：`meeting-ai-phase3-batch84-2026-09-13.md`。

## Phase 3 batch 84 (cumulative 104): native uncertain-write recovery alignment

Android main `5ee62aff` preserves original encrypted ASR, summary, automation, human-review, task and question intents through HTTP 401/403/404. Access loss after an unknown response cannot prove the earlier attempt failed; recovering access must reconcile the original key/body. ASR validates generation IDs before persisting an intent.

21 isolated coordinator/store tests and 7 ASR protocol JVM tests, Debug/test builds and token/diff checks passed. No migration, provider, real user action or deployment invocation. Web online-capture recovery alignment follows before remaining first-release features and final technical review.

---

<a id="phase3-batch85"></a>

来源：`meeting-ai-phase3-batch85-2026-09-13.md`。

## Phase 3 batch 85 (cumulative 105): durable Web online-capture controls

Online capture start/stop now uses tab-scoped durable metadata keyed by viewer, room and exact LiveKit occurrence. Reloading recovers the original operation and idempotency key without dispatching it. Missing/corrupt storage blocks new operations. HTTP 401/403/404/408/429 and server failures preserve unknown requests. Account or occurrence changes remount the workspace and cannot transfer the previous pending operation.

Both status and write receipts validate their runtime contract. Only the frozen result matching the requested start/stop can resolve the intent; a newer current run is not substituted for that result. Missing fields, mismatched record IDs, wrong states and malformed success bodies remain uncertain. Private requests use no-store, reject redirects and supply abort deadlines.

Validation: 31 frontend tests (14 online controls, 5 protocol, 5 durable metadata, 3 participant notice, 4 meeting workspace), TypeScript, changed-file ESLint, formatting/diff checks and production build passed. Existing Marianne/devise asset and large-bundle warnings remain. No provider/deployment or real recording was invoked. Next: complete text-only retention foundations and remaining first-release work; full technical/code review still follows feature completion.
