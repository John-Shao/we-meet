# 会议远程控制实施记录

日期：2026-10-15。状态：实施中，未完成、未部署。用户已授权从 aliyun-dev 新建分支完成方案实现。

## 基线与范围

- 分支：`feature/meeting-remote-control`，起点 `origin/aliyun-dev` / `d9e81a9eadcf79aef275081273a6e2a0a5fc33e6`，创建时已拉取远端确认一致。
- 独立工作目录：`D:/workspace/jusi-meet/.worktrees/we-meet-remote-control`。
- 原 `we-meet` 工作区的未提交业务改动保留；仅复制[设计方案](../plan/meeting-remote-control-design-2026-10-14.md)与[历史评审](meeting-remote-control-design-review-2026-10-14.md)。原 AI 平台变更不作为本功能隐含依赖。
- 实施范围保留方案首期：PC Web/Windows 桌面控制 Windows 被控设备、本人原生同意、同会议授权、屏幕与输入绑定、键鼠/文本、暂停/撤销、故障释放和审计。P4 平台扩展仍为后续阶段，不宣称已实现。

## 第一批：原生执行与签名基础

已编写并验证：

- Windows C++ 输入 helper 与独立 guardian；受限继承句柄、共享候选台账，guardian 不接收远程命令，只在 helper 退出确认后释放候选键/按钮。
- P-256/SHA-256 输入签名、704 字节定长帧（640 字节被签名）、会话/屏幕/输入代次绑定、连续输入序号、独立 heartbeat 序号、3 秒挑战有效期、15 秒最大原生租约。
- 键鼠白名单、范围检查、组合键限制、输入速率上限、原生本地交互/热键监测；台账先记录 down，确认 up 后清除，Unicode 候选也进入释放台账。
- 主进程内部 `RemoteInputHelper` 适配器：固定资源路径、SHA-256 清单核验、后台启动、消息长度限制、父进程心跳、等待独立 guardian 清理结果；尚未暴露给 preload 或会议页面。
- 浏览器兼容的 TypeScript 二进制编码/签名器，与 Win32 CNG 交叉验证。
- 后端批准证明和短租约签名工具：限制域规范 JSON、P1363 验签、不可覆盖的 audience/到期 claims；尚未接入数据库和 API。

### 已执行验证

| 命令（仓库根目录） | 结果与范围 |
| --- | --- |
| `python src/desktop/scripts/build-remote-input.py` | 通过；本机 Visual Studio 18 C++ x64，C++17、/W4 /WX；生成原生二进制和摘要清单 |
| `node src/desktop/node_modules/typescript/bin/tsc --project src/desktop/tsconfig.json` | 通过；桌面 TypeScript 编译 |
| `python src/desktop/native/remote-input/test_runtime.py --inject -v` | 12 项通过；包括真实 Ctrl-down、鼠标左键 down 后强制终止 helper，实际按键释放并收到 guardian cleanup=1 |
| `node --test src/desktop/tests/remote-control-native.integration.cjs` | 3 项通过；编码拒绝、签名字段篡改、WebCrypto→CNG、输入缺口拒绝和 guardian 退出结果；用例原为 `.test.cjs`，现按集成依赖分开运行 |
| `PYTHONPATH=src/backend python -m unittest core.tests.services.test_remote_control_crypto -v` | 4 项通过；规范编码、绑定/用途签名变更、错误公钥、租约 audience/上限；Windows 可用 PowerShell 设置 PYTHONPATH 后运行 |

原生注入测试只在测试程序创建的前台窗口中验证修饰键和左键释放，不输入业务内容、不发送应用命令。默认不带 `--inject` 时跳过这两项真实注入测试。未将生成的 EXE/OBJ、密钥或用户环境配置提交仓库。

### 尚待完成（不视为已通过）

1. 原生 P0：混合 DPI/热插拔/旋转的完整矩阵、完整安全桌面竞态、守护/工作线程卡死以及全部台账窗口故障注入。双屏 150%/负坐标映射及受信 UI 已有第三批证据；基线 `200620538` 的 21 项完整实机测试已在用户提供的空闲窗口通过，尚不覆盖以上完整矩阵。第五批 WTS 锁屏检查加入后的解锁状态回归仍待完成。
2. 后端后续：真实 LiveKit 房间联调、管理配置与密钥轮换、过期/保留任务验收（包括房间删除时审计保留）、审计分页及完整跨租户/限流验收；本轮已补接口与数据库测试，见下文。
3. 桌面：第六批已接入采集 handler、会议上下文、main/preload、换号/锁屏/退出清理、签名 transport 与守护退出确认；仍需真实 Electron/LiveKit 会话联调、打包资源和完整生命周期实机验收，不能仅凭模块测试判定交付。
4. 前端：第六批已有被控端会议 Provider、申请查看/拒绝、整屏发布绑定、定向 SDK 转发和停止共享前关门；控制端 A 的能力发现/申请入口、专用视图、焦点暂停握手、文本隔离、输入 ACK/心跳与后台处理仍待实现。
5. 联调：两台独立 Windows 设备、Chrome/Edge/Electron、A/B/C 定向消息、弱网、30 分钟/100 次循环、原会议回归。
6. 交付：原生资源打包/签名、固定摘要、安装升级验证、配置/运维说明、完整需求验收；未经证据证明不得标为完成或开启生产功能。

### 本批实现选择与后续约束

