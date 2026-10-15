# 会议远控验收证据矩阵

日期：2026-10-15。核对依据：[设计方案](../plan/meeting-remote-control-design-2026-10-14.md)、[历史评审](meeting-remote-control-design-review-2026-10-14.md)和当前源码。运行时代码基线为 `ba444e024512e7a8083adf9c7f0e308acfee8994`，分支 `feature/meeting-remote-control`。结论：**首期尚未完成验收，不能据此启用灰度**。

本表把设计要求与可复查的实现、测试和剩余证据关联起来。标为“模块证据”的项目，只在所列受控端口、合成状态或隔离数据库范围内成立；同一行仍有待补项时，该要求未整体完成。历史测试结果保留原执行范围，本轮没有重新运行全部历史测试。P4 平台扩展保持后续范围。

## 1. 证据索引

| 编号 | 可定位证据 | 范围与限制 |
| --- | --- | --- |
| E1 | `src/desktop/test-results/sdk-cloud-regression.log`；对应 `tests/remote-control-{cloud,runtime,controller-session,target-authorization}.test.cjs`、`remote-control-sdk.integration.cjs` 和 `remote-control-authorization.integration.cjs` | 第二十二批 51 项通过，8.157 秒；实际 SDK ESM/protobuf、WebCrypto/Python 签名互验、loopback HTTP，业务 HTTP/native 其余为受控替身；无原生键鼠注入。SDK 文件原为 `.test.cjs`，第二十三批移入集成集 |
| E2 | 实施记录第二十一批；前端六个远控测试文件；`src/frontend/test-results/remote-control-status-6176np/` | 35 项组件/输入测试及真实 Chromium 中文提示；合成会话状态，无真实会议 |
| E3 | 实施记录第十三～二十批；`native/remote-input/test_runtime.py`、`test_cleanup.cpp`、`test_keys.cpp` 及相关构建脚本 | 47 项释放故障、58 个真实子进程崩溃窗口、1,830 次组合键判断；前两类输入 API 为替身，不能证明实际键状态。最终默认原生 33 项中 28 通过、3 跳过、2 被本地接管打断；后两项单独复核通过 |
| E4 | 实施记录第九、十一、十二、二十三批；`src/backend/core/tests/services/test_remote_control*.py` | 第二十三批按新增 CI 六文件入口完整执行，91 项通过、113.07 秒；隔离 PostgreSQL/P-256，LiveKit IO 为替身，不能推定部署服务行为 |
| E5 | 实施记录第十七批，`src/desktop/test-results/static-frame-TZ794z/`、`static-frame-UaPmuI/` | 两次本机自有静态窗口经真实 VP8 WebRTC 解码 60 秒；没有 SFU、整屏和双机，最差帧间隔距 3 秒门槛仅约 75 ms |
| E6 | 独立验证工作树的 `src/desktop/release/*manifest.json`、`test-results/remote-app-profile-*/report.json`；具体当前包见实施记录 | 完整包资源摘要与独立 profile 启动，只读 native probe；未签名、未实际安装。每份报告只对应其自身 sourceRevision，不能代替之后的源码 |
| E7 | 第二十三批；独立 `we-meet-remote-control-ci` 工作树的 `src/desktop/test-results/ci-*.log` | 无前端依赖时桌面 109 通过、1 个 Work 包测试跳过；随后原生无输入 harness 和独立安装前端后的 SDK 7 项通过。Windows 步骤在本机重现，托管 GitHub Actions 尚未运行 |
| E8 | `src/desktop/test-results/remote-ipc-OV7ZJq/report.json`、`scripts/remote-control-ipc-smoke.cjs` | 实际 Electron 主进程、生产 preload 正向调用和真实 IPC；独立 profile，合成登录/cloud，loopback 页面。7 组检查、2 次合成 cloud、0 次 native；默认子 frame 无 preload，未直接触发其 IPC handler |

测试结果文件在忽略目录，本机路径均相对于开发工作树；E6 位于 `D:/workspace/jusi-meet/.worktrees/we-meet-remote-control-verify`。可持续复查的测试源码、命令和结论在 Git 中。源码或测试文件存在本身不算通过证据。

## 2. 功能、授权与交付契约