- 固定二进制输入是方案允许的编码选项，替代高频 JSON 的跨语言规范化；批准签名仍为限制域规范 JSON。
- 第一批固定顶部 64 像素区域已在第三批替换为真实 HWND 区域与安全边距；UI 隐藏、位置不符、停止按钮被遮挡或消息循环失去响应时拒绝继续输入。
- 本地接管目前使 helper 关闭并释放；协调层应将其映射为业务 PAUSED，只能经 B 本地恢复、更新 epoch/输入代次后重新装载。
- 资源摘要用于包内完整性检查，不等于 Windows 代码签名。正式交付需先签名再生成最终摘要，并验证打包后字节一致。
- 开发阶段 desktop/node_modules、frontend/node_modules 使用已安装依赖的本地 junction，以便验证；最终须以此分支锁文件独立安装/构建，不能把共享依赖目录视作可复现交付证据。

## 第二批：服务端授权与桌面许可校验

已新增数据库迁移 `0223_remote_control_authorization`，持久化连接能力、申请/许可状态、一次性挑战及生命周期审计。申请和授权转换按账号稳定顺序加数据库行锁；数据库约束另限制同连接/同被控设备的未结束关系。原生来源仍不能由临时自签公钥证明，最终本机同意记录尚待 UI/协调器接入。

实现内容：

- `/api/v1.0/rooms/{room_id}/remote-control/` 下的能力声明/查询、申请/查询、prepare/approve/lease/resume 挑战与验签、暂停、取消、拒绝、结束及管理员审计读取。采用现有 OIDC/Session 认证，业务显式拒绝匿名、停用、设备账号；管理员仅可撤销，不可代同意。
- LiveKit 服务端查询房间 SID、当前参会连接、真人类型、数据/共享权限及屏幕轨道归属；客户端提交的 SID 必须与查询结果一致。组织默认关闭，支持控制者/被控者用户范围和最长时长；房间策略只能收紧。
- 30 秒申请、60 秒准备、15 秒签名许可、30 分钟最长会话；挑战绑定用途、版本、epoch、申请摘要和完整绑定，消费后只返回原收据；终态不恢复。暂停续租不会改为 ACTIVE。
- 已验签 webhook 的离会/房间结束/轨道移除回收；既有结束会议、移除参会者和修改权限 API 接入回收。Celery 每 5 秒协调到期状态，保留任务每小时运行；原生执行不依赖定时任务及时触发。
- 桌面 `RemoteControlCloud` 固定路径/动作、8 秒超时、实际响应读取上限、登录 epoch 检查和稳定错误码；不新增任意 URL 桥。
- 桌面批准证明规范编码、不可导出私钥及 P1363 签名；签名许可与本机完整 binding/epoch/state 匹配，单调截止扣除整段 HTTP 耗时和 1 秒时间量化预算，并受本地最大会话截止约束。服务端每次响应提供新顶层 serverTime，不能用旧幂等收据中的时间重置租约。

新增配置为 `DJANGO_REMOTE_CONTROL_ENABLED`（默认 false）、`DJANGO_REMOTE_CONTROL_SIGNING_KEY`、`DJANGO_REMOTE_CONTROL_SIGNING_KID`；签名密钥独立于 LiveKit secret。组织 `settings.remote_control.enabled` 也必须显式为 true。当前端到端功能未接通，尚不能按这些配置开启可用的会议远控。

### 本轮验证证据

| 验证 | 结果及边界 |
| --- | --- |
| 独立 PostgreSQL 16 全量 migrate | 通过，含新迁移；`makemigrations --check --dry-run` 无差异，Django check 无问题 |
| `test_remote_control.py`、`test_remote_control_boundaries.py`、`test_remote_control_crypto.py` | 38 项通过；真实数据库/API/签名/反向申请和同意取消竞态，LiveKit 网络 IO 被替换为协议对象 |
| 上述测试加既有会议结束与参会者管理测试 | 88 项通过，44.40 秒；包含新鲜响应时间与幂等收据的区别 |
| 既有 LiveKit 事件与 webhook API 测试 | 42 项通过，7.79 秒；原本隔离房间 handler 的一项测试补 db fixture，保留真实撤销查询 |
| 桌面 `tsc` + `node --test tests/remote-control-*.integration.cjs` | 10 项通过；包含 WebCrypto→Python 证明、Python→JOSE 许可、有效签名但本机绑定不匹配的拒绝、换号迟到响应与无 Content-Length 超限读取 |
| `npm run test:remote-control`（桌面目录） | 通过，重新编译原生与 TypeScript 后 10 项 Node 集成测试通过；Python 原生测试 10 项通过、2 项真实注入按默认参数跳过；真实注入证据另见第一批 `--inject` 记录 |
| 新增后端模块及迁移 Ruff | 通过；未将原 models.py 的历史样式问题伪称为全仓 lint 通过 |

测试后端使用此 worktree 挂载到 `meet-backend:f12d6c04c` 基线镜像，Python 3.13.5 / Django 5.2.14；独立 PostgreSQL 容器端口 15446、Redis 端口 15447，不使用生产数据。测试依赖 pytest 9.0.3、pytest-django 4.12.0；桌面互验需要 Python cryptography/PyJWT。集成用例单独列入 `npm run test:remote-control`，不让普通桌面单元测试隐式要求原生工具链与后端 Python 环境。

以上不证明两台设备可实际操作、受信同意 UI、采集源映射、安全桌面完整恢复、部署或签名安装包已经完成。剩余首期范围继续按上方清单推进。

## 第三批：原生确认、控制条与显示器绑定

原生 helper 现在必须先完成自己的确认记录才能接受 Arm；直接发 Arm、确认过期、替换控制者公钥/共享实例/屏幕/epoch 都不能开放输入。确认信息由主进程受限管道传入；原生 UI 的存在不替代主进程验证服务许可和原始申请，这段协调流程尚待接入。

已完成的实现：

- Win32 确认窗显示申请人、整屏分辨率、控制范围说明、紧急键及倒计时；拒绝为默认方向，到期关闭。独立于会议 Renderer，不加载网页和通用 API。
- 原生置顶控制条、托盘停止后备入口；指针按真实窗口物理区域及 8 像素边距拒绝，键盘/文本拒绝注入 helper 的前台 UI。停止按钮可见性、置顶状态、窗口位置、消息线程心跳均进入执行检查。
- 长姓名完整显示于确认窗，控制条单行省略；热键提示为独立控件，避免被长姓名挤掉。已检查 150% 缩放下普通/159 字符姓名确认窗及控制条截图。
- 本地真实输入立即关闭共享 gate，再释放并报告 local_takeover；紧急热键单独报告 emergency_stop。捕获挂起保留同意但释放输入；重新开放必须使用新 inputGeneration；停止会清除原生同意。恢复按钮只产生 resumeRequested，不自行恢复授权。
- 原生枚举 GDI 显示器名、DisplayConfig 目标路径、物理区域、方向及有效 DPI；镜像/缺失映射拒绝绑定。同意及 Arm 再核对显示器，显示事件和定期快照变化使旧绑定失效。
- 主进程 `source-binding.ts` 使用 source.display_id → Electron Display → `screen.dipToScreenRect` → 唯一 Win32 物理区域映射，再匹配 DPI/方向并生成绑定摘要；拒绝窗口、缺失/重复映射，不按名称或数组下标猜屏幕。采集记录具有准备 TTL、登录 epoch、共享实例和不可变轨道 SID。
- 此映射模块与原生 UI 已做独立验证，但尚未改接 main.ts 的共享 handler 或 preload；普通共享不会因此自动获得控制许可。

### 本批证据与剩余验证

| 检查 | 结果与边界 |
| --- | --- |
| 原生 C++ /W4 /WX 构建、桌面 tsc | 通过；清单源摘要包括新增 trusted-ui.h |
| `node --test tests/remote-control-*.integration.cjs tests/remote-control-*.test.cjs` | 13 项通过，包含真实 UI 确认后 WebCrypto→CNG、已有云端/许可互验及新增源映射/采集记录用例 |
| 原生默认测试 | 中间版本 19 项执行，17 通过、2 项注入按默认参数跳过；后续新增负坐标用例后共 21 项，完整实机结果如下，不用旧结果替代最终测试 |
| `remote-control-display-probe.cjs`，项目 Electron 44.4.3 | 退出码 0；本机两块 3840×2160、150%（144 DPI），DIP 均为 2560×1440；左侧副屏物理 left=-3840、DIP x=-2560，均精确对应；清理确认成功 |
| 修正测试窗口消息循环后的三项 `--inject` 专项 | 主屏 Ctrl、主屏左键、副屏左键实际按下及位置检查通过，强制终止 helper 后 guardian 释放确认通过 |
| 21 项完整 `--inject` 回归 | 用户提供约 20 秒空闲桌面后，21 项全部通过，18.344 秒，退出码 0；包括主屏 Ctrl、主屏/负坐标副屏拖拽、helper 强制终止及 guardian 实际释放。此前完整运行 19 通过、2 项因前台焦点/local_takeover 中断的记录保留；本次未关闭本地接管保护 |

环境为 Windows 11 build 26200、Electron 44.4.3、双 4K/150% 实体显示器。真实输入测试仅操作测试程序自己的窗口；已修正原测试在主线程阻塞等待管道、没有泵送 Windows 激活消息的问题，测试目标改用独立消息线程并在注入前确认前台窗口。测试自动点击只针对新建 helper 的精确 PID、固定窗口类及测试姓名；这是操作系统层测试驱动，不是真人同意证明，也不是生产接口。

`npm run probe:remote-control:displays` 可重跑实际映射探针，输出在忽略目录 `dist/remote-input/display-probe.json`。`npm run test:remote-control` 包含本批普通/集成用例；`npm run test:remote-input:injection` 需要可使用的空闲交互桌面。原生热键测试必须串行，不能让两个 helper 测试同时抢同一热键。尚未验证混合 DPI、镜像降级的真实设备、热插拔/旋转完整矩阵、托盘操作全过程及安全桌面竞态。

本轮同时合入最新评审文档修订，保留本分支已获实施授权与固定二进制协议决定；设计 §16.3 为复审关闭标准，实施授权顺延到 §16.4。下一步继续主进程授权协调器、屏幕发布绑定、最小桥及会议前端闭环。

## 第四批：主进程授权协调与暂停竞态

新增 `src/desktop/src/remote-control/target-authorization.ts`，由受信主进程持有，尚未装配到 `main.ts`/preload 或会议前端。模块不会因 HTTP ACTIVE 自动发送 Arm/READY；实际开放仍须下一步的 A 签名视频/焦点握手、输入代次和 transport 校验。因此本批通过不代表参会者已能端到端操作设备。

已实现：