| 设计要求 | 当前实现/可检查入口 | 当前证据及待补项 |
| --- | --- | --- |
| §1、§4：PC Chrome/Edge/Electron 控制 Windows 10/11 x64；单显示器整屏 | A `ControllerProvider/ControllerView`；B `RemoteControlProvider`、桌面 `runtime/source-binding` | E1/E2 有模块证据；E6 仅当前 Windows 11 构建机启动。Windows 10、两个浏览器、独立双机均待实测 |
| §1：每连接一条关系、被控设备独占、禁止链与循环；不同真人账号 | `RemoteControlSession` 条件唯一约束；service `create_request/_locked`；`test_inverse_concurrent_requests_cannot_form_cycle` | E4 模块/数据库证据；真实 A/B/C 与连接替换待验 |
| §3.1 第 1～2 步：在线能力、申请/等待/取消、30 秒 TTL | A Provider/session；后端 presence/request；原生倒计时 | E1/E2/E4；客户端禁用原因已补齐。能力过期、退出与等待 UI 的真实网络时序待验 |
| §3.1 第 3～4 步：原生显示真实申请人、屏幕、作用域，默认拒绝；只在许可及 READY 后可操作 | `target-authorization.ts`、`trusted-ui.h`、`main.cpp`；服务端 request digest | E1/E3 覆盖匹配与迟到拒绝；真实屏幕/会议授权流程待验 |
| §3.1 第 5～7 步：A 显式焦点；B 控制条/停止；停止控制保留普通共享 | ControllerView、原生受信 UI、ScreenShareToggle 接入 | E2/E3 局部证据；普通共享、托盘停止及真实目标应用回归待验 |
| §3.2：无共享/窗口共享主动重选整屏；选择变化重新确认；取消不激活 | `source-picker.ts`、`source-binding.ts`、runtime、B Provider | source picker 模拟 27 源分页、错源拒绝已有测试；真实源枚举、取消/发布失败保留原共享待验 |
| §3.3、§6.3：B 本地接管 PAUSED，A 失焦 CAPTURE_SUSPENDED；不能互相绕过 | target authorization、controller/target transport、原生 gate | E1 与既有 transport 测试；实际物理输入识别、A/B 焦点竞争待验 |
| §6.1：不可变会话绑定、状态版本、epoch、幂等、数据库并发 | `models.py`、迁移 0223～0226、`services/remote_control.py` | E4；终态不可复活与取消/同意数据库竞态已有证据。真实多服务副本联调未完成 |
| §6.2：创建/列出 requests、获取 session、challenge、prepare、approve | `core/api/remote_control.py`、`core/urls.py`、service `create_request/list_requests/get_session/challenge/prove` | E4；普通用户凭据不证明原生来源，本机匹配仍为必要条件 |
| §6.2：reject/cancel/pause/end、lease/resume；管理员只能撤销 | service `action/prove`；本机 coordinator；HumanAccount/角色检查 | E1/E4；管理员不能代同意、暂停续租不重开、恢复需新 epoch 有模块证据；实际撤销时延待验 |
| §6.2：房间实例/实际 SID、同组织、等候室/机器人/匿名/设备账号、轨道归属及发布权限 | `remote_control_livekit.py`、policy、HumanAccount；boundaries 测试 | E4 使用受控 LiveKit 响应；真实服务端权限撤回、踢出和 room 重建待验 |
| §6.2：一次性用途挑战，consent/公钥/屏幕/权限完全匹配，合法服务签名也不能扩大本机授权 | `authorization.ts`、`target-authorization.ts`、后端 crypto/prove | E1/E4；继续保留首期无设备远程证明的保证边界 |
| §6.2：15 秒租约、5 秒续租、30 分钟最长、受信时间与单调截止、迟到结果失效 | `verifyLease`、target coordinator、native lease/监督 | E1/E3 的计时与迟到用例；真实网络隔离、墙钟变化、最大时长及故障释放仍需各自实测 |
| §7.1：唯一 destination，reliable，有效 SDK participant；SDK seq 与应用 seq 分离 | `relay.ts`、transport、SDK contract test | E1 直接验证固定 SDK 的去重与五参数回调；发送参数有 E2。A/B/C 非目标不收消息须在实际 SFU 验证 |
| §7.2：固定二进制/规范 JSON、P1363、私钥不可导出、消息字段和尺寸上限 | `wire.ts`、`signals.ts`、`protocol.h`、crypto | E1/E3/E4；签名互验不证明实际系统输入或目标应用完成动作 |
| §7.2：移动合并仅在编号前、120/s/文本 4/s、队列 250 ms、状态失败终止、高优先级释放 | controller/target transport、native runtime | 既有队列与原生故障用例；精确命中实际 key-up/button-up 的限流/过期/部分 SendInput 窗口仍待实测 |
| §7.3：连续输入 seq、重复只 ACK、缺口结束；heartbeat 独立；累计 ACK/1 秒超时/60 秒空闲 | controller/transport 测试、native gap 测试 | 应用假时钟用例和 E1 SDK 透明传递签名 seq=1/3/1；实际释放与双机 60 秒空闲待验 |
| §8.1：物理坐标/黑边/DPI/负坐标；源变更终止，映射歧义只查看 | `input.ts`、source binding、native monitor mapping | E2 坐标算法、既有 source 测试及局部双屏探针；完整屏幕矩阵见下表 |
| §8.2：左右修饰键、repeat、Unicode、composition/Enter/按钮隔离、一次性文本、不重发 | ControllerView、input、controller transport、native key/text | E1/E2 有事件隔离和签名握手证据；真实中文、目标应用、双击拖拽及应用快捷键待验 |
| §8.2：禁用安全组合和紧急组合所有顺序，保留正常 F10；释放仅处理会话候选 | native `forbiddenKeyDown`/ledger、input tests | E3 合成状态矩阵及真实热键注册冲突；混合物理修饰键、系统热键实际触发仍待验 |
| §9、§9.1：包内固定 helper/guardian、无裸输入接口、先记候选再 down、确认 worker 退出后释放、失败阻断 | native main/session-state、native-helper/resources、release journal | E3 故障与真实子进程窗口证据；当前原生源码实际按键释放复验、系统拒绝与安全桌面竞态未完成 |
| §9.2：原生 UI 保留区域、键盘提交隔离、独立监听/托盘、销毁时卸载 | `trusted-ui.h`、native observer/runtime | E3 控制条命中、隐藏条、负坐标与通知处理；UI 移动/DPI、拖拽穿越及真实 Tab/Enter 尝试待验 |
| §9.2：最小 IPC、frame/origin/参数/登录 epoch；退出/重载/崩溃清理；Work 独立 | `main.ts`、`preload.ts`、`runtime.ts` | E1 参数/context 检查；E8 验证主窗口、来源、参数、未登录及错误脱敏，默认子 frame 无桥。有效远控中的 Renderer/主进程异常清理与完整 Work 回归待验 |
| §9.2：固定 HTTP origin/路径、禁止重定向、8 秒总截止、2.1 MB 流上限、稳定错误码 | `cloud.ts`、authorization integration、cloud tests | E1 本轮补齐凭据等待截止；真实 loopback 重定向及停滞请求分别约 8 秒失败；无线上服务请求 |
| §10：拒绝/过期/失焦/媒体停止/断线/踢出/房间结束/服务异常/锁屏/电源变化，不恢复旧授权 | 前后端生命周期接入、native worker/guardian observer | 模块与向测试 HWND 投递通知有证据；真实系统通知时序、旧连接替换及媒体故障矩阵未完成 |
| §11、§11.1：组织/房间默认关闭、范围交集、限流冷却、管理 CAS、紧急关闭与审计同事务 | policy/admin service、管理页面、policy 测试 | E4 真实 PostgreSQL 提交顺序；实际部署下组织关闭通知及租约停止分布待验 |
| §11：90 天可配置审计、删除会议保留历史、有界游标、不记录输入 | audit 模型、prune/expire tasks、audit 测试 | E4 261 条同时间戳分页与保留用例；运维部署的周期任务执行尚未实证 |
| §11.2：kid/材料不复用、revision/generation、正常重叠及紧急撤销、全局锁、操作命令 | signing trust、remote_control_keys、migration 0226、CLI | E1/E4 的真签名/数据库证据；真实多副本滚动换钥与客户端连续续租待验 |
| §12：协议版本交集、单会话单版本、旧客户端可普通入会、不对未知广播回执 | presence/schema、signals、Provider；当前仅 v1 | 版本拒绝有模块证据；真实不同版本共会及老客户端音视频回归待验 |
| §12 文档：启用、客户端授权、故障排查、验收、最终协议 | 运维说明、使用说明、设计 §7/§9、`protocol.h`/wire/signals、实施记录及本表 | 文档已提供；真实双机与部署步骤需实走核验。拟定前端路径实际落在 `src/frontend/src/features/remote-control/`，浏览器共享协议在 desktop 的无 Node 模块中 |
| §13/§16.4：aliyun-dev 新分支、可复现基线、工具链/锁摘要、保留原工作区 | 分支与完整 SHA；E6 manifest；实施记录基线 | 已有隔离工作树与干净包来源；CI 已接入远控并有 E7 本机步骤验证，尚缺托管 runner 运行证据 |