- 从固定服务读取能力签名公钥及申请，核对完整申请摘要、会议/双方连接、本机登录 subject/epoch、设备会话、范围及有效期；B 会话私钥仅在本模块内创建并持有。
- prepare 的屏幕/轨道引用只能对应主进程已有采集记录。逐字段验证服务端挑战的用途、版本、epoch、申请摘要、一次性 ID、有效期及完整 binding，验签结果确认后才将待发布记录转为已验证轨道。
- 原生确认按随机同意 ID 关联；等待期间轮询取消状态、检查单调期限及采集/登录变化。approve/resume 必须具备相应 epoch 的本机同意；异步签名、HTTP、许可验签返回后再次检查撤销代次。
- 完整验证签名许可与本地固定绑定和服务端版本，每 5 秒续租；全程扣除请求耗时及时间量化预算，暂停续租维持 PAUSED。停止先关本机门并作废任务，再尽力通知服务端；迟到成功响应不能复活会话。
- 本地接管与原生恢复按钮接入授权状态机；恢复按钮触发新的原生确认与 resume 证明、递增 epoch，仍须重新进行输入握手。没有对 Renderer 提供任意签名、`approve=true` 或直接恢复入口。
- 新增 close-only 原生 Pause 命令：释放、撤销本机同意并保留暂停控制条。业务暂停须同时取得服务端状态和原生清理回执才能恢复；1.5 秒未得到本机释放回执则阻断后续授权。此时间是协调器判定阈值，不是所有故障下的实际系统释放保证。
- 本地接管与已排队 Pause 竞争时，Pause 仍仅关闭，不重新激活。负值、零值或缺失的 cleanup 回执使本协调器永久阻断；后续主进程装配还须把这一阻断跨会话传递，并等待 guardian 退出结果，不能通过重建对象绕过。

### 本批验证

| 检查 | 结果及边界 |
| --- | --- |
| 用户明确提供空闲桌面后的完整真实注入回归 | 第三批提交 `200620538` 上 21 项全部通过，18.344 秒；本机 Ctrl/拖拽实际按下、helper 被终止与 guardian 释放均有证据，未关闭本地接管保护 |
| `npm run test:remote-control` | 构建通过；当时 26 项 Node 测试全部通过，原生 22 项中 19 通过、3 项真实注入按默认参数跳过，17.469 秒 |
| 补充“服务端先暂停、原生释放回执迟到/缺失”竞态后 `tsc` 与协调器专项 | 14 项全部通过；真实 WebCrypto 签名和 JOSE 许可验签，云端/原生端口为受控替身；覆盖绑定篡改、停止/换号/共享变化、迟到响应、取消/过期、续租与暂停竞争及清理失败 |
| 新增原生 Pause 专项 | 增加重复 close-only Pause 的验证后，重新以 /W4 /WX 构建，1 项通过，0.703 秒；未注入键鼠 |

本批没有重新运行真实键鼠注入；第三批实机证据与本批无输入专项分别记录。尚需接通主进程生命周期与采集 handler、可靠定向签名信令、控制视图和两机联调；不得将 `inputGrant()` 直接暴露给 Renderer，也不得以服务端 ACTIVE 代替 B 原生 READY。

## 第五批：签名信令与被控端 transport

本批推进主进程接线的前置通道，尚未修改 `main.ts`/preload 和会议页面；仍不能宣称用户可端到端远程操作。新增 `signals.ts` 与 `target-transport.ts`，并为授权协调器提供仅主进程可用的固定信令构造/签名方法，B 私钥仍不离开主进程。

- 固定字段、独立 audience 的 P-256 信令覆盖房间/SID、会话、共享实例/轨道、双方 identity、epoch、输入代次和序号；大小/未知字段/方向严格检查。接收端同时约束 SDK participant identity/SID 与控制者签名，不依赖 SDK 未提供的 destination 字段。
- B 定向发出存活挑战，A 的已签名 HELLO 表明视频和输入焦点就绪后才调用原生 Arm；收到原生 challenge/armed 后签名 READY。HTTP ACTIVE 或普通 heartbeat 均不能开放输入。
- A 焦点挂起立即关闭输入，等待 native cleanup=1 才发 SUSPEND_ACK 和一次性恢复挑战；恢复分配新 inputGeneration，旧代次输入丢弃。B 业务暂停与这一捕获状态分开，A 不能自行清除业务 PAUSED。
- 信令与原生输入具有独立挑战/序号/ACK；只有 native inputAck 能生成执行 INPUT_ACK。健康 heartbeat 不冒充执行回执。业务 epoch 更新时重建信令游标、输入代次与挑战；普通暂停不重置信令序号。
- 收发队列有数量、250 ms 等待预算和独立计时检查，连永不返回的 publish Promise 也会导致关门；3 秒无有效 A 存活结束，原生暂停/Arm 回执缺失则阻断。未交给 transport 的陈旧 READY 不消费可见序号。
- 原生补充处理“本地接管后，已在途的 A Suspend 才到达”竞态：保持 B 的暂停和同意失效，不恢复输入；原生专项覆盖暂停后迟到 Suspend 与再次 Arm 拒绝。
- 服务端能力响应新增 `self.identity/participantSid/screenTrackSids`，只取可信 LiveKit 当前连接、有效共享权限和未静音屏幕轨道，供下一步 main 在发布回执时验证归属。该证据不证明像素来自某显示器；主进程仍须保留采集实例、原生源选择和发布生命周期的完整绑定。
- 最后一次组合回归期间 Windows 进入锁屏。诊断发现 `LockScreenBackstopFrame` 遮挡停止按钮；原 UI 门已拒绝同意，但仅检查输入桌面名称为 Default 不足以识别这一状态。现补充当前进程所属 WTS 会话的 Active/Unlocked 检查，贯穿启动 ready、同意、Arm、输入前后、监督及非空台账释放；未知/断开/锁屏均关闭。仅空台账可在锁屏时无注入地确认清理，已出现负值的 cleanup 不升级为成功。
- helper 内嵌 Windows 10/11、asInvoker/uiAccess=false manifest，版本不支持则拒绝；避免 Windows 7 锁定标志反转问题。新增只读 `--session-state` 探针和明确要求已锁屏的负向用例。UI 拒绝原因现在区分同意到期、桌面不可用与控制条被遮挡等原因；诊断不记录其他应用文本或输入。

### 本批验证

| 检查 | 结果及边界 |
| --- | --- |
| 后端远控/API/签名回归 | 39 项通过，56.06 秒；新增当前账号轨道归属、摄像头/静音轨道排除和共享权限撤回；独立 PostgreSQL/Redis，LiveKit IO 仍为替身 |
| `npm run test:remote-control` | C++ /W4 /WX、tsc 通过；当时 35 项 Node 测试通过，原生 22 项中 19 通过、3 项真实注入按默认参数跳过，17.688 秒 |
| 补充挂起 publish、视频丢失和 60 秒空闲后 transport 专项 | 11 项通过；真实 WebCrypto 验签，但原生与网络为受控端口；60 秒为模拟单调时钟，仅证明此模块不会因缺少输入 ACK 误停，不等同于两机/原生实机空闲验收 |
| 最终授权 + transport 专项 | 26 项通过，含恢复证明与在途签名心跳竞争；tsc 通过 |
| 最后一次全 Node 组合回归（WTS 补丁前） | 39 项中 38 通过、1 项原生确认超时；补诊断后确认因 Windows 锁屏层遮挡，未记为全绿。普通置顶窗口的初始推测被只读 HWND 类诊断否定，相关推测性 z-order 修改已撤去 |
| WTS 补丁后 C++ 构建、锁屏只读探针与负向测试 | /W4 /WX 通过；探针返回 `locked/defaultDesktop=false`；`python native/remote-input/test_locked_session.py -v` 1 项通过，0.254 秒，实际锁屏时不报告 ready、不接受 Arm，空台账 guardian cleanup=1，无键鼠注入 |
| 修改后端模块/测试的 Ruff | 本机 Ruff 0.16.4 全部通过；验证容器未安装 Ruff，未把该容器命令失败写为通过 |