## 3. §14.1 自动验收逐项状态

| 编号/要求 | 当前证据 | 尚缺的证明 |
| --- | --- | --- |
| 1 状态机、并发、幂等、终态和单设备/链限制 | E1/E4、`test_approve_cancel_race_has_one_terminal_decision` | 真实会议重入与部署多副本行为 |
| 2 权限、身份、房间实例、发布权限撤回 | E4 `test_request_policy_and_presence_restrictions` 等 | 实际 LiveKit 与业务权限联动 |
| 3 签名、重放、挑战、绑定、包大小、坐标、按键、限流 | E1/E3/E4；新增 SDK 边界验证 | 实际网络丢包下释放与终止 |
| 4 生命周期与故障 | E1/E2/E3，原生通知处理 | 真锁屏/安全桌面/休眠及完整应用崩溃后的释放 |
| 5 黑边/CSS/DPI/负坐标/旋转 | E2 与 source binding 模拟 | 实际 100/125/150/200% 全矩阵、热插拔与旋转 |
| 6 键盘/文本/双击/拖拽/releaseAll/紧急组合 | E1/E2/E3 的部分用例 | 双击、中文、混合物理输入及释放实机证据 |
| 7 IPC/frame/origin/epoch/路径/长度/EOF/异步撤销 | runtime/main 接入、E1/E3/E8；实际错误来源主 frame、其他 WebContents、参数/未登录拒绝 | 默认子 frame 没有 preload，仅证实无法调用；有效原生许可下的完整退出故障矩阵仍待验 |
| 补充：helper 在 Ctrl/拖拽 down 后 kill、各台账窗口、卡死、guardian/主进程失效 | E3；历史较早版本三项实际输入通过 | 当前版本实际输入与完整崩溃窗口重新验证 |
| 补充：限流/过期精确命中 up、部分成功、后续 heartbeat 不能继续 | 原生故障 harness 与队列测试 | 实际 SendInput、键状态和完整失败矩阵 |
| 补充：60 秒空闲、heartbeat/重复 ACK 不掩盖输入超时、累计 ACK 不改原截止 | controller/transport 的假时钟断言；E5 局部媒体探针 | 双机整屏与真实控制会话空闲 |
| 补充：A 失焦/暂停 ACK/旧代次/同时 B 接管 | E1/E2 与 transport | 实际浏览器焦点与 B 物理输入竞态 |
| 补充：同账号第二设备替换 SID，不继承旧会话 | Provider/session/runtime 模块 | 两设备实际重复 identity 踢出 |
| 第二轮：Renderer 自签/直接批准/换公钥或屏幕/跨用途挑战/合法服务签名不匹配 | E1/E4 绑定拒绝和真实签名 | 真实 UI/服务/原生闭环验证 |
| 第二轮：应用签名 seq=1/3、SDK 前置去重、末包丢失 ACK 超时 | E1 SDK 直接验证；已有 native gap、controller 超时 | SDK 收包测试本身不运行 native；实际被丢输入后的释放继续待验 |
| 第二轮：A/B/C 定向路由 | E2 唯一 destination 参数 | 实际 SFU 的三参会者收包记录 |
| 第二轮：组合顺序、物理键、合法 F10、注册冲突、UI 保留区 | E2/E3 | 混合物理状态和全部 UI 动态区域实测 |
| 第二轮：30/60 秒到期、取消/离会竞争、27 源、映射失败、发布失败 | E1/E3 与 source picker/binding 测试 | 实际超时 UI、采集权限拒绝及多源枚举/发布 |
| 第二轮：Enter/composition/按钮不转发，一次性文本和草稿 | E1/E2 | 真实中文输入法与目标应用 |
| 第二轮：安全桌面与台账提交竞态、墙钟变化、网络隔离、监督分别测量 | E3 合成状态/子进程窗口 | 真实系统切换与注入/释放；不可把回到 Default 视为清理成功 |
| 第二轮：专用 HTTP 边界和真人账号 | E1 新增真实 loopback；E4 HumanAccount | 线上认证服务与真实账号切换回归 |
| 第二轮：版本不交集、混发拒绝、无效广播无回执、旧客户端普通会议 | 模块 schema/信令/Provider 测试 | 不同版本真实共会回归 |