WTS 字段语义依据 [WTSINFOEX_LEVEL1_W](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w)，查询与缓冲区释放依据 [WTSQuerySessionInformationW](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsquerysessioninformationw)，版本检查依赖 [IsWindows10OrGreater 的 manifest 要求](https://learn.microsoft.com/en-us/windows/win32/api/versionhelpers/nf-versionhelpers-iswindows10orgreater)。本次只证明当前已锁屏条件下的拒绝；切换瞬间竞态、WTS 服务故障/调用阻塞、每次输入查询的性能及解锁后的正常操作尚待矩阵验证。

下一步仍需把上述模块装配到 Electron 生命周期与受限 IPC，接通可信采集/轨道发布确认、A 浏览器控制视图及 LiveKit 定向适配器，再完成两台独立设备、三参会者路由和完整故障矩阵。现有绿色测试不替代这些交付条件；本机解锁前继续不依赖交互桌面的实现。

## 第六批：Electron 与被控端会议页面接入

本批已经修改 `main.ts`、preload 和实际 `Conference` 组件。被控端 B 的代码调用链已连接：会议能力登记 → 申请提示 → 主进程读取申请 → 整屏选择与新轨道归属验证 → 原生确认/短租约 → 签名 transport → 定向 LiveKit 转发。控制端 A 的完整入口和输入视图尚未实现，因此这仍是实施中的一部分，不是两机端到端验收通过。

- 新增每窗口 `RemoteDesktopRuntime`，主进程生成会议上下文 ID、设备会话 ID；使用固定服务的 `self.identity/participantSid` 对照本机登录 subject/epoch。IPC 仅接受规定字段及当前上下文，不接收授权布尔值、任意坐标、原生句柄或私钥。
- `capabilities` 同时维持页面与主进程上下文；页面约每 6 秒刷新一次，主进程 12 秒未收到有效刷新则清理。能力探测新增原生只读 `--probe`，不启动 UI、hooks 或 guardian。真正处理申请时才启动 worker，结束后等待 guardian 管道关闭，最多 5 秒；不确认或失败的 cleanup 在同一主进程跨新会话保持阻断。
- 采集 handler 在媒体回调之前记录所选全屏的真实显示器绑定。远控准备只显示整屏；普通共享仍可选窗口，全部显示器均保留，普通窗口列表保留数量上限。选择前读取已有服务端屏幕 SID 并淘汰，阻止旧窗口/旧共享轨道复用；发布后必须是当前账号/连接唯一有效的新屏幕轨道。关闭、换号、替换采集或迟到 HTTP 返回均不能恢复旧绑定。
- 上述轨道验证证明当前连接归属和采集生命周期关联，不把 Renderer 提供的发布引用或 LiveKit 的 SCREEN_SHARE 标签当成像素来源证明，也不把自报原生能力当作原生设备证明。真实两机的所选显示器/视频/输入一致性仍须验收。
- preload 提供 `capabilities`、`showRequest`、`bindPublishedTrack`、`forwardSignedMessage`、`stop`、`onState`；每项经主 frame、来源、账号、参数数量及字段检查。B 的签名出站消息只允许送到固定目标 identity，只有 Renderer 等到 SDK `publishData` Promise 完成并回传对应消息 ID 才算交给 transport；250 ms 超时或失败结束，不能用 IPC 投递成功冒充 SDK 完成，更不能冒充输入执行 ACK。
- main 已接入退出账号/换号、重载/导航、Renderer 崩溃、离会/重连、锁屏/休眠/会话切换、显示器增删与属性变化。退出/重载显式等待 guardian 结果；前端停止共享按钮先发关门请求，另监听 track ended、unpublished、muted 作为生命周期回收。
- `RemoteControlProvider` 安装在 `LiveKitRoom` 内，覆盖会议和通话布局。B 可查看/拒绝申请；未共享整屏时另一次用户点击触发屏幕选择，以保留真实手势。最终同意与恢复仍仅发生在原生窗口/状态条。UI 展示准备、待确认、已授权、暂停、释放确认和阻断，补齐中英法德荷五种文案。
- SDK 的无 participant 服务端通知只触发 HTTP 刷新；普通数据包保留实际 participant identity/SID，经主进程签名检查才进入 native。重连立即丢弃旧上下文，不能自动续上旧许可。

### 本批验证与未通过记录

| 检查 | 结果及边界 |
| --- | --- |
| 用户提供约 20 秒、已解锁时运行原生 `--inject` | 22 项运行 17.195 秒，17 通过、5 失败：2 项出现 `local_takeover`，3 项未取得测试前台窗口，未进入实际按下验证；未关闭本地接管保护。本轮不认定当前 WTS 版本的实际释放验收通过，保留 `200620538` 基线的既有通过记录但不替代新版本验收 |
| 原生新增只读 probe 与 C++ /W4 /WX 构建 | 构建通过；只读探测可返回物理显示器和当前 ready；不启动控制会话、无输入注入 |
| 桌面授权、信令、采集绑定、云端互验和新 runtime 测试 | 44 项通过；新增 8 项覆盖换号迟到响应、旧轨道复用、多屏幕轨道歧义、换源竞态、旧 picker、原生启动期间关闭、cleanup 跨会话阻断和恶意额外 IPC 字段 |
| 桌面普通 `npm test` | build:main 通过；70 项中 69 通过、1 项既有 packaged stdio adapter 实机用例按默认条件跳过，3.828 秒；未将该跳过项或远控 native 集成计入普通测试通过数 |
| 最后补充 IPC 错误码白名单后 `tsc` 与 runtime 专项 | 9 项通过；未知错误即便仅含小写字母也不直接返回 Renderer，固定映射为 `remote_unavailable` |
| 原生 probe/shutdown 两项集成测试 | 2 项通过。运行时系统已再次锁屏，shutdown 用例明确覆盖 `hello.ready=false` 的拒绝初始化后 guardian cleanup=1 与重复 shutdown；未尝试同意/Arm/输入，不算解锁后的正常操作证据。首次把该用例限制成 ready 成功时因锁屏失败，现按其“关闭等待”目的分别断言拒绝初始化与最终清理，既有正向 ready/Arm 测试仍保留 |
| 前端被控 Provider 与定向 SDK adapter | 9 项通过；覆盖功能关闭时不显示、查看申请不自动捕获、独立手势、发布/媒体停止、停止共享前关门、无签名通知仅刷新、重连/卸载回收、固定单目标、SDK 完成前不 ACK 以及发送失败。使用 SDK/桥替身，非真实网络 |
| 前端 TypeScript / 新文件与共享按钮 ESLint | 通过；补全测试桥类型与 effect 的账号 ID 依赖后通过 |
| 前端 `npm run build` | 通过（Panda codegen、tsc -b、Vite；Vite 34.22 秒）；仍有项目大 chunk 提示。复用了已安装依赖的 junction，不是锁文件独立安装的可复现交付证据 |
| JSON / 语言结构校验 | 135 个 JSON 可解析；五种语言结构校验通过 |

原生资源打包/签名尚未接入正式安装流程，dev 使用 `dist/remote-input`，打包版固定查找 `resources/remote-input`，缺失或摘要错误则不声明可被控。后续继续实现 A 的专用控制视图、临时签名密钥、输入编码/队列、视频与焦点健康、ACK/心跳/挂起恢复；再完成真实双机/三参会者、原生全部故障窗口及安装升级等首期门禁。功能配置仍默认关闭，未部署。

## 第七批：PC 控制端、焦点恢复与共享源分页

本批接入实际参会者菜单、会议 Provider 和控制视图。支持代码路径为 PC Chrome/Edge/Electron 发起申请，B 仍须在 Windows 原生窗口确认；未启用全局或组织开关，未部署。当前实现和受控测试不能替代两台独立设备上的验收。

- `ControllerSession` 每次申请创建不可导出的临时私钥，核对请求摘要、双方用户/identity/SID、设备会话、共享实例、轨道及显示器摘要。激活前验证固定服务公钥签发的完整许可，扣除整个 HTTP 耗时与一秒时间量化预算；单靠 HTTP ACTIVE 不创建输入许可。取消时迟到的申请响应只在原登录/会议上下文中按原会话 ID 清理。
- `ControllerTransport` 与 B 复用严格签名信封和固定输入协议。显式开始、当前可见画面、页面/捕获焦点、短许可和 B 原生 READY 同时满足才输入。失焦立即停止采集，等待释放回执后才能以新 inputGeneration 恢复；B 的 PAUSED 仍须 B 再次确认并递增业务 epoch。
- 输入与心跳各自计数；输入累计回执只清除对应待确认项，最老未确认项按首次发送时间在一秒超时。心跳回执不延长输入期限；有健康心跳的纯空闲不要求输入 ACK。签名和 SDK publish 队列受数量与 250 ms 时限约束，挂起的 Promise 也会触发结束，不重试或回放输入。
- 专用视图固定订阅绑定屏幕轨道，依据实际解码帧、媒体状态、尺寸比例和页面焦点判断是否可操作。进入视图或返回焦点不会自动开始；缩小视图保留视频但暂停捕获。输入监听只挂在操作区，聊天、工具栏与文本框不会成为远端按键；Esc 本地暂停，远端 Esc/Enter 等用明确按钮提交。
- CSS `object-fit: contain` 坐标映射排除黑边，不重复乘 DPR。只有未签名且未编号的鼠标移动可合并；待发送移动绑定 inputGeneration，不能跨暂停/恢复发送。左右修饰键、重复按键和扩展扫描码保留，系统及紧急组合拒绝转发。
- 中文在本地文本框 composition，明确点击后通过一次性 READY 握手提交，最后一项原生执行 ACK 到达才清空草稿并挂起。提交中禁止编辑和重复发送；未确认时保留草稿并提示核对远端画面，绝不自动补发。快捷键的早期 key-down ACK 不结束尚未完成的 key-up 序列。
- 修正 B 在视频丢失后进入 PAUSED 时漏发 HEARTBEAT_ACK 的问题，暂停期间仍确认有效心跳。初次订阅尚无解码帧时 A 不把它报告为已确认视频丢失，也不开放输入；双方三秒存活时限仍有效。
- 普通共享改为原生分页选择全部合法 screen/window 源，每页六项，取消为默认项。屏幕标签包含稳定 display ID、尺寸/缩放和位置，同名显示器可区分；远控准备只列整屏。翻页、选择返回及重新枚举后均检查原捕获上下文，取消、源消失、重复 ID、越界响应不能选中。此处替代第六批“只保留前 20 个窗口”的临时实现。
- 补齐中英法德荷五种控制端文案，增加前端明确的 JOSE 依赖及共享协议类型检查范围。

### 本批验证与边界

| 检查 | 结果及边界 |
| --- | --- |
| 控制端会话、A/B transport 互通及原 B transport 专项 | 29 项通过，1.708 秒；真实 WebCrypto/JOSE 签名，HTTP、SDK 网络和 native 为受控端口；包括迟到响应、绑定篡改、无签名 ACTIVE、回执期限、暂停心跳、一次性文本/快捷键、失焦后迟到 READY，以及模拟时钟 60 秒空闲 |
| 桌面 `npm test` | `build:main` 通过，92 项中 91 通过、1 项既有 packaged stdio adapter 按默认条件跳过，4.148 秒；不包含完整 native 实机回归 |
| 共享选择器最终专项 | tsc 通过；3 项通过，覆盖 27 个窗口分页、同名/负坐标屏幕、整屏限制、上下文失效、取消、重复 ID 和非法选择响应；原生对话框展示仍需解锁后检查 |
| 前端远控专项 | 原 B/定向转发 9 项、输入映射 3 项、控制视图 5 项、A Provider 5 项分别通过，共 22 项；JSDOM 与 SDK/会话替身，未宣称真实网络或画面回归 |
| 前端 TypeScript / ESLint / JSON / 语言结构 | 通过；135 个 JSON 可解析，五种语言结构检查通过 |
| 前端生产构建 | Panda codegen、tsc -b、Vite 通过，Vite 26.76 秒；保留现有大 chunk 和两项静态资源运行时解析提示。仍使用已安装依赖 junction，不是独立锁文件安装的可复现发布证据 |
| Windows 状态 | 用户表示方便解锁后，实际只读 `--session-state` 多次仍返回 `locked/defaultDesktop=false`；未运行正向原生 UI 或输入注入，已请求用户在本机完成手动解锁 |

尚待验证：真实静态共享画面 60 秒时解码帧健康判断、A Chrome/Edge/Electron 与 B 两机远程网络、A/B/C 定向隔离、真实中文/拖拽/双击/常用应用、原生完整故障窗口及性能矩阵。审计保留与管理策略、资源打包签名、独立依赖安装和安装升级流程仍需后续完成；本批通过不改变设计中的首期交付门槛。

## 第八批：审计保留、分页与解锁后原生回归

控制端与共享选择器已提交为 `228d681`。随后检查发现现有房间外键 CASCADE 会绕过审计保留期，审计读取也静默截断至 200 条，本批修复这两项。

- 会话保存不可变 `room_reference`；房间关联改为可空 SET_NULL。新增 `0224_remote_control_retained_room` 迁移，先回填已有房间 ID 再设为必填，不修改历史请求/签名绑定。Room 模型或 QuerySet 删除均在原事务中结束活动许可并记录 `room_deleted`，删除后历史仍属于原组织。
- 审计权限继续要求该组织有效 owner/admin，人类账号及组织有效性均校验。房间删除后可凭原房间 ID 和会话 ID 查询；普通参与者、其他组织管理员及已停用成员不能读取。返回受控的用户/房间/设备会话/协议版本关联，不返回许可、挑战、签名、公钥绑定或输入内容。
- `GET .../remote-control/{sessionId}/audit/?limit=100&after={eventId}` 返回 `events`、`nextCursor` 和 `session` 关联摘要。每页默认 100、最多 200，按 `created_at,id` 排序；下一次使用 `nextCursor`，为 null 时已读完。游标必须属于同一授权会话，未知参数和非法页大小拒绝；同时间戳记录可完整遍历。
- 新增 `DJANGO_REMOTE_CONTROL_AUDIT_RETENTION_DAYS`，默认 90，允许整数 1～3650；非法值使清理任务报配置错误而不删除数据。既有定时任务只删除达到期限的终态会话；开放状态不因历史时间字段异常而删除。过期临时能力与挑战仍走既有短期清理。

| 检查 | 结果及边界 |
| --- | --- |
| PostgreSQL/Redis 隔离后端回归 | 48 项通过，48.03 秒；包含新增 9 项审计保留/权限/分页/配置用例，261 条同时间戳事件全部可翻页；LiveKit IO 为替身 |
| 模型与迁移 | `makemigrations core --check --dry-run` 返回无模型差异；测试数据库已执行新迁移。隔离容器的常规开发数据库仍提示该迁移未应用，未修改部署环境 |
| Ruff | 修改的服务/API/AppConfig/新迁移/审计测试检查和格式校验通过 |
| 用户明确回复已解锁后的只读状态 | `unlocked/defaultDesktop=true` |
| 原生 Node 集成 | 5 项全部通过，1.162 秒；包括真实原生确认后 WebCrypto→CNG 心跳、输入缺口拒绝与 guardian 清理，本次未实际注入键鼠 |
| 原生默认回归 | 22 项，19 通过、3 项实际输入测试按默认配置跳过，17.278 秒；解锁后的同意到期、绑定变更、负坐标确认窗、暂停恢复、控制条防护、helper/guardian/父进程监督通过 |
| Electron 显示器映射探针 | Electron 44.4.3，退出码 0；两块 3840×2160 / 150% 屏幕，其中副屏物理 left=-3840、DIP x=-2560，映射一致；最终清理成功 |

第八批的默认回归未执行 3 项实际输入测试；用户随后提供约 10 秒空闲桌面，补测结果见第九批。原生资源正式签名、管理策略入口、真实网络/多设备和完整性能故障矩阵仍未完成，功能保持默认关闭。

## 第九批：当前原生版本实际释放与打包完整性

用户确认可留出 10 秒后，立即串行运行当前 WTS 版本的三项实际输入专项，2.208 秒内全部通过。`GetAsyncKeyState` 确认 Ctrl 或鼠标左键已实际按下，再强制终止 worker；独立 guardian 释放对应按键并返回 cleanup=1。覆盖主屏 Ctrl、主屏拖拽及物理负坐标副屏拖拽，未改变本地接管保护。完成后已告知用户可继续操作电脑。该结果补齐第六、八批尚缺的三项当前版本正向证据，保留此前受本地接管/前台窗口影响的失败记录，不据此宣称完整故障矩阵通过。

- 打包前核对原生构建清单与五个源文件摘要；独立 staging 副本先签名，再生成最终 EXE 和清单摘要。原始开发构建保持可用。固定文件名排除后续自动重签；拒绝可能覆盖该排除规则的正向签名配置。
- `extraResources` 只包含固定 helper 与清单；最终摘要描述符进入 `app.asar`。主进程在能力探测及每次启动 helper 前校验包内固定摘要、外部资源完整清单、大小和普通文件类型。缺失描述符、额外资源或完整性不符均不开放原生能力。开发环境允许独立构建清单；打包环境不可回退到该模式。
- 正式发布要求 helper 的 Authenticode 为 Valid，安装器与 helper 证书指纹一致；发布清单记录实际包内摘要、资源核对和签名结果。ASAR 固定摘要解决外部 EXE 与外部清单同时被替换的问题；不声称能防御拥有整个应用代码改写权限的攻击者。
- 增加真实 Electron Builder 打包冒烟脚本：构建隔离最小应用，以打包后 Electron 调用真实 helper 只读 probe，再同时篡改外部 EXE/清单并验证拒绝，最后恢复原字节。此应用不建立会议、不安装软件、不注入输入。

| 检查 | 结果及边界 |
| --- | --- |
| 三项原生 `--inject` 专项 | `test_guardian_releases_held_key_after_worker_kill`、`test_guardian_releases_drag_after_worker_kill`、`test_real_drag_and_release_on_negative_monitor` 全部通过，2.208 秒；真实 Win32 按下与释放 |
| 打包与 runtime 专项 | 14 项通过；包括真实 ASAR、先签后摘要、过期源构建、缺失固定摘要、未签名正式发布拒绝、资源缺失/多余和双重篡改 |
| 桌面 `npm test` | build:main 通过；97 项中 96 通过、1 项既有 packaged stdio adapter 按默认条件跳过，4.059 秒；随后增加签名配置断言，打包专项 5 项再次通过，0.349 秒 |
| 实际打包后运行 | Electron 44.4.3 / Electron Builder 26.15.3，`app.isPackaged=true`；真实 helper 返回 ready=true、两个显示器；双重篡改返回 `native_integrity_failed`；恢复后包内资源核对通过 |
| 真实未签名正式门禁 | 当前 helper 的 Authenticode 为 NotSigned，正式 staging 被拒绝；未配置代码签名证书，不伪称完成正式签名 |

实际打包证据位于桌面目录下忽略的 `test-results/remote-input-package-aXQ0fz/report.json`。本批测试包不是完整会议应用安装器，尚需完整应用构建、安装/升级/卸载及独立依赖安装验证；运行时依赖仍来自既有 junction。正式证书、真实双机会议、管理配置和完整原生故障/性能矩阵仍待完成，未启用生产功能。