## 4. §14.2 实机矩阵及发布门槛

| 项目 | 通过所需证据 | 当前状态 |
| --- | --- | --- |
| 环境 | 两台独立 Windows，B 普通权限，A Chrome/Edge/Electron；记录 OS/运行时版本 | 第二台设备待用户准备；未完成 |
| 输入场景 | 编辑器/浏览器/文件管理器、滚动/拖拽/双击/中文/快捷键、管理员窗口及 UAC 降级 | 当前最新源码的完整实机矩阵未完成 |
| 屏幕 | 单/双屏、左/上副屏、DPI 组合、1080p/2K/4K；插拔/旋转 | 已有局部双屏负坐标证据；完整矩阵未完成 |
| 网络 | LAN、RTT 100/200 ms、丢包 1/5%、抖动/限带宽、断线无回放 | 未完成；loopback HTTP 截止测试不覆盖该项 |
| 本地停止 | B 点击/热键到执行门关闭 p95 ≤100 ms | 未取得分布 |
| 看门狗/释放 | heartbeat/native 检测与单进程故障普通桌面释放目标 ≤3 秒；失败显式报告 | 计时/故障模块与局部原生证据；最新真实按下状态及分布未完成 |
| 恢复/空闲 | 双机 60 秒空闲；A 失焦恢复和 B 本地暂停分别验证；旧代次不执行 | 假时钟与本机静态窗口证据；双机未完成 |
| 注入/画面延迟 | LAN 注入 p95 ≤150 ms，画面反馈 p95 ≤350 ms，记录时钟校准/统计方法 | 未测；不能用 ACK 或帧间隔冒充 |
| 弱网可用性 | RTT 100 ms/丢包 1% 完成基础任务；严重拥塞停止而非批量补发 | 未完成 |
| 稳定性 | 连续 30 分钟及至少 100 次申请/结束；检查键状态、失效许可与资源 | 未完成；模拟循环不能关闭该项 |
| 既有能力回归 | 共享、麦克风/摄像头、录制、聊天、翻译、退出重进、登录/Work | 只有包启动及局部接入证据，完整回归未完成 |
| §13 P0/P1/P2/P3 | 对应阶段技术证据全部通过并记录 | 实施授权已具备；阶段验收仍未关闭，P4 不自动纳入首期 |
| §14 发布阻断 | 未授权执行、撤销后执行、重放、卡键、错屏、无画面操作、无法退出、包遗漏均排除 | 局部测试不能排除所有真实场景；不具备灰度准入结论 |
| §15 签名/安装/升级/卸载 | 有效 Authenticode、运行时更新信任、安装资源摘要、升级/卸载残留和首次权限提示 | 当前内部包未签名；本机证书“可配置”尚未落实；隔离安装环境待备 |
| §15 灰度/回滚/换钥 | 先关开关等租约清空、保留审计、版本记录、监控指标、真实服务副本滚动换钥 | 已有运维步骤；未执行部署、灰度或回滚演练 |

## 5. 评审关闭与后续安排

F-01 对应本机授权匹配；F-02/F-03 对应 SDK 路由/序号；F-04 对应组合键与受信 UI；F-05 对应期限；F-06/F-10 对应系统输入和释放边界；F-07 对应源映射；F-08 对应两层暂停；F-09 对应不可用/结束提示；F-11 对应专用 HTTP/真人账号；F-12 对应文本；F-13 对应版本；F-14 对应基线。各项仍按本表和设计 §16.3 的证据要求关闭，不能仅因已修改文案就登记复审通过。历史评审报告保留，未代填评审人或批准结论。

当前已补 SDK 收包契约、请求总截止、CI 集成及真实 IPC 边界证据；未安排实际输入、系统休眠/锁屏或安装。第二台设备与证书配置沿用用户答复，不重复追问。后续应优先完成仍未实证的原生释放/系统竞态、双机矩阵、正式签名和隔离安装验收；涉及真实多副本与周期任务的部署证据另行记录。任何一项未完成，整体目标保持未完成。
