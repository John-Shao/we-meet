# Work R0b 体验与验证详细设计（2026-10-30）

> 本文是目标体验与待执行验收规格，不是实现、测量或签收报告。项目状态、责任人落实与准入结论只查 [work-project](work-project.md)，本文不复制其状态。
> 下文实施步骤须另获实施授权；本文不构成产品代码、权限或部署变更的批准。

## 1. 目的

### 1.1 权威与范围

以已完整阅读的 [R0b 架构](work-r0b-architecture-2026-10-30.md) §1/B01–B10、§3 不变量和 §4 决策为本轮权威；承接 [产品](work-product-design-2026-10-25.md) §19.2/§19.10 及 [UX](work-ux-design-r0-2026-10-25.md) §5.2/§6.5–§6.7/§8。
细节分工：[device](work-r0b-device-design-2026-10-30.md) §2身份、§3租约、§4工具、§5模型外发、§6日志、§7成果；[control](work-r0b-control-design-2026-10-30.md) §1合同、§2治理权限、§3Host写、§4数据命令、§5审批、§6撤权编排、§7成果同步、§8配额审计。本文引用文件，不假定兄弟文档锚点。
继承 [D-08](work-r0a-provider-account-metering-decision-2026-10-26.md) 的客户自带账号与 token 计量，以及 [Host wire](work-r0a-host-wire-decision-2026-10-28.md) 的身份、成员和席位权威；早期 UX 的“换设备继续”“金额预算”“移动审批”“管理员天然写权”不作为实现依据。

- 必选闭环：Windows x64 当前桌面提交 → 选择并授权文件夹 → 类型化读取/检索 → 审批及受控模型调用 → 新文本成果 → 本机预览/采纳 → 可选独立云同步。
- 来源仅 UTF-8 TXT/Markdown/CSV/JSON；“整理”输出索引、要点和分类建议，不原地移动、改名、改写或删除来源。不开放 Shell、脚本、Office/PDF/OCR、浏览器控制或插件发现。
- 治理采用细分可委派权限，不给任何内置角色预置新增治理权；owner 显式委派。必选任务页待审批/重授权；简单计划、只读复核、执行档位、移动写操作、独立 Inbox/SSE 后置。
- 本轮不前移远程派发、连接器、项目/DAG、分享、富成果或自动化。macOS/ARM64 未通过各自安装隔离矩阵前不开放本机执行。

### 1.2 已读集成输入与必须补齐的差异

以下路径相对仓库根 `D:/workspace/we-meet/we-meet/`，仅指实施落点，不表示本轮修改：

| 既有位置 | 已观察行为 | R0b 实施要求 |
|---|---|---|
| `src/frontend/src/features/work/r0a/WorkApp.tsx`、`routes/WorkHomePage.tsx` | `/work`、`/work/new`、`/work/items/:taskId`；bootstrap 的 403 被合并为无席位 | 拆分拒绝原因；治理入口不经过执行席位门；保留既有路由 |
| 同目录 `components/Composer.tsx`、`api/types.ts`、`api/queries.ts` | 云端 input→preview→submit；标量计数但原生 maxLength 按 UTF-16；bootstrap 缓存五分钟 | 增加本机 profile/本地正文分支；废止错误长度截断；写前重新鉴权，不将缓存当许可 |
| 同目录 `routes/TaskWorkspacePage.tsx`、`hooks/useTaskEventStream.ts` | 快照+任务 SSE，已有游标重同步；采纳主要按 task_state 判断 | 加入审批/恢复投影与静止门槛；事件不携正文；保留旧云端重同步行为 |
| 同目录 `components/ArtifactPanel.tsx`、`hooks/useReadOnlyViewport.ts` | 成果默认 HTTP 正文/下载；窄屏隐藏写入口 | 按存储位置选择本机/云端正文；跨端 local-only 禁止取正文；窄屏规则不代替鉴权 |
| `src/frontend/src/features/admin/layout/AdminShell.tsx`、`api/adminMembers.ts` | 导航按权限/组织管理员过滤；成员生命周期接口不是 Work 席位写合同 | 增加细分 Work 治理区块；不得把现有成员 PATCH 当席位开关 |
| `src/desktop/src/preload.ts`、`src/frontend/src/vite-env.d.ts` | 有安全窄桥接，无 Work Broker 能力接口 | 增加经协商的 Work 窄 IPC；不得复用会议远控作为本机执行通道 |
| `src/work/internal/api/bootstrap.go` | 仅 R0a/cloud/text-v1，goal 2000、background 4000、artifact 262144 bytes | 兼容保留旧云端合同；本机新合同必须显式协商，不能单加一个按钮 |

## 2. 入口与首次使用

### 2.1 能力交集与路由

个人执行入口取组织启用、当前 Host 成员/席位、资源权限、实时策略、版本能力、当前设备会话的交集；提交后还受目录许可、Run/lease、审批和配额约束。服务端在每次写与派发重新判断；前端隐藏/禁用只负责解释。
沿用 `/work` 新建、`/work/items?view=pending` 待处理和 `/work/items/:taskId` 工作区；治理置于现有 `/admin` 下独立 Work 区块，不由个人bootstrap的席位拒绝挡住。新增页面路由明确为 `/admin/work`（获权概览）、`/admin/work/seats`（席位）、`/admin/work/quotas`（token护栏/用量）、`/admin/work/policies`（本机策略）、`/admin/work/audit`（审计/导出）、`/admin/work/delegations`（owner委派）、`/admin/work/models`（owner模型配置）。页面调用control §1/§8.4的对应v2 API，GET不具权限显示明确403而非空数据；owner委派/模型入口按独立owner能力，不要求seat或其他Work写权。各表格均有loading/empty/error/revision-conflict状态，保存成功以权威revision或change.applied为准，pending/reconcile必须保留查询入口。

| 进入条件 | 可见状态与下一步 | 禁止行为 |
|---|---|---|
| 组织未开通/服务方停用 | 隐藏个人新建；直链解释组织原因及联系路径；治理按独立权限提供必要读取 | 不显示空 Composer，不让组织管理员解除服务方停用。Host 组织停用与 Work 服务方停用都显示“联系服务方”；服务方在 Host 恢复后自动可用，但旧任务不续跑、设备需重新连接 |
| 活跃成员无席位 | 显示申请席位说明及组织配置的联系人；无申请 API 时仅联系，不造“申请已提交” | 不误报为断网；不阻断合法无席位治理者 |
| 会话失效/Host 不可验证 | 分别显示重新登录/暂不可验证；关闭写操作 | 不缓存正向鉴权放行，不把所有 403 写成无席位 |
| 浏览器桌面，无本机桥接 | 云端可用则保留云端；本机仅安装/能力说明，不提供可发送选项 | 不接受用户填写 device_id 进行派发 |
| Windows x64，设备配对与能力齐备 | 可选“本机·当前设备”；发送前仍须目录授权与预览 | 不列远程设备选择器；知道设备 ID 不等于当前设备提交 |
| Agent 离线/许可丢失 | 草稿保留在当前账号设备；显示连接/重新授权；发送禁用 | 不自动切云端，不后台排队等另一设备代跑 |
| 版本不兼容/其他平台 | 显示不兼容项与经验证发布渠道；不兼容能力只读 | 不用普通宿主 Node、旧工具 manifest 或降低隔离兜底 |
| 手机或只读客户端 | 沿用任务/成果只读；local-only 仅元数据，提示回原设备 | 不创建、编辑、审批、取消、采纳或同步；拉宽视口不产生桌面身份 |
| 无任何可用执行位置 | 环境说明页与联系/安装路径，保留合法历史读取 | 不展示不可兑现的模板发送入口 |

### 2.2 三步引导与目录选择

1. 首次进入时先检查资格，再介绍执行位置；默认云端仅在云端确实可用时成立。引导按 subject/org/说明版本记录完成或跳过，不保存来源正文；帮助可重看。
2. 第二步说明读取范围、审批、模型目的地、成果去向和撤销入口；明确“原文件不上传；选定摘录可能发送到已批准模型；成果同步需另行同意”。不能只说“本机执行所以数据不外发”。
3. 第三步从服务端支持的模板预填；本机提供资料整理变体，模板不是技能/套件。跳过、选模板、安装完成、配对成功、文件夹授权成功均不得自动提交。
4. 选择本机后，由真实用户手势调用系统选择器；本期工作文件夹内只读来源，输出进入 `WeMeet成果`。本机可确认真实目录；云端仅收随机 root_ref/resource_ref 和用户确认的安全别名，默认别名不采用文件名。
5. 提交前预览必须列当前设备、目录别名、格式范围、工具能力、逐次审批、模型路由/分类、token 硬上限、本机成果位置和“未开启云同步”；目录许可不是模型外发或上传授权。**还必须列“本任务成果的分类下限与同步可行性”（控制面 §1.2 `artifact_classification_floor`，J15）：所选根含 `local_only` 时显示“本任务成果将只留本机、不可云同步（连只列目录也算触碰）”，并给“改选允许脱敏摘录的目录后重做任务”这一真实出口；不得等到成果生成、用户点同步时才第一次告知。** **第十轮 R10A-5 补：本步同时是目的地告警的唯一文案出处**——预览必须列出可用目的地集合，以及被禁目的地与其 `unavailable_reason`（枚举定义在控制面 §1.2，本处只管句子）。**两句子的载体不同，第十一轮 R11A-3 分开写明**：`no_device_destination` 是**预览响应**里的拒绝＋建议（此时还没有 Run，这是预览期唯一可判定的原因）；**run 级目的地不可用**（不是枚举成员：该值已在第十一轮 R11A-3 从 §1.2 闭集删除，机器可读的拒绝码是 §9 `destination_not_allowed_for_local_only`）——**不是预览响应字段**，它是 **Run 进行中的状态**，由 §3.2 的审批/确认卡片必列项承担，控制面在 `prepare_local_operation` 拒绝时以 `destination_not_allowed_for_local_only` 表达。句子本身：`no_device_destination` →「本任务选择了只留本机的目录，而组织没有提供任何设备内模型目的地；请改选允许脱敏摘录的目录，或联系管理员开通设备内执行」；**第十一轮 R11C-7：后半句只在"该组织可以发布 `device_local`"时才允许出现——RB-A20 三要素不齐、§8.4 判定 device_local 不可发布的组织，界面上必须去掉"联系管理员开通"这半个出口，只留"请改选允许脱敏摘录的目录"，并把不可发布的原因显示出来（架构 §1.1 已把这条前提写死）。给不了真出口的按钮就是 B08 禁止的假入口**；run 级不可用 →「本 Run 已读取只留本机的目录内容，之后的设备外模型目的地不可用；可结束本 Run 后另建任务」。两者都只给"改选/联系管理员/结束本 Run"这类真实可走的出口，**不给"我已知晓，继续"的绕过入口**（B08 无假入口）；实现期不得另造句子。**第十四轮 J37 补第三种未就绪态（与上面两种分列，不得合并成一句模糊提示）**：组织已配映射、但没有任何规则产出可外发根、也没有可用的 `device_local` profile（**`org_private` 不算**——第二十一轮按本机 §5.1 更正：`local_only` 目录的正文一律不得发往 `org_private`；第二十三轮把本文件里残留的两处也改齐） ⇒ 用户根本走不到预览步，**选目录入口置灰并显示「管理员尚未放宽任何一个根，本机任务暂不可用」**，指向管理员而非给用户自选控件（J19）；`local_policy_not_configured` 的句子仍是「联系管理员配置目录分类策略」（= 没配），两者合并会让管理员分不清自己是"没配"还是"配得太严"，而这正是两种不同的修复动作。
6. 取消选择器不改变旧许可；重选根、变更账号、Agent 重启或许可撤销使相应预览失效。重启先对账旧 journal，再要求重新授权；重新选中同一路径也不是恢复旧许可。
7. UI 写“仅在授权范围内执行，隔离能力须通过安装验证”，不宣传绝对安全；引导可跳过，具体目录、外发、同步授权不可被跳过替代。

### 2.3 草稿与可访问性

本机草稿、来源摘要和摘录仅存账号/组织隔离的 Broker 本机存储，不写主窗口存储；用户在 Composer 输入的目标文本交给 Broker 后主窗口即清空（device §1.1）。登出清除渲染缓存及授权，另一账号不能恢复。环境切换保留可编辑用户输入，但本机内容转入云端须先明确确认新的数据去向，不复制路径、摘录或同步授权。
键盘可完成模板、文件夹、预览和审批；模态进入后约束焦点，关闭回触发点，Esc 不代表批准。本机内容窗口打开与关闭时焦点在主窗口触发点和新窗口之间往返，读屏能识别"本机内容窗口"标题。新审批用 `aria-live=polite` 通知而不抢焦点；拒绝/危险动作不以颜色单独区分。网络不明时宣布“等待确认”，不得宣布成功。

## 3. 页面状态与审批治理

### 3.1 事实驱动的任务工作区

显示状态来自权威快照：task/run 状态、wait_reason、blocking_operations、控制 revision、审批 revision、device session、成果存储位置/核账状态及允许动作。下表是显示语义，不自行新增数据库枚举；映射由 control §1/§4 冻结。

| 页面状态 | 展示与可用动作 | 必须守住的事实 |
|---|---|---|
| 草稿/预览中 | 输入计数、边界摘要、返回编辑 | 输入/模板/profile/目录/策略改变即使预览失效 |
| 已提交/排队 | task/run 标识、等待执行、取消请求 | 提交响应丢失查询原幂等键，不生成第二个任务 |
| 执行中 | 类型化动作、时间线、已确认成果；允许请求取消 | SSE 只通知，状态与权限以重取快照为准 |
| 等待审批 | 固定“需要你”横幅，目的/范围/后果；批准或拒绝 | 离开重进仍可取 pending；不依赖独立 Inbox 或新全局 SSE |
| 设备离线/租约失效 | “连接原设备后核对”；可请求取消 | 10s 心跳/30s 租约是架构默认，离线后不领新许可；不自动转云端/换设备 |
| 重启待核对/待重授权 | 先核对记录，再显式重选**同一**目录；选了别的目录时说明“原任务只能结束，可用新目录新建任务” | 旧 boot/session/lease 不能继续；授权不能跳过对账；改绑后未执行步骤重新审批，已执行步骤不重做 |
| 结果未知/无法对账 | “动作可能已执行，正在核对”；仅查询/联系支持 | unknown/unresolved 保留预留，阻断续跑、新 Run、采纳；不提供重新生成绕过 —— **第十二轮 J16 拆成两档**：①「结果未知／正在核对」＝设备侧仍可交回证据（renew lease、journal 上行），界面给「等待核对」；②「**人工核账中·成果暂不可采纳**」＝journal 与外部证据暂不可得、仍在等权威事实的副作用类动作，须显示自 `reconcile_requested_at` 起算的等待时长、受影响的必选结果与 `GET /runs/{id}/reconciliations` 的状态，不得只留一个无解释的「卡住」；③**第十四轮 J38 新增第三档**「**证据已穷尽·无法定论（成果不可采纳，可开新任务）**」＝已签 `operation_resolution{code=evidence_exhausted}` 的 Task 状态：必须显示工单号、穷尽过哪些权威证据源、"为什么不能采纳但能开新 Run"，并给"本机查看/导出"与"另建任务"两个出口；**不得把这一档显示成"失败"或"已完成"**（两个方向都是假信息），也不得出现"重试采纳"或"确认未执行"这类假入口（B08） |
| 模型回答未送达 | “模型已返回并已计量，但回答未到达本机”；可结束运行或重新发送（说明会再次消耗 token，需逐次确认） | 回答不在云端，不提供补取；只有 egress 回执证明成功才显示此状态，否则仍属结果未知 |
| 撤权/取消处理中 | 分开显示“已阻止后续动作”“旧动作核对中” | 取消意图不是完成；已发动作不可承诺撤回，晚到回执仍入账 |
| 明确终止/已失败 | 原因（含“未生成成果”）、可保留成果、处理建议 | 只有确认无未知阻塞且权限仍合法时才允许显式新尝试；模型只回复文字不算成果 |
| token 护栏阻断 | 单 Run/演示周期上限、已用与预留，联系治理者 | 客户周期 soft 告警不能显示成硬耗尽；降低预算不冒充安全撤权 |
| 待验收 | 固定成果版本、预览、采纳 | 需运行静止、blocking_operations=0、核账完成；按钮状态不替代服务端检查 |
| 已采纳/历史只读 | 采纳版本、时间、存储位置；合法查看/导出 | 不改写版本，不因同步失败撤销采纳，不开启后置复核/分享 |
| 快照过期/未知状态 | 刷新状态、只读解释 | 不猜可执行动作；未知 wait_reason 不默认启用“重试” |

重连先取带游标的快照再接任务 SSE；重复/乱序事件不回退 revision，游标过期清空临时时间线并重同步。审批提交前重取权威状态；任务页进入/前台恢复必须查询 pending，SSE 不可用时仍能手动刷新。UI 不使用本地倒计时判定租约或审批有效。

### 3.2 审批交互合同

- 卡片展示 approval_id、Run、工具名称、目录安全别名、目的、风险、拒绝后果、有效期、请求指纹及当前策略限制；不是可编辑 Shell 命令框。**类型化参数（相对路径、搜索词等）与正文预览一律只在 device §1.1 的本机内容窗口展示**；主窗口卡片只放元数据和“在本机查看并决定”入口，参数名不进列表响应、SSE 或审计导出。**审批摩擦的三项可见出口（第十轮 R10A-12：控制面 §5 早就要求这三项，体验面此前一条都没落，导致 B02 的保守设定无人可取证）**：主窗口卡片与本机内容窗口都显示 ①"本次批准剩余时间"、②"本步骤已取代 n/5 次"、③第 6 次取代时的"继续需重新预览，或结束本 Run"出口。显示与判定分离：剩余时间只作展示，有效性一律由服务端 CAS 判定，客户端不得拿本地倒计时当真；三项都是只读事实，**不提供"跳过""强制继续"按钮**。
- “批准本次”仅绑定同一 Operation、完整 request hash、资源/策略 revision 与有效会话；服务端 CAS 选择唯一决定。请求变化、到期、目录变化或撤销后旧批准拒绝并刷新，不偷偷批准新动作。
- “限本 Run 同类只读允许”仅对已批准根、类型化只读工具类和不扩大的 scope 有效；期限取 Run 结束、授权失效、策略上限和 24 小时的最早值，不能跨 Run 继承。**消费点＝控制面 §4.2 `prepare_local_operation` 的只读分支（第十一轮 R11C-1 补：这个"允许"必须真的让后续同类动作跳过询问，否则本条只是界面上的一颗按钮）**。
- **默认档可见性（第十四轮 J39）**：组织默认档分环境——演示与自有组织 `auto_readonly`、客户组织 `ask_each`（定义见控制面 §5）。处于 `auto_readonly` 时，**任务页与每张审批卡片必须显式标注"当前为宽松只读档：只读动作不再逐个确认"**并给"改回逐次确认"入口；用户主动收紧立即生效且写入策略 revision。验收断言：同一夹具在两档下的审批出现次数与 §8.1 计数一致（≈37 对 ≈21），且**宽松档下界面文案不出现"已批准 9 次"这类让用户误以为逐次批过的表述**；缺可见性标注即判该 EV 失败。
- 同类只读许可在任务页可见、可撤销、可审计；撤销即时收窄后续动作，不能撤回已完成读取。不涵盖成果写入、模型外发、同步或人工保存，不提供永久允许。
- “拒绝”是持久决定：本动作不得派发，任务展示无法继续的具体原因；只能由新的合规意图发起新请求，不能把同一被拒动作改 ID 自动重试。
- 模型外发卡片必须在原设备展示本次完整待发内容、来源分类、目的地/model、token/bytes、保留说明和请求指纹；**并展示当前可用目的地集合；本 Run 已 read/search 过 `local_only` 正文时，卡片显示 §2.2 那句 run 级不可用说明（这是该状态的合法载体，不是预览响应字段——第十一轮 R11A-3）**；云端审批只持元数据，不收摘录或提示全文。无正文确认能力的端不提供批准。
- 提交中按钮锁定；超时用原请求 ID 查询决定。多标签页/批准与拒绝竞态返回唯一结果；409 显示“已变化，请重新确认”，不把陈旧乐观成功留在界面。管理权限不能代替任务所有者批准。

### 3.3 成果、同步和跨端

| 情形 | 实施行为 |
|---|---|
| 本机发布 | 只向授权根下 `WeMeet成果` 新建版本；列出版本号、hash、大小、生成 Run、核账事实和 local-only 标签；来源文件 hash 应保持不变 |
| 本机查看/保存 | 任务页显示版本元数据和“在本机查看”；正文在本机内容窗口打开（device §1.1），主窗口不显示正文。Broker 校验当前身份/对象 ACL 与 60s read-ticket，不要求活跃 Run、旧目录 grant 或执行预算；离线不发新票据。打开文件夹/另存为须有用户手势，人工保存不等于模型外发或云同步。正文中的链接和图片不可点击、不加载 |
| 不可变性 | 修改生成新版本，不覆盖旧版本；用户可见副本被改写时提示与原版不同，仍以 sealed blob/manifest 验 hash；封存内容不符才标记不可验证并阻断采纳/同步 |
| 用户保存新版本 | 仅原设备桌面、Run 静止且 **base 版本已核账（所属 Run 无阻塞 Operation）** 时可用（J17 换前置：最新 Run 是否 failed/取消不再决定能否编辑；席位已撤或非原设备仍不显示入口）；在本机内容窗口编辑并确认后发布，版本标“用户修改”，不要求旧目录授权、不计 token。目录授权已失效时版本照常发布，提示“可导出到文件夹”。base 已变化提示冲突，草稿保留。Web/手机/其他设备不显示入口 |
| 采纳 | 不强迫先同步；已核账 local-only 版本可采纳，绑定 artifact/version/hash、task revision 及原设备同 session 的 `PossessionProof(purpose=accept)`（控制面 §1.3，30s）；未解除 unknown 不可绕过 |
| 选择同步 | 逐版本选择、目的地/可见性/大小二次确认；绑定版本 hash 和独立同步授权，不沿用目录或模型批准。存储位置 local-only 不等于来源分类；禁止外发分类未依法产生新披露决定前不能同步，不能追改历史分类 |
| 同步中/失败 | 进度只是传输状态；只有 finalize 及权威元数据确认后标记云端可用。失败保留本机版本；同一上传会话查询/幂等 finalize，不重复生成成果 |
| 其他设备/Web/手机 | local-only 只展示经认可的标题/别名、版本/hash、状态、大小和所在设备标识；不取 goal/background/摘录/正文，不显示无效下载链接，不代理远程读取 |
| 已同步版本 | 按资源权限访问正文，管理权限不增益；本机和云端 hash 一致。同步不自动分享；安全撤权立即阻断后续受控读取，不能收回用户已保存副本 |

### 3.4 治理页面与写操作

权限码及组合采用 control §2：`org.work.seat.read/write`、`org.work.quota.read/write`、`org.work.policy.read/write`、`org.work.usage.read`、`org.work.audit.read/export`（斜线表示独立权限码）；不复活旧 `org.work_grant.write`。新增治理权不预置给 owner/admin/成员等内置角色；owner 显式委派或授予自己，执行新增业务写仍需对应权限，限本组织、不支持 department scope。
新码只在Host独立WorkGovernanceAssignment域中由owner显式授予现有成员；旧AdminRole创建/编辑/分配/复制/导入拒绝Work码，不能用 `org.role.write` 或旧admin通配旁路。旧部门scope聚合不读取Work assignment；前端逐按钮对应read/write/export，不在Work库复制角色真相。必须回归“部门HR+组织Work权限”组合，HR不得被连带扩到全组织。

| 区块/能力 | 可见数据与动作 | 权威及边界 |
|---|---|---|
| 治理概览读取 | 开通状态、席位汇总、按模型用量、待处理治理命令 | 只需对应读权，不需 Work 席位/执行预算；不展示成员正文 |
| owner 委派管理 | 选择成员与细分权限，展示授权来源、范围和撤销影响；确认后提交 | Host 校验 owner 与当前主组织；委派版本化/强审计；不能用旧 admin 通配规则绕过 |
| 席位读/写 | 成员席位、席位上限；逐成员授予/撤销及原因 | Host 成员/席位唯一权威；Work 不直接改 core 表，不写投影冒充已授予 |
| token 护栏读/写 | Run 硬上限、**组织**周期阈值、演示 hard/客户 soft 解释（**用户级阈值不在此页**——RB-A26 已定用户级硬上限不进 R0b，传 `scope=user` 必须 422；此处曾写"用户/组织周期阈值"，属 B08 禁止的假入口，第十轮更正） | 只改允许字段；显示旧值/新值/生效范围；不能新增金额、币种或价表；`scope=user` 的读写请求返回 422 且有负例 |
| 执行策略管理 | 本期执行位置、允许工具/审批收窄、批准模型路由等 | 不展示套件/连接器/分享等后置开关；组织策略不能放宽来源分类或设备隔离 |
| 模型配置 | 批准的本机/私有模型标识、可验证能力、可用性；凭据只写与指纹回读 | 接入配置写继承 D-08 owner-only，不被可委派 policy.write 覆盖；须近期认证、探测/版本审计；不因“本机”跳过在线治理 |
| 审计读取/导出 | 过滤组织/成员/动作/时间，导出必要身份元数据，提示含姓名 | 读与导出分别校验；CSV 防公式注入；无目录路径、提示、摘录、正文、凭据；导出本身留痕 |
| 服务方组织开/停 | 专属 operator 入口、组织/原因确认与结果查询 | 组织管理员不能代替 operator；停用自动定向取消关联工作，开通不自动复活旧 Run |

所有治理写显示目标主体、旧值/新值、影响范围与原因；提交携幂等 ID 和 expected revision，响应丢失先查询原命令。授予直到 Host 权威确认且读模型收敛才显示“可执行”；满席并发按 Host 上界拒绝，不乐观增加席位。
撤权先持久收窄 Work deny 上界并记录取消意图，再完成 Host 写/同步/定向取消；界面分别显示收窄、Host 确认、运行核对结果。超时不撤销 deny、不补发相反授予；晚到低 revision 或旧全量不能复活权限。
自动定向取消须覆盖停用组织、离职/撤席、设备/目录/模型及安全策略撤销所关联的工作；不误取消其他成员或其他组织。仅撤治理委派应阻断该治理写权，不误伤无关任务；恢复席位不自动恢复旧动作。
治理表单编辑中发现权限丢失，立即关闭写入口并保留不含秘密的错误说明；敏感值清空。前端刷新 bootstrap/治理快照并清除跨账号正文缓存，后端不能等待五分钟缓存过期才收窄。
control §2 的 Host AccessProof 最多 30s 新鲜度与 device 的 5s 短动作许可不等于零延迟撤权；记录 Host 变更、Work deny 提交和末次派发三个时间点。控制面确认收窄后不签新许可；已发许可/副作用仅核对，UI 不承诺“离职瞬间所有动作停止”。

### 3.5 token 而非金额预算

展示 input/output/cached、reserved/settled/unknown，按模型与执行位置分列；个人只看本人、组织汇总需读权。文案固定为“token 使用参考，不计算费用；以模型服务方账单为准”，本机模型缺精确 usage 也不显示零成本。
所有组织 Run 级 hard；客户用户/组织周期 soft 仅告警，不硬停；演示组织周期 hard 阻止新预留。预算降低不等于安全撤权，已获准预留可核账；新预留按实时上界，unknown 不释放预留，缺 usage 按合同保守上界而非零。
模型配置探测也计量；客户配置失败不回退平台/其他组织账号，不自动换模型或重发付费请求。私有化允许受批准本机/私网模型，但仍需在线控制面、审批、计量与相同故障安全边界。

## 4. 输入与版本

### 4.1 字段、计数和 profile 上界

以下是本机 profile 的逻辑字段及校验要求，wire 名称在 control §1 冻结后统一映射；旧云端合同不变。本机用户文本含 goal/background，和模板正文、交付要求、来源摘要共同占用总量，不把 8000 宣传为 goal 独占额度。

| profile/字段 | 必须返回或校验的上界 | 提示与数据位置 |
|---|---|---|
| 云端 `text-v1`：goal/background | 分别 2000/4000 Unicode 标量；goal 去空白后非空 | 独立计数，不拼成 8000；沿用既有云端 input/preview 合同 |
| 本机：`profile_id/profile_revision/content_hash` | 必须非空并可验证，引用已发布且不可变 profile | 快照和预览绑定精确 revision/hash，未知 profile 拒绝 |
| 本机：`goal` | 1–8000 标量，去空白后非空 | 本机用户目标；同时受总量 8000 限制 |
| 本机：`background` | 0–8000 标量 | 用户背景/约束；属于用户文本分量，不另享 4000 |
| 本机：`template_instructions` | 0–8000 标量，按实际模板正文而非模板名称计数 | 展示模板占用；本期不引入技能/套件注册表 |
| 本机：`output_requirements` | 0–8000 标量 | 交付格式/验收要求；不得在 prompt 拼装后漏算 |
| 本机：`source_summary` | 0–8000 标量，多来源摘要合并计数 | 仅本机；不自动摘要来挤入上限 |
| 本机：`max_total_input_scalars` | 固定 8000，以上五项实际值之和 ≤8000 | 同时显示已用/上限及各分量；隐藏模板占用也须可解释 |
| 本机：具体来源片段 | 不占上述摘要额度，另受完整模型请求 tokens/bytes 上界 | 仅按已批范围选择；摘要和片段不可互相改名绕过限制 |
| 本机：`max_request_bytes` | 有限正整数，≤262144 bytes，且不高于模型/代理宣告上界 | 对序列化后的完整模型请求 UTF-8 字节校验，不只算文本长度 |
| 本机：`max_input_tokens/max_output_tokens/run_token_upper_bound` | 都须显式正整数且 ≤2^53−1；实际限额不超过模型能力、组织策略与 Run 剩余上界的交集 | profile 必须给可用模型对应的实际数值及 tokenizer/保守估算版本；缺值不提供执行入口 |
| 本机：`model_context_tokens` | 明确实际上下文上界；完整请求 input + 预留 output ≤此值，且单次预留不超 Run 剩余额度 | 系统/工具 schema/历史消息/片段全部计入模型 tokens，不能只检查 8000 文本 |
| 成果限制 | 本机 ≤20 文件/任务、总文本 ≤400000 bytes、Markdown 单版本 ≤40000 标量；各接口另取实际能力更小值 | 云端当前 bootstrap 的 262144 bytes 不自动放大；超出明确拆分/精简，不静默截断 |

Unicode 标量不等于 UTF-16 code unit、字节或可见字形：代理对算 1，组合序列按各标量计数；拒绝孤立 surrogate/非法 UTF-8。输入统一 CRLF→LF 后计数/hash，不做隐式 Unicode 归一化或内容精简。
不得依赖 HTML `maxLength` 截掉合法输入；粘贴/IME 超限仍保留原文，逐字段及总量提示实际值/上限，阻止预览/提交。前端、本机 Broker、API 元数据验证和模型代理使用一致 profile；服务端不凭客户端计数信任正文合法。
本机正文校验/拼装在 Broker 完成，控制面只收绑定设备会话的 profile/hash/计数等元数据；本机分支不能调用现有云端 `createWorkInput` 上传 goal、background、来源摘要。模型请求 hash 由实际完整请求产生，之后任何变化须重批。
超限返回可识别错误类别、字段、单位、实际值/上限与关联 ID，不回显敏感正文；bytes/token 超限在外发前失败，不自动截断、自动摘要、自动拆成多个付费请求。尚未读取片段时预览明确“模型请求待逐次校验”，不得保证必定可发送。

### 4.2 版本协商而非猜最低版本号

- 桌面壳、Agent/Broker、固定 Node/Pi runtime、协议、工具 manifest、隔离 profile 分别报告版本/hash/feature 集；服务端与本机取交集，绑定 OS/arch、org/subject、device/session、profile revision。
- 发布 manifest 必须给出“已通过安装/隔离测试的组合”和所需能力；帮助页显示实际缺失项及对应发布链接。最低桌面版本只能从该证据生成，本文不指定未经测试的数字。
- 缺 Broker、mTLS 配对、journal、句柄工具、模型代理、成果协议或 AppContainer 能力任一必需项，则本机只读/提示升级；不以 `isDesktop=true`、User-Agent 或自报版本授权。
- 依 control §1，`/work/v2` 使用 `work-r0b-1`，新前端同时读 R0a/R0b；`/work/v1` 形状不扩本机枚举，列表只列可理解云任务，本机资源返回 `409 client_upgrade_required`。新旧版本复用领域 ID/幂等账本，已兼容云端可继续，不兼容写能力不得降级。
- 活跃 Run 固定执行组合；升级先停止新领取并核对 journal，重启再鉴权授权。回退只能到兼容且验证过的组合；检查点/journal schema 不可读时冻结恢复，不清空记录“修复”。

## 5. 旧任务过渡

区分重建前 legacy 任务与有效 R0a 云端任务；R0b 上线不把全部 R0a 任务重新归档，也不将 legacy 执行器伪装成新 Broker。任务类型/来源版本由服务端显式返回，不靠前端猜 ID。

| 对象/场景 | 过渡行为 | 不允许的捷径 |
|---|---|---|
| legacy 任务/成果 | 先盘点真实可保留对象；有合法存档才只读查看/导出，无存档明确显示已移除/不可恢复。旧模块/表已经清理，不制造一套空归档假称迁移成功 | 不重试、继续、编辑、新建 Run；不混入我的工作活跃计数，也不伪造丢失正文 |
| 旧 `/work?task=` 链接 | 经过鉴权解析旧标识，存在真实映射才进入历史/有效任务；无存档则明确不可恢复而非承诺可导出 | 不泛跳首页掩盖数据丢失；不允许跨组织枚举 |
| legacy 在途工作 | 当前旧执行器已删除，不为过渡重建；发布盘点如发现未终结旧记录，明确标无法恢复并交运营核对，保留去重/审计证据 | 不承诺旧执行器继续跑，不搬到本机，不生成新 Operation 抵消旧 unknown |
| R0a 云端任务/成果 | 原 task/run/artifact/version/revision 与采纳事实保持；正文、SSE、取消和权限执行回归 | 不强制改成本机，不为新体验重发模型调用 |
| 席位/模型/用量账本 | 沿用 Host 权威和已签 token 账本/账号；新增治理只改变合法写入口 | 不要求重新开通，不另建席位真相，不回到金额计费 |
| 旧桌面 | 不兼容能力只读并升级提示；升级窗口至少一个发布周期 | 不静默失败、不清 journal、不降级普通宿主执行 |
| 灰度关闭/回滚 | 关闭 R0b 新建与新派发，保留新旧任务合法读取、审计与取消/对账能力 | 不删除成果或幂等记录，不回滚已应用迁移破坏证据 |
| local-only 历史内容 | 原设备尚存且有读取权时本机导出；其他端显示元数据/缺失原因 | 不声称云端备份存在，不用再生成冒充恢复 |

发布前至少一周给应用内公告、治理联系人通知、变更日志和导出指引；组织留存政策须覆盖过渡期。公告不能替代授权；未完成旧 URL/导出/回滚验收不退出过渡。本文不修改现有迁移、manifest 或项目状态。

## 6. 需求追踪 B01–B10

验收编号 EV 为 §7、UV 为 §8；一个需求必须同时有正向闭环与拒绝/故障证据，不能以单张页面截图关闭。**本矩阵的重建边界（第十轮 R10A 复核记录，第十一轮 R11A-11 更正）**："只有 §7.4 起的行自带 B 标签"这句不绝对——§7.3 的 EV19 也自带标签（写作"B01/B04"，无斜杠），所以重建时须逐行确认标签是否存在，不能按节号一刀切；§7.1–§7.3 其余行内不写标签、其归属由本节表格单侧维护。因此"按 EV 自身标签逐条重数"只对**有标签的行**有效，对无标签行只能核对"该编号是否存在且被本节引用"，后续复审不得把这一差异当成缺口。**另记本轮重数结果：B09 旧列的 `EV79–EV82` 过度包含（EV81 自标 B01/B03、EV82 自标 B03），已改为 `EV79–EV80`——这正是 R7-17 当年为 B08/EV84–EV86 修过的同类错误。**

| 架构需求 | 本文实施规格 | 兄弟设计落点 | 必须关联的验收 |
|---|---|---|---|
| B01 Windows 本机资料整理 | §2、§3.1/§3.3 | device §2/§4/§7 |EV01–EV05、EV19、EV48–EV49、EV54、EV59、EV63、EV66、EV78、EV81、EV102、EV118–EV119、EV122–EV124、EV125；UV02/UV04 |
| B02 审批及只读允许/撤销 | §3.2 | control §5；device §4 | EV09–EV12、EV46、EV49、EV70、EV71、EV123、EV124、EV126；UV03 |
| B03 中断、撤权、未知不重放 | §3.1/§3.4 | device §3/§6；control §6 |EV06–EV08、EV13–EV18、EV26–EV28、EV51–EV52、EV57–EV59、EV64–EV67、EV70–EV71、EV76、EV80–EV82、EV85、EV87、EV95、EV100、EV103–EV105、EV112–EV113、EV115、EV120–EV122 |
| B04 不可变成果/选择同步 | §3.3 | device §7；control §7 |EV19–EV22、EV56、EV58、EV68–EV69、EV87、EV93、EV97、EV101、EV104、EV111、EV116、EV120、EV121–EV123；UV04 |
| B05 委派/席位/组织开停 | §2.1、§3.4 | control §2/§3/§6 |EV23–EV28、EV50、EV52–EV53、EV61–EV62、EV74–EV77、EV83–EV86、EV90、EV95–EV96、EV105–EV110、EV117；UV07 |
| B06 token 护栏/用量/审计 | §3.4/§3.5 | control §8 |EV29–EV32、EV40、EV94、EV96、EV114；UV07 |
| B07 首用/输入/版本/过渡 | §2.2、§4、§5 | control §1；device §2/§6 |EV33–EV37、EV45、EV47–EV48、EV60、EV88、EV91、EV109、EV119、EV121、EV124、EV125；UV01/UV06 |
| B08 权限能力交集/正文隔离 | §2.1、§3 | control §1/§2；device §1.1 |EV04、EV21、EV23–EV25、EV38–EV39、EV62、EV72–EV74、EV88–EV89、EV97–EV99、EV110–EV111、EV116、EV118、EV123、EV126；UV05（**第八轮 R9：原列的 EV84/EV86 自身标签只有 B05，按 §6"依 EV 行自身标签重建"的规则移出；它们对 B08 的贡献已由 EV89/EV97–EV99 覆盖**） |
| B09 摘录/同步分授权及模型 | §2.2、§3.2/§3.3/§3.5 | device §5/§7；control §7/§8 |EV10、EV16、EV20–EV22、EV40–EV42、EV47、EV54–EV56、EV60、EV63–EV65、EV69、EV72、EV79–EV80、EV89、EV91–EV92、EV98、EV102、EV114、EV118–EV119、EV121、EV124、EV125、EV126 |
| B10 可追踪验证与准入 | §6–§9 | 架构 §5–§7 |EV01–EV126、UV01–UV07 与证据清单；§7.4–§7.14 各行另列其 B01–B09 归属，须合并验收 |

## 7. 故障安全验收矩阵

全部为待执行测试设计。每行证据须含真实构建/配置版本、fixture ID、关联 task/run/operation/command ID、时间与断言输出；敏感值仅在受控测试夹具中核对，证据不得泄漏真实客户正文或秘密。标注 F/H 的编号来自目标架构，其他编号是本文验收号。

### 7.1 Windows、身份与执行隔离

| ID | 前置 | 注入/操作 | 期望事实 | 必交证据 |
|---|---|---|---|---|
| EV01 安装 H01 | 干净 Windows x64 标准用户，无管理员/WSL/Git/Python/全局 Node | 安装签名包、首次运行，再对篡改包/不可信链/错误哈希安装 | 正常包能运行；其余拒绝；不运行安装时 npm；Agent/Node/Pi 固定包与 SBOM/许可证齐全 | 干净机镜像 ID、安装日志、签名链/时间戳/哈希、组件清单与进程树 |
| EV02 升级 H06/H08 | 真包+真实 Rust Broker，有未释放 journal 与草稿 | 升级/回退/中断安装；分别禁用 AppContainer 或使 profile 不匹配 | 原数据/journal 保留；兼容组合可恢复核对；隔离不可用拒绝执行，无宿主兜底 | 前后包/数据 hash、协商结果、拒绝记录、旧/新进程与权限观测 |
| EV03 F13 | 真实 Broker 已授权根，根外放唯一哨兵 | 在检查与打开间反复切换 junction/reparse/symlink；覆盖来源读取及成果写入路径 | 无根外读取/写入；基于句柄/最终对象约束拒绝，不靠字符串前缀；来源未变 | 可控竞态时序、实际句柄/文件 ID、系统文件访问追踪、根外哨兵 hash |
| EV04 F27 | 真实 AppContainer+受限 Node/Pi，Broker 在线 | 子进程/依赖直读宿主、直连公网/内网、访问凭据/原始 IPC | OS/窄 IPC 拒绝，只有许可 Broker 路径能读写/出网；无秘密进入上下文 | OS 拒绝与网络观测、进程树、Broker 审计；不能用 mock 返回拒绝替代 |
| EV05 格式/根边界 | 根内合法四格式及 PDF/非法 UTF-8/穿越路径 | list/read/search、新文本写入；请求来源覆盖/移动/删除、ADS/UNC 或系统目录 | 合法闭环可完成，其余按工具合同拒绝；不跟随越界链接、不改来源 | 工具输入/错误码、读写对象清单、来源前后 hash、成果 hash |
| EV06 身份 F19 | A 账号已配对，B 账号/另一组织与另一设备 | 登出换号、重放旧配对凭据/证书、伪造 device/session | 原目录/草稿不可复用；证书绑定正确主体；旧会话不能领动作 | 握手/鉴权拒绝、账号隔离断言、旧许可无派发记录 |
| EV07 当前设备 F06 | 原设备有 local Run，Web/手机/另一桌面知道 device_id | 从其他端提交/领取；原设备离线及租约到期后再请求 | 无远程派发，无迁移执行；另一网关重连仍只允许原设备会话依法核对 | 请求矩阵、网关/租约记录、Operation 发送计数与 UI 状态 |
| EV08 故障域权限 | 合法设备证书和 Gateway 工作负载 | 尝试直达 Host/PG/内容管理、跨租户帧、超大帧 | 身份/网络/大小边界拒绝；Gateway 不获得业务表写权限 | mTLS 负例、网络拒绝、数据库权限断言及无副作用记录 |

### 7.2 审批、断线、重启与安全持久性

| ID | 前置 | 注入/操作 | 期望事实 | 必交证据 |
|---|---|---|---|---|
| EV09 F03 | 同一待审批 Operation，多标签页 | 批准/拒绝/到期/撤销并发，重复提交原请求 | 唯一持久决定；陈旧批准无派发；界面刷新到同一结果 | 并发时序、审批 revision、CAS/审计与派发计数 |
| EV10 只读许可 | 同 Run 同根有只读允许 | 同类读取；换根/扩 scope/新 Run/24h 到期；尝试写入、外发、同步 | 仅合法只读匹配；其余另批或拒绝；撤销后无新动作 | 匹配/拒绝矩阵、许可期限与撤销审计、各类 Operation |
| EV11 拒绝后果 | 任务依赖待批读取 | 拒绝后刷新/重连，观察模型尝试更名重试 | 拒绝被持久展示且原意图不重发；任务明确暂停/终止原因 | 审批记录、请求 hash/意图关联、零绕过派发与页面录屏 |
| EV12 F12 | 任务有 pending 审批，SSE 正常 | 断 SSE、过期游标、重复乱序事件，离开再进入 | 快照补齐待审批；无正文事件；状态不回退，无需独立 Inbox | 网络轨迹、游标/快照 revision、事件字段扫描与键盘录屏 |
| EV13 断网/休眠 F20 | 原设备执行中，含本机模型 | 分别断控制面网络、休眠超过租约、调整系统时钟 | 不领取新许可；旧许可过期拒绝；已发动作核对，不离线自治 | 心跳/lease/fence、实际动作时序、恢复横幅与新派发计数 |
| EV14 重启 F05/F20 | 写入已完成但回执未确认 | 杀 Agent、重启 Windows，重放同 Operation+hash | 先 journal 核对，只写一次；旧目录许可失效，重授权后才可能继续 | journal 持久记录、文件 hash/写次数、boot/session 变化与审批序列 |
| EV15 journal 丢失 | Operation 已可能执行，服务器尚无可核对终态 | 删除/损坏未释放 journal 或只恢复旧 journal 备份；**第十轮 R10A-10：本行只适用于有外部副作用的两类（`artifact.write`、模型调用）**，只读类（`list`/`read`/`search`）走 EV120 的降级终态 | 标记 unresolved，保留预留/去重；阻断续跑、新 Run、采纳；不重算序号重发 | 恢复诊断、服务器与设备水位差、UI 禁用、外部发送计数 |
| EV16 F04/F21 | 真模型可受理请求，预留已持久 | 在受理后断流、dispatching 确认丢失、发包前/后崩溃分别执行 | 仅 CAS 胜者发一次；无确定未执行证据即 unknown，不换 ID/账号重发 | provider request ID/受理侧记录、CAS/journal、账本保留、重连发送计数 |
| EV17 F26 | 声明的同步持久边界正常，有待释放 journal | 断同步副本/灾备 WAL 确认；设备磁盘接近满 | 不降异步提交，不发 journal_release；磁盘不足停止新动作而不删未释放记录 | 数据库持久配置/WAL 水位、release 帧观测、磁盘与拒绝日志 |
| EV18 F15 | 有派发/撤权/删除事实及旧备份 | 恢复丢 Operation 的备份、切换旧主、重放旧 recovery generation | 冻结受影响写入及不安全正文访问；旧主被隔离；账本/撤权/删除完整性未证不得重开 | 主隔离证据、恢复水位差、generation 拒绝、解冻前置检查 |

### 7.3 成果、治理、输入及云端回归

| ID | 前置 | 注入/操作 | 期望事实 | 必交证据 |
|---|---|---|---|---|
| EV19 B01/B04 | 合法文件夹任务，全部调用已核账 | 输出索引/要点/分类建议，创建新版本并采纳；再外部改写文件 | `WeMeet成果` 不可变版本可采纳；来源不变；改写不冒充原版本 | 原始/成果 hash、版本/采纳记录、Broker 访问与端到端录屏 |
| EV20 F10 | local-only 已核账版本，可同步分类 | 仅批模型外发后尝试同步；独立同意后上传成功但 finalize 失败 | 前者无上传；后者不提前云端可用；同会话核对/重试不新建版本 | 两种授权 ID、上传/finalize 记录、前后元数据/hash |
| EV21 跨端隔离 | 一份 local-only 与一份已同步成果；本人另一端和治理者 | 查看任务详情/输入/成果/下载，猜版本或内容 URL | local-only 跨端仅安全元数据；治理者无正文特权；已同步仍按本人资源权 | 多身份 HTTP/IPC 断言、无正文响应/缓存/自动请求、截图 |
| EV22 F07/F11/F22 | 运行/unknown 中有旧成果，或可采纳静止版本 | 提前采纳；双端同 revision 采纳；取消后迟到成果/上传 | 静止门拒绝提前采纳；唯一成功/明确冲突；迟到结果仅核账不新发布 | task/run/blocking 状态、CAS、版本/计量/发布事件差分 |
| EV23 委派 | owner、内置 admin、普通成员均未获新增治理权 | owner 显式委派并撤销一项；admin 通配/旧角色编辑尝试自授或越权 | 仅冻结委派路径有效；单权限不连带其他写权；撤销后下一写拒绝 | Host 权限集合前后差、授予来源、越权矩阵与强审计 |
| EV24 无席位管理员 F24 | 有治理读/写权但无执行席位，执行额度耗尽 | 进入治理、授予席位/查用量；再创建任务/读取他人成果 | 合法治理可用；执行与正文仍独立拒绝；不被个人 bootstrap 席位门挡住 | 导航/直接 API 双路径、权限事实、失败/成功响应与录屏 |
| EV25 席位权威 | 仅余一个席位，两个合法治理命令 | 并发授予，伪造 org/subject，Work 投影先更新尝试 | Host 上界不超卖；跨租户拒绝；未有 Host 确认不显示执行资格 | Host revision/席位事实、命令 ID、投影差与拒绝审计 |
| EV26 撤权竞态 F09/F16 | 用户本机/云端 Run 持旧快照 | 撤席/离职/停用与 Host 写超时、晚到旧同步并发 | deny 先收窄；新动作拒绝；关联 Run 自动定向取消；旧快照不复活 | Host/Work 修订序列、取消 outbox、目标 Run 集、派发时间线 |
| EV27 定向及恢复 | 两组织多成员/设备同时工作 | 撤一个目录/设备/模型绑定或治理委派，再恢复席位 | 只取消受影响工作；委派撤销仅收窄该治理权；恢复不续发旧动作 | 输入目标集与实际取消集对比、未受影响 Run、恢复后请求记录 |
| EV28 服务方开停 | operator 与组织治理者，两组织 | operator 停用组织，组织治理者试图重开，再由 operator 开通 | 停用阻止新工作并定向取消；组织无法越权重开；开通不复活旧 Run | operator 身份、命令/审计、Run 集与权限负例 |
| EV29 token 软硬 | 客户/演示组织各有最后一笔额度，含云端和本机 Run | 周期越阈、并发预留、Run 达上限、降低预算 | 客户周期只告警；演示 hard 不超卖；所有 Run hard；已有预留可核账 | token 账本前后、并发结果、派发数、无金额字段/UI |
| EV30 用量缺失 | 模型正常/缺 usage/未知结果三个请求 | settle 重放、跨周期到达、缺 usage 对账 | 幂等；归正确主体/模型/周期；缺值保守记账，unknown 不释放；cached 单列 | usage 原始测试回执、预留/结算/聚合核对与页面数值 |
| EV31 用量隔离 | 两用户两组织及只持读权治理者 | 修改查询主体/模型过滤、直接写护栏、查询他人用量 | 本人仅本人；组织汇总需读权；读不含写、不穿租户 | 查询/写入负例、响应字段、权限与审计 |
| EV32 审计导出 | 有/无独立导出权，含特殊姓名及敏感哨兵 | 导出、下载失败重试、撤权后再下载，CSV 姓名以公式字符开头 | 权限每次校验；导出留痕且防公式注入；无路径/正文/秘密泄漏 | 脱敏导出样本、扫描/解析结果、导出审计与拒绝响应 |
| EV33 标量边界 | 云端 2000/4000 与本机五分量总 8000 profile | 精确边界与加一；代理对/组合字符/CRLF/IME/非法 surrogate | 标量计数一致；云端不放大；超限保留输入并明确错误，非法编码拒绝 | 前端/Broker/API 计数对照、错误字段/单位、无提交与粘贴录屏 |
| EV34 token/bytes | 合法 8000 文本，明确 tokenizer/model 上界 | 增加来源片段使完整请求刚达/超过 bytes、input tokens、context 或 Run 剩余 | 边界可发，超界在外发前拒绝；不截断/摘要/拆单；系统/工具/历史纳入计数 | 完整测试请求 hash、序列化字节/token 明细、零超界外发 |
| EV35 预览失效 | 有有效本机或云端预览 | 改模板/输入/profile/策略/目录，在旧预览返回与确认间竞态 | 旧预览不覆盖新草稿；提交拒绝过期或不匹配；不发新调用 | preview/hash/revision、交互时序、提交与派发计数 |
| EV36 协商 | 新旧客户端与不匹配 Agent/runtime/tool/profile 组合 | 缺字段、未知版本、伪造 isDesktop，回退不兼容 journal schema | 缺必需能力只读；旧云端合同不破坏；不猜版本/清日志/降隔离 | 组合 manifest、握手拒绝、旧客户端回归与升级提示 |
| EV37 过渡/回滚 | legacy 与 R0a 在途/已采纳/已删除任务及旧 URL | 灰度开关切换、旧链接访问、合法导出、停新任务后回滚 | legacy 只读，R0a 事实保持；无假 404/越权；成果/审计/去重不删除 | ID 映射、访问矩阵、前后数据 hash、回滚与导出记录 |
| EV38 云端鉴权回归 | 现有云端 bootstrap/session/CSRF 路径和真实 Host | cookie/证书错误、Host 超时、CSRF 缺失/轮换、客户端伪造主体 | fail closed；只刷新一次 CSRF 且无重复写；不影响合法云端用户 | Host/mTLS/HTTP 矩阵、无副作用与会话缓存断言 |
| EV39 云端任务回归 F01/F02/F23 | 三个既有云端模板、持久幂等记录、真实 PG/Temporal | 正常 input→preview→submit；响应丢失、Relay ACK 丢失、删除后重放 | 一个 Task/Run/Workflow；无重复收费；模板/输入合同不变，删除不重建 | 任务/Workflow/幂等记录、模型发送数与三个模板端到端结果 |
| EV40 模型/凭据回归 | 客户独立账号、演示账号、批准本机/私有模型 | 配置探测/轮换/吊销；缺精确 usage；一个组织模型不可用 | 探测计量、凭据不回读；无跨组织/平台/模型自动回退；本机同受护栏 | 配置版本/指纹、请求目的地、token 账本、日志秘密扫描 |
| EV41 外发分授权 F25 | 根可读但分类禁止外发，另一个允许摘录根 | 只授目录；批准特定摘录后更改完整请求或目的地 | 原文件不上云；禁外发分类不可被批准绕过；hash 变化重新审批，无默认同步 | 本机审批内容核对、出口抓取、请求 hash、云端字段/存储扫描 |
| EV42 注入/预览 F14/F25 | 恶意文本要求外发/换账号，模型含编码衍生、reasoning、Markdown 外链 | 执行整理并预览成果，尝试通过改写降分类 | 模型外策略拒绝扩权；衍生继承最严格分类；无 reasoning 展示/自动外链加载 | 工具/出口拒绝、分类链、浏览器网络轨迹、成果渲染断言 |
| EV43 云端成果/SSE | 既有云端可读成果，含旧采纳版本 | SSE 断线/过期、取消后晚到、版本读取/下载/采纳并发 | 云端正文仍合法可用；SSE 有界重同步；静止/版本/权限不退化 | HTTP/SSE 轨迹、版本 hash、采纳/取消/核账与访问矩阵 |
| EV44 云端迁移/持久性 | R0a 数据、已应用迁移校验和及同步边界 | 应用获批增量、旧应用读；副本故障并测试云端预留/派发 | 不改旧迁移/checksum/catalog；旧事实保持；安全提交不降级 | 迁移前后校验、PG 约束/RLS、备份核对与云端拒绝派发记录 |
| EV45 首用/移动/a11y | 新用户、有历史用户、无席位用户及手机 | 跳过引导/授权返回；键盘/读屏；变窄视口及请求 local 写 | 不自动提交；无假入口；移动写不开放；焦点/错误/跨端元数据可理解 | 端到端录屏、可访问性检查、网络写请求计数与能力矩阵 |

### 7.4 复审新增的协议与竞态断言

这些用例补足详细协议，不是已执行结果；必须与对应B需求一起验收，不能只跑EV01–EV45。

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV46 / B02 | 对原设备签署的拒绝/仅批准一次proof分别改decision、remember、工具/范围/expiry、revision | 任何字段变化验签或逐项比较失败，零派发；同proof原样幂等，不扩大只读许可 | 固定签名正反向量、HTTP与签名字段对照、permit计数 |
| EV47 / B07/B09 | 本机InputV2中夹带goal/background正文，另提交合法ref/hash/count proof；跨端读取详情 | 夹带正文422且不落云；合法metadata可预览；Task/API/日志/DB/Temporal无本机输入全文 | 存储与网络敏感哨兵扫描、输入拒绝及元数据响应 |
| EV48 / B01/B07 | 无local_intent发PreviewRequest；生成preview后再签intent；替换target/profile/grant/request_id提交 | 正向没有循环依赖；任一绑定不符拒绝，旧preview不重算放行，重放仅同Task | 请求顺序、三份hash/proof、nonce消费与Task唯一约束 |
| EV49 / B01/B02 | 同设备发action_prepare，重复同key/hash，改hash、跨session、超工具manifest | 原prepare返回同Operation/Approval，不派发；异hash/越权拒绝，不发送started冒充准备 | 双向帧记录、领域行/审批行、零未经授权工具执行 |
| EV50 / B05 | operator发布seat_limit，响应丢失后查原command；并发ChangeSeat和降上限到已占以下 | 同org锁序决定唯一revision；无权威ACK不增权，overallocated只禁新授座不随机撤人 | Host command/entitlement revision、占用数、Work ACK匹配与并发日志 |
| EV51 / B03 | receipt持久后注销/离职/撤设备，证书过期；通过recovery-only重连，尝试prepare/lease/content；另标key compromised；**再加恢复通道自身的边界（第八轮 R8-6/S14）**：证书已被撤销仍完成一次合法挑战、挑战重放、跨 device_id 猜测他人挑战、源 IP/device 超频、经该通道请求正文读取或新许可 | 历史receipt可核账但无新权；compromised证据隔离不自动结算；私钥丢失保持unresolved；**"证书已撤"不等于"通道关闭"——历史公钥验签成功即可上传核账，但 prepare/lease/content 一律拒绝**；挑战一次性且 60s 过期、重放被拒；跨设备猜测与不存在记录返回同一拒绝形状（不泄露设备归属）；超频返回 `rate_limited` 且不产生写副作用 | challenge/签名与audience拒绝、原执行身份、配额/权限差分、限流计数与拒绝日志、统一拒绝形状的响应比对 |
| EV52 / B03/B05 | 延迟旧撤席hint；先显式重新授座并创建高epoch新Run，再消费hint | 仅旧授权Run被取消；新Run不受旧事件误伤；旧Run不因授座复活 | cutoff/admission epoch、依赖版本、预期/实际取消集合 |
| EV53 / B05 | 仅授seat.write、不授seat.read；提交撤席并查询本人/他人change、席位列表 | 本人最小change结果可取，其他change/列表拒绝；无权限升级 | 各API身份矩阵、字段白名单、Host saga状态 |
| EV54 / B01/B09 | Broker确认hash后原地改写同file ID内容；读/search分别注入 | 交Node的只能是已核验的同一buffer，或source_changed；不能通过二次读交付替换bytes | 批准hash/输出buffer hash、I/O时序、原地写竞态控制 |
| EV55 / B09 | Node读local_only后把编码内容标为user_input/template；保存checkpoint后恢复 | Broker来源注册拒绝重标，context taint单调且恢复不丢；零模型外发/同步 | source DAG/hash/class revision、恢复前后taint、出口零请求 |
| EV56 / B04/B09 | upload session后、首chunk前撤权；另在chunk在途时撤权，使用旧permit续下一chunk | 首字节前无新鲜授权不发；最多已消费当前chunk在途，后续拒绝；finalize不成为唯一保密闸 | chunk permit消费/epoch/TTL、出口bytes/offset、拒绝与staging清理 |
| EV57 / B03 | 新session重传旧signed receipt；不同journal_epoch同seq；丢失release/run_sealed ACK | 原历史签名不改写；跨epoch不混淆；同seq异hash拒绝；ACK重放幂等，unknown不清，迟到command被tombstone拒绝 | 帧签名原文、epoch/seq、LSN证明引用、清理前后去重记录 |
| EV58 / B03/B04 | rename+manifest成功后崩溃，旧fence receipt核账；分别原Run仍latest、已有后继、已取消、已删除 | 第一类显式recover发布同version、不重执行；后继/取消仅合法恢复读取，删除拒绝；不改当前Task | recovery对象/Task revision/CAS、write/model调用计数、读取票据权限 |

### 7.5 启动、配置与委派闭环补充

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV59 / B01/B03 | queued本机Run、多个本地草稿；交换offer input_hash/profile、丢run_started ACK，重启后重发旧start_nonce | 仅签定binding的输入可启动；无ready/lease不启动；同nonce不建第二sidecar；恢复须新binding_revision与原checkpoint，不从头重跑 | run_offer/ready/start帧与签名、runtime_start记录、进程与Operation计数 |
| EV60 / B07/B09 | owner发布device_local policy；设备创建binding并探测，另有远程候选配置 | profile可取精确revision/hash；静态active不冒充模型可用；binding verified后才能执行；探测计量/unknown不重发；未批准URL/轮换后未探测拒绝；**第十一轮 R11B-18 补两条保护的正反例：普通任务 API 请求体带 `task_kind=configuration_probe` 必须 422（§8.4 散文声明"不可由任务侧指定"，此前无任何 oracle 测它）；探测 Run 不得出现在"我的工作"列表、详情或 SSE（§1.4 GET /tasks 行的过滤谓词）** | profile/binding/probe状态、固定请求hash、token账本、凭据零明文与禁止自动切换、伪造 task_kind 的 422 记录、列表过滤前后的行数对照 |
| EV61 / B05 | 无seat、无seat.read/write的owner仅操作Work委派；Host响应丢失 | 202后可按同command查询/对账；不要求先自授席位权；Host重复同key不重委派；非owner不能查询 | Work change kind鉴权、Host GetCommand回执、assignment/revision与审计 |
| EV62 / B05/B08 | 用户仅有部门A的HR旧权限，再获组织级Work seat.write | 部门A范围保持，访问部门B仍拒绝；Work席位治理按组织生效；旧AdminRole拒绝Work码，旧admin通配不能得到Work业务权 | 授权前后OrgAdminContext.scope与部门负例、独立Work AccessProof、两个域权限集合差分 |

### 7.6 本机模型交接、Run 收尾与用户保存补充

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV63 / B01/B09 | 真 egress+受控 provider 桩，请求/回答含敏感哨兵；改 body 一字节、过期或错 aud 许可、同许可并发两次、设备证书调 `/runtime/v1/model/invoke` | 只有合法请求调用 provider 且仅一次；许可非法时不读 body；Content Store、DB、日志、Temporal、审计中无哨兵，provider 拒绝体也不落盘 | provider 调用计数、gate 行、存储与日志哨兵扫描、ingress 拒绝记录 |
| EV64 / B03/B09 | 分别在 gate 前、gate 后 provider 前、provider 成功后响应前断开；另篡改设备 receipt 的 answer_hash | 依次为 sealed 已证明未发送、unknown 保留预留、undelivered 已结算；hash 不符隔离并 waiting(reconcile)；任一情形零自动重发 | gate/Operation/预留/usage 差分、provider 计数、seal 与迟到 attach 竞态时序 |
| EV65 / B03/B09 | undelivered 后不重发结束；另一次点重发并由用户明确收尾；由 Node 或 auto_readonly 发起重发、向 Broker 重发入口传改过的正文；非 undelivered 的 Operation 以 resend_undelivered 取代 | 结束时不再计量；重发需新 logical_key、新预留、人工审批和第二次计量，且重发成功的 Run 最终能到 awaiting_acceptance（EV80/EV87）；其余一律拒绝 | 审批/预留/usage 记录、界面录屏、拒绝响应、Run 终态 |
| EV66 / B01/B03 | Node 自报完成但无成果；有 unknown 时提议 completed；cancel 与 run_finish 竞态；旧 fence 提议；丢 ack；operation_set_hash 不符；recovery-only 发 run_finish | 无成果记 failed；不满足条件不写状态；取消优先；旧 fence 不改 Run；丢 ack 同 finish_id 幂等；recovery-only 拒绝；只有全部通过才 awaiting_acceptance | run_finish 帧与签名、device_run_finish、Run/Task revision、工作流事件 |
| EV67 / B03 | 同 seq 异 hash checkpoint；只记录旧 seq 后崩溃恢复；丢失 workflow signal | 冲突转 waiting(reconcile) 且停止新许可；恢复基线取已记录最新值并合并 receipts；signal 丢失靠扫描补发，不重复启动 sidecar | device_checkpoint 行、resume offer、进程与 Operation 计数 |
| EV68 / B04 | Run 结束且 grant 已过期时保存；**最新 Run 已 failed/canceled 但 base 版本已核账时保存（J17：换前置后这一例应当成功，误点拒绝不得再锁死编辑）**；Run 进行中、base 过时、其他设备/Web、席位已撤、缺原生确认或改 proof 字段时保存 | 前两种成功且 copy_state=pending、无 Operation/permit/预留变化；其余拒绝且不产生版本；**"已核账"是唯一防半成品的前置：base 版本所属 Run 存在任一阻塞 Operation 时必须拒绝（J17 放宽的是 Run 成败状态，不是核账门槛）**；发布请求体不含 classification 字段（§4.1 单写者），低于 base 或剪贴板来源下限的一律 `classification_floor_required`——旧写"提升分类以外的降级被拒"会让人以为请求方能设分类（第十轮 R10A-15）** | 版本/审计/quota 差分、各请求响应、proof 正反向量 |
| EV69 / B04/B09 | 服务端已受理但响应丢失后重启；proof 过期且未受理；结果未知时尝试丢弃草稿；保存后的版本继续同步/采纳；采纳其他设备上的 local_only 版本 | 同 request_id 返回原版本且 nonce 不重复消费；过期转 draft 不自动重提；未知期不能丢弃；用户版本走原同步/采纳门槛，继承分类；读取 local_only 无 content_ref 时返回 content_on_original_device | request 去重、publish_ack 验签、local_content 状态迁移、同步披露记录 |

### 7.7 动作取代与本机正文显示补充

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV70 / B02/B03 | Run 有已派发、待审批、已授权未发许可三类步骤，重启后对同一目录改绑；另选不同目录、复制出的同名目录、跨设备重放 GrantSuccessionProof | 同目录改绑后只有未执行步骤以 `workspace_rebound` 取代并重新审批（**第二十一轮同步第十九轮的改正：此处旧写 `reauthorized`，而设备 §3.5 第 165 行已改为"存在 `workspace_grant_succession` 行即必记 `workspace_rebound`、计入主动桶"；沿用旧名会让本条断言去证明一个已被推翻的标注，且把主动变更算进不限量被动桶**），已派发步骤只核账；**卡片须显示 old→new grant 与"root identity 相同"这一事实**（第十九轮给 `workspace_rebound` 定的审批要求，此前无任何 EV 覆盖它）；不同目录（含复制目录）返回 workspace_identity_changed；旧 grant 的同类只读允许失效；重放 proof 拒绝；**另测正向消费（第十一轮 R11C-1：此前本行只测失效侧，而那张 grant 表在控制面根本没有消费者，B02 的第三个选项无法验收）——同根内第二次同类 `list`/`read`/`search` 必须零新增 pending Approval、Operation 直接 `authorized`、审计含 `operation.auto_approved` 与 grant id/revision；资源子树外、`policy_epoch`/`access_epoch` 变化、到期三种情况都必须回到逐次询问（不得反向扩大覆盖）** | succession 行、Operation 取代链、审批记录、root_identity_hash 比较与拒绝响应、两次只读动作的 Approval 行数对照 |
| EV71 / B03/B02 |  对 unknown、已被取代、缺未执行证明的 Operation 发取代；**取代帧缺 `supersede_assertion`（或断言哈希与正文不符）；非取代动作却带断言；`changed_fields` 越集**（第十二轮 R12A-7：`SupersedeAssertion` 是取代行为唯一可归责证据，此前五份文档的 EV 里一次都没出现，D §3.5 却写着「配合 EV71/EV65 验证」（第二十一轮更正此处的旧引用：原写 EV69，而 EV69 测的是服务端已受理但响应丢失、proof 过期与草稿丢弃，不测注入；设备侧 §3.5 现文已是 EV65，本行作为引文必须跟上一致，否则按引文去找验收面会找错卡片））；并发只有一个成功；超限转 waiting(input)，**且界面在每次取代后显示"本步骤已取代 n/5 次"、第 6 次显示"继续需重新预览，或结束本 Run"，不出现"重试/跳过"假入口（第十轮 R10A-12，与本档 §3.2 三项出口同源）**；同 step_key 任一时刻最多一个未终结 Operation；**两桶分别验证（第十二轮 J21）：连续 3 次审批过期＋2 次休眠重授权后，用户主动改参数（`tool_params_changed`）仍必须还能取代一次（主动桶计数为 1）；主动桶第 6 次才回 `supersede_limit_exceeded`，且 `workspace_rebound` 与 `tool_params_changed` **合计计数**（共用同一步骤的一格，不是各自 5 次——第十九轮定的两个取值就是同一格的两个来源）；**改绑已产生 `workspace_grant_succession` 行却把原因标成 `reauthorized` 必须被拒**（第十九轮分辨规则；succession 行由控制面自己写，所以这条在服务端可判，不靠设备自述）；**`changed_fields` 出现 `destination` 一律按越集拒**（本闭集没有该值，目的地不参与取代）；被动桶各自超限（过期第 4 次、来源变化第 4 次、重发第 2 次）不得占用主动桶，也不得返回该码**；approval_expired 与 source_changed 正向可继续  同一步骤的第 6 次取代由 Node 发起；| 全部拒绝且不建新 Operation；并发只有一个成功；超限转 waiting(input)，且界面每次取代后显示「本步骤已取代 n/5 次」、第 6 次显示「继续需重新预览，或结束本 Run」，不出现重试/跳过假入口（第十轮 R10A-12）；缺断言或断言哈希不符即 `invalid_request` 拒绝且不留 Operation；非取代带断言同样拒绝；`changed_fields` 集外值拒绝；同 step_key 任一时刻最多一个未终结 Operation；approval_expired 与 source_changed 正向可继续 | 部分唯一索引/约束触发记录、并发时序、prepare 帧签名与 `supersede_assertion_hash` 对照、Operation 计数、审计 payload 含断言原文 |
| EV72 / B08/B09 | 本机内容窗口打开含外链图片、`<script>`、自动跳转、表单、CSS url() 的 Markdown 成果与审批详情；在窗口内用 fetch/WebSocket/拼写检查/DevTools 尝试出网 | 零网络请求（含 DNS 预取）；原始 HTML 不执行，链接与图片不加载；导航/新窗口/权限请求全部拒绝 | 系统级网络抓包与 DNS 日志、webRequest 取消记录、DOM 快照 |
| EV73 / B08 | 在主窗口检查 DOM、内存快照、localStorage/IndexedDB/缓存、主窗口发出的请求与 IPC 返回值，覆盖查看、编辑保存、审批、运行过程、提交后查看目标文本；伪造 viewer 消息从主窗口或另一 frame 发出 | 主窗口中无本机正文哨兵，Composer 文本在 stageLocalInput 后清空；只有 viewer 主 frame 能发第 6 条闭集内的**全部六类**消息【2026-11-10 J40=A 计数口径：6＝本机 §1.1 第 6 条成员清单逐项穷举（唯一出处），取数法见该条计数标注，本行不自维护计数】（`decideLocalApproval`/`prepareUserArtifactVersion`/`confirmLocalWrite`/`confirmDisclosureDecision`/`signObjectProof`/关闭——**第十三轮 S2 口径核对：本行此前只列五项且自称"五类"，漏了第十一轮 R11C-1′ 加进闭集的 `signObjectProof`，等于四类持有证明的 frame 校验负例在本路不可见**），approval_id/artifact_id 与当前对象不一致时拒绝；`confirmLocalWrite` 的 `action` 三值各自后果都要测（`discard` 转终态、`cancel` 只留 `pending_confirm` 草稿且不得发出任何请求）；**第十一轮 R11A-7：本行此前只写 decide/prepare 两条，闭集扩容后 `confirmLocalWrite{action=discard}` 与 `confirmDisclosureDecision` 两条新消息没有任何 IPC 层负例（EV116 只测 renderer/Node 直连 HTTP，测不到 frame 校验）**；`signObjectProof` 的 frame 层负例在 EV123，本行只断"闭集外消息一律拒绝" | 哨兵扫描结果、IPC 返回字段白名单、发送方校验拒绝记录 |

### 7.8 成员归并与 deny 解除补充

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV74 / B05/B08 | 一人有 A、B 两个部门 Membership，席位授在本人；修改 B 行职务、把 B 行设为 left、删除 B 行、把 primary 从 A 调到 B、A 行为 member 而 B 行为 administrator、User 停用 | 席位不随任一部门行变化而丢失；B 行 left 不使本人离开 active；删除行后增量同步仍观察到变化；role 取 active 行最高；User 停用即 suspended；Host 列表每人一项 | Host 列表响应、WorkMemberState revision 序列、Work 投影前后差分、增量与全量同步各一次 |
| EV75 / B05 | 迁移前一人多行 work_seat 不一致、已占席位超 seat_limit；迁移后 Host 返回重复 subject 的列表（故障注入）；最后一行改为 left | 有投影记录者一律照抄投影值（既不再按“任一 active 行”授予，也不人为撤掉），无投影记录才按“非 left 行一致为 true”授予且空集不授予；不一致者进报告待 owner 确认；超限标 overallocated 不随机撤人；重复 subject 被 Work 判 directory_protocol_invalid 且水位不前进；left 同事务清席位和委派 | 迁移前后 work_seat 逐人对比、迁移报告、同步错误记录与水位、Host 审计 |
| EV76 / B03/B05 | 组织有在途本机/云端 Run 时 Host 停用组织；停用期间成员甲离职、成员乙被 Work 撤座、operator 另设 operator_suspended；服务方先 activate，再解除 operator_suspended；另测 archive 后 restore | 停用即 deny 并定向取消；activate 只解除 host_org，operator_suspended 仍挡；两者都解除后其他人可新建，甲、乙仍被各自 deny 拦住；旧 Run 不复活，设备须新 session；restore 同理并提示已清理数据 | access_restriction 状态迁移与 source、Run 集、设备 session、各身份请求结果 |
| EV77 / B05 | 重放停用前的旧组织快照、伪造低 revision 的 active 投影；组织 owner 与持全部 Work 治理权限者尝试解除 host_org deny；Host 原生页面在 Work 撤座后再授座，另测授座命令 revision 低于撤座回执 | 旧/低 revision 不解除任何 deny；owner 和治理权限都无法解除；高 revision 的原生授座解除 work_seat_change deny，低 revision 的不解除 | sync 拒绝记录、权限负例、`consumed_governance_command` 与事件 `member_revision` 比较（**Host 侧无 outbox，第八轮 P2 更正此前的"outbox 命令事件"措辞**） |

### 7.9 根目录获取与本机模型身份补充

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV78 / B01 | 第二个标准用户对 `C:\shared` 有写权；在选择器返回后、Broker 打开前把选中目录的上级换成指向哨兵目录的 junction；另测企业重定向的合法上级 junction、用户在确认框取消 | 竞态时确认框显示实际位置并警示不一致，取消则无 grant、哨兵零访问；合法重定向可确认后正常使用；共享目录有“其他本机用户可修改”提示，`WeMeet成果` 的 DACL 只允许当前用户写 | 竞态时序、`GetFinalPathNameByHandle` 结果、确认框截图、文件访问追踪、DACL 导出 |
| EV79 / B09 | 第二个用户先监听 device_local 端口；同一用户下换成另一程序监听；模型服务升级（签名不变/未签名 hash 变化）；监听在 0.0.0.0；用 `localhost` 解析到其他地址 | 冒充者零请求字节且 binding 转 identity_mismatch；签名不变升级直接通过，hash 变化须重新确认；0.0.0.0 有提示；只连字面地址 | loopback 抓包、TCP 表与进程身份记录、binding 状态迁移、确认框截图 |

### 7.10 第四轮修订补充（裁决回传、检查点、fence、席位迁移、桌面鉴权、私有端点）

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV80 / B03/B09 | 模型动作处于 sealed_not_sent、rejected_not_executed、undelivered、已结算 success 四种服务端终态；设备未收到 resolution 就提 run_finish；重放旧或重复 revision；resolution ack 丢失；已签发后再补一条迟到 receipt | 设备journal只有收到签名 resolution 才离开 unknown；未收到时 run_finish 返回 finish_state_mismatch 并带 expected hash；低 revision 不回退、重放幂等；迟到核账不推翻已签发结论 | 帧签名与 revision、journal 状态迁移、finish 结果、receipt_outbox 与 release 水位 |
| EV81 / B01/B03 | 未 ack 的 checkpoint 上直接提 action_prepare/run_finish；checkpoint_commit 返回 conflict；Run 停在 waiting(approval) 后崩溃恢复；新建 Run 的第一个动作直接引用 seq=0；在 binding 创建后、lease 前尝试引用基线 | 引用未 recorded checkpoint 被拒绝；**seq=0 只由 `acquire_device_lease` 写入（带当前 `run.fence`、hash 为设备 canonical input hash、`signed_payload_hash` 为 NULL），`create_device_run_binding` 不写**，因此全库每个 Run 只有一条 seq=0；conflict 后冻结新许可；resume offer 的 expected_checkpoint 按 **Run 范围**取最后 recorded 一条（不按 fence 过滤，fence 已 1→2 也不丢基线）；不从头重跑也不重复收费 | device_checkpoint 表（seq=0 行数与来源）、run_offer 帧、Operation 与 provider 计数 |
| EV82 / B03 | 本机 Run 连续两次远程模型请求；第一次响应后立刻断线使 lease 到期；第一次被 seal；Run 从 waiting(input) 重发后恢复；对比云端同 Run 路径 | 每次 register 先把过期行标 expired，每 Run 仍只有一条 live 行；行在 receipt/seal 后转终态；gate 用的 fence 等于 `run.fence` 且 resume 不变；云端 Run 行为不受影响 | runtime_execution 行序列、唯一索引无冲突日志、gate 决策记录 |
| EV83 / B05 | 一人多行 seat 取值不一致；席位只在非 active 行；投影当前为 false 而某行仍 true；投影当前为 true 而 active 行都 false；迁移时是否推进组织 revision；Host 未先发版而 Work 的重复 subject 拒绝已开启 | 有投影记录者一律等于各自投影值（不追加授予、也不额外撤销），不一致者进报告待 owner 显式收敛；无投影记录时按“非 left 行一致为 true”授予、空集不授予；新行 revision 严格大于 Watermark 且归并结果被增量同步观察到；Host 未升级时 R0a 同步与 bootstrap 不受影响 | 迁移报告、`meet_organization.directory_revision` 序列、同步水位与 work.member 前后差分 |
| EV84 / B05 | Host 原生页面授座；重放同一 command_id；跳号事件；伪造事件把 work_seat 从 false 改成 true；只改投影不改事件；事件超期（>365 天）或 Work 长期停机导致跳号后到达；告警责任人验证 | 只有 `kind=seat, desired=true` 且 revision 更高的命令事件解除 host_seat/work_seat_change；command_id 幂等；跳号停止并告警（Work 值班处置）；投影单独变化不解除任何席位类 deny；超期/缺失事件不自动解除，恢复是**固定两步**：先 `advance_governance_event_cursor`（工单引用+区间证明）跨过缺口并把受影响 deny 标 `reconcile_required`，再由持 seat.write 者重做显式授座产生新事件；**只重做授座必须观察到 deny 仍 active**（EV107 同口径）；保留期 ≥365 天且去重记录不早于对应 deny 终结被裁剪 | governance_event_cursor、consumed_governance_command、access_restriction 状态与审计、告警投递记录 |
| EV85 / B05/B03 | 仅停用/启用 User（不改任何 Membership 行）；该用户在两个组织都有 Membership | 每个组织的 WorkMemberState revision 都前进；Work 增量同步观察到 suspended 并建 deny、发取消意图；重新启用按 §3.4 解除且不复活旧 Run | Host 触发器/服务写序、同步日志、access_restriction 与 Run 集 |
| EV86 / B05 | 触发 mass-absence；默认闸门与显式放行各一次；随后恢复某人归并状态 | 被标 absent 者同事务产生 host_member/host_seat deny、access_epoch 提升与取消意图；闸门拦截时不建 deny；恢复路径与其它 host_* deny 一致 | mark_members_absent 结果、deny 与 hint 行、取消 outbox |
| EV87 / B03/B04 | 待审批步骤被取代（同 step_key 两个未终态 Operation 并发）；重发成功后的 Run 提议 completed；被取代的旧 Operation 与旧调度状态检查 | 取代命令内原子取消旧 Operation 并按 `cancel_operation` 实际行为把旧 pending 审批置 **expired**（不是 revoked）；已 succeeded/已结算的旧 Operation 保留终态与结算、不取消不释放；旧调度标 superseded 不计入完成门槛；用过重发的 Run 仍能到 awaiting_acceptance，迟到内容只核账 | 部分唯一索引无冲突、Operation/审批/dispatch 状态、Run 终态与 usage 差分 |
| EV88 / B07/B08 | 安装版桌面分别用合法 Bearer、过期 token、错误 aud/iss、已登出/换号后的旧 token、被吊销 token、缺 `X-Work-Client`、跨站 `Origin`、以及浏览器 Cookie 面调同一写端点；**先测未把 `/work/` 纳入 `isApi` 的现状**（桌面 POST `/work/v2/...`）；再用 30s token 刷新跨越一次 epoch 提升；用 cookie 面的 `session_revision` 值去满足 Bearer 面绑定的 proof（反之亦然） | Bearer 面逐请求经 Host 验真后放行，其余一律 401/403 且不产生任何副作用；**缺 `X-Work-Client` 与跨站 `Origin` 两类必须是 §9 的 `csrf_invalid`/403，不得笼统记成 401/403——该码此前只存在于 §1.1 的承诺、§9 没有行（第十一轮 R11B-10）**；Work 不解 token、不缓存 claims、不写 cookie；`auth_plane` 进审计；两面 `session_revision` 不互相冒充；浏览器 Cookie+CSRF 行为与 R0a 完全一致（回归）。**现状断言：`/work/*` 不在 `policy.ts:94` 的 `isApi` 内时，桌面写请求返回 405**（`renderer.ts:91-92`；SPA/index.html 回退只在 GET/HEAD 发生，不得写成"返回 SPA 页面"）【2026-11-10 J40=A 符号化：`policy.ts:94`＝`src/desktop/src/policy.ts` 的 `isApi` 函数（现读仍在 94 行，`/work/` 确不在其内）；`renderer.ts:91-92`＝`src/desktop/src/renderer.ts` 的 `installRenderer` 内 protocol handler 的非 GET/HEAD→405 分支；行号仅作当日注记，以符号名为准】，且请求根本没到 Work；纳入 `isApi` 后同一请求才可能到达 Work。30s 重新取 token 不得改变 `auth_epoch`；跨面比较一律拒绝——`auth_plane/auth_epoch` 必须出现在每个 proof 的闭合字段集里并可从签名中解出 | Host 验真调用记录、Work 响应矩阵、审计中的 auth_plane、Set-Cookie 缺席断言、R0a 鉴权回归（EV38）、405 现状抓包、proof 字段与签名比对 |
| EV89 / B08/B09 | `local_only` 根 + 已 verified 的 org_private profile；改用 remote_excerpt_allowed 根重试；从 Node/其他设备/其他端点复用同一 binding | `local_only` 上下文发往 org_private 一律 `destination_not_allowed_for_local_only`，逐次批准也不能放行；只有 remote_excerpt_allowed 且逐次批准才发；device_local 同内容仍可发（目的地在设备内） | 出口零字节抓包、目的地校验拒绝、binding 复用拒绝、审批记录 |
| EV90 / B05 | 构造三人：投影 true 而 Host active 行 false、投影 false 而某非 active 行 true、无投影记录且席位只在 suspended 行；再测无投影且无任何 active 行；迁移后重复执行一次 | 前两人迁移后等于各自投影值（**静默窗口内 `work_seat` 逐项相同**，第七轮已禁止"可用状态零差异"口径）并列入报告；第三人按“非 left 行一致为 true”授予；空集情形不授予；重复执行不改变结果也不新增授座事件 | 迁移前后 work_seat 逐人对比表、报告分类、WorkMemberState revision 序列、幂等重跑日志 |
| EV91 / B07/B09 | 绑定创建后静置超过 60s 再探测；rotate 后取新预览；`identity_mismatch` 重新确认后取预览；用旧 probe_preview_hash 签新 local_intent；刷新时篡改 profile/revision；撤销重建绑定与刷新入口对比 | 三种情形都能经 `probe-previews` 取到新的预览+hash+上界并成功探测；旧 preview 不重放、过期即拒；刷新不改变 profile/revision；不需要销毁重建绑定即可恢复（重建路径仍可用但会丢监听身份确认记录） | 各 preview 的 hash/expiry、probe Operation 与 usage 记录、拒绝响应 |
| EV92 / B09 | 同一端口同时有 `0.0.0.0:p` 与 `127.0.0.1:p` 两条 LISTEN 行；四元组匹配不到；匹配到多行；监听进程属另一账户（标准用户读不到令牌）；PID 复用竞态 | 只有四元组唯一匹配且身份可读时才可能放行；匹配不唯一或匹配不到一律拒绝；读不到令牌按 `model_identity_unreadable` 拒绝且**不得视为通过**，服务账户 SID 分支在该矩阵下不可选；PID 复用被创建时间对照拦住 | TCP 表快照与匹配结果、OpenProcess/令牌读取返回值、拒绝与 binding 状态、抓包零字节 |
| EV93 / B04 | 保存流程分步打断：`prepareUserArtifactVersion` 后不确认、确认后 proof 过期、`confirmLocalWrite` 带错误 request_id/sealed_hash、另一 viewer 窗口重放该确认消息、确认前进程崩溃 | 未确认时只存在 `pending_confirm` 草稿且**不发出任何网络请求**；确认后转 `pending_publish` 并签名证明；错误 request_id/hash 与被冒充的确认一律拒绝；崩溃恢复后草稿仍在但不会自动发布 | local_content 状态迁移、journal/DB 断言、网络计数、恢复日志 |
| EV94 / B06 | 一笔 Operation 的预留与结算全流程；同额重放与异额重放；hard 组织账户余量不足；soft 超阈；跨周期到达；用户级用量查询 | **维持现状：每笔 Operation 只在组织账户上写一行预留**，“同 Operation 仅一个 held/unknown”守卫不变（**其实体是 `0002:305-307` 的部分唯一索引【2026-11-10 J40=A 符号化：读作基线 0002 的 `work_quota_one_active_reservation` 部分唯一索引（ON work.quota_reservation(operation_id) WHERE state IN ('held','unknown')）；行号仅作当日注记，现读仍真】，0008 只是加预检——第十轮 R10B-6，断言时要分别验证索引与函数预检，不能只测 0008 那条**）；同额重放返回原预留、异额拒绝；hard 不足直接拒绝且不写预留；soft 只告警；unknown 保留不因降额/过期释放；**用户级硬上限不在本期范围**，按用户拆分只从 usage 事实与 Task owner 出报表，不参与预留或阻断；尝试传 user scope 上限返回 **400 `invalid_request`**（**第二十三轮裁定④改口径：旧文写 422，依据是 §1.1 的“语义输入不符即 422”通则，而两个已落地的 R0b 面对未列字段一律 400——`DisallowUnknownFields()` 失败属请求体不合法；§1.1、§1.2 的 `PossessionProof` 注与 §1.4 第 82 行已同步把 422 限定为取值／上限类码。本端点合同里根本没有 `scope` 字段这一点不变——第十轮 R10A-14、第十一轮 R11A-12**） | quota_account/quota_reservation/quota_entry 前后差分、拒绝码与不写行断言、用量报表与预留账本相互独立 |
| EV95 / B03/B05 | 撤权后设备 journal 中分别存在（a）已持久 completed 但未上报的原始签名字节、（b）只有 started；另测 seq 越界、伪造“撤权后新签的 completed”、key compromised | (a) 可上传并按历史身份核账结算；(b) 保持 unknown/unresolved，只能由服务端权威证据（egress 回执/provider request id/manifest）裁决，并断言 `resolution_source IN (gateway,ops)` 且 `server_only=true`（两者组合才可判定；`server_only` 不是 `resolution_source` 的取值），无证据时保留预留、走 ops 工单；撤权后新生成的完成回执一律验签/窗口校验失败，绝不因需核账恢复权限；compromised 证据只隔离 | recovery-only 帧与拒绝记录、receipt_seq 窗口校验、Operation 与预留状态、`resolution_source` 审计 |
| EV96 / B05/B06 | 停用组织与授座并发、`enabled=false` 与 `ChangeSeat(desired=true)` 并发、降 seat_limit 到已占以下、同 org 未决 Apply 时再发第二条、operator 恢复时存在 host_org/host_member/work_seat deny | 停用先在 Work 建 deny+epoch+取消意图再调 Host，恢复先取 Host 权威回执再解 deny，任一失败停 reconcile；`enabled=false` 期间 Host 拒绝授座并回 `org_execution_disabled`（§9 已补该行，第十轮：此前只有断言没有码；**判定面在 Host，Work 的 `POST /admin/seat-changes` 只原样透传，不另造码**）；降上限不撤现有座、不产生 deny、不写取消意图；未决时第二条返回 `governance_revision_conflict` 且目标 revision 单调；operator 恢复不连带解除其他来源 deny | 命令时序与 command_id、entitlement revision 序列、deny 来源与状态矩阵、被取消 Run 集 |

### 7.11 第五轮复审修订补充（分类来源、正文洗白、送达水位、跨库播种与取代终结）

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV97 / B04/B08 | 同一 Run 挂两个 grant：先读 `local_only` 根，再 `artifact.write` 写进 `remote_excerpt_allowed` 根；设备在 prepare 里少报 classification；succession 改绑时新 grant 报更低分类；跳过披露直接同步；**第十轮 R10A-1 补：只 `list` 过 `local_only` 根、从未 read/search 的同一夹具** | 版本 classification 由控制面按**服务端事实**推导 = max(该 Run 全部 prepare 引用过的 grant 分类含 succession 链, 输出根分类)（**(B) 成果分类下限**，输入集含 `list` 引用），与设备是否自报、报多低无关；succession 两侧分类不同时取更高者且不因此降低既有下限；同步与采纳预览按 local_only 阻断；**补测段两个谓词必须分别断言：模型动作按 (A) 目的地闸放行，成果版本按 (B) 判 `local_only`——只断言其中一侧就无法发现"两个谓词被合并成一个函数"的实现**；**控制面 §4.1 闭集段第 (4) 条声称"三条约束的验收在 EV97"，但本行此前没有这三条（第十一轮 R11B-3 补）：字典序反例（证明实现没用字符串比较，否则 `remote_excerpt_allowed` 被误判为更严）、NULL/集外值反例（一律 `classification_unknown`，不得默认最松；**第二十三轮裁定：该码尚未登记，今天这一支实际冒 400 `invalid_request`，本条负例按届时实现的口径断言、不得按 422 构造**）、比较写成显式枚举序的实现断言；再加 `location=cloud` 版本落 `remote_excerpt_allowed` 的正例，以及"v2 读取 R0a 云任务版本"的通路回归（没有 backfill 时该读取必然失败）** | grant 表分类序列、finalize 计算过程记录、同步入口状态、prepare 帧比对、(A) 放行与 (B) 阻断的同夹具对照记录 |
| EV98 / B08/B09 | 在本机内容窗口复制一段 `local_only` 正文，粘进 Composer 后提交到 org_remote 与 org_private；同一文本走 device_local；粘贴时不点任何确认 | 目的地在设备外时即使只含 user_input 也必须逐次批准，提交预览不构成授权；device_local 仍可走；批准页显示的正是即将送出的完整请求；**`clipboard_derived=true` 时按"本机来源"加严而非放宽**——两处各自的闸都要测：外发闸按本 Run 引用 grant 分类下限判定目的地（§4.2 `consume_device_permit`，命中回 `destination_not_allowed_for_local_only`），成果闸按 §7.1 第 3 步把分类下限抬到 base 与剪贴板来源版本的最严格值（低报回 `classification_floor_required`）；本 Run 曾读 `local_only` 根时，把粘贴文本存成 user 版本再直接同步必须被拒 | 审批请求序列与 hash、出口抓包、taint/来源登记表、`local_content.clipboard_derived` 与 `clipboard_source_version_ids` 行、UserVersionProof 字段比对、EV55 未覆盖路径的补充断言 |
| EV99 / B08 | 打开本机内容窗口并断言窗口参数与 session；对照主窗口 session；尝试从 viewer 触发 DevTools、拼写检查网络、`preload` 暴露面 | `contextIsolation/sandbox=true`、`nodeIntegration/devTools/spellcheck=false`、不加载 `preload.js`、使用独立非持久分区且与 `persist:we-meet-desktop-v1` 不共享 Cookie/存储/缓存；**分区字符串不得含 `persist:` 前缀（本机 §1.1 第 1 条定死为"空 partition＋cache:false"，第十一轮 R11B-17：旧文本两个指令相反，照 `persist:wemeet-local-viewer-*` 实现的那条分支会持久化）** | webContents 参数快照、分区与 Cookie jar 对比、进程与网络观测 |
| EV100 / B03 | resolution 下发后丢 ack；设备换 journal_epoch 后本机已无该 journal 行；撤权设备走 recovery-only 收不到 ack；网关在 session 建立时未重推 | 未 ack 的 resolution 在每次 session 建立时重推（与 receipts 对称）；本机无行时回 `journal_row_missing` 且水位标 `not_applicable`；Run 终态与 run_sealed **不以 ack 为前置**，recovery-only 不要求 ack；不得出现永久卡死的收尾或 tombstone 不释放 | 帧重放日志、resolution 送达水位状态、Run 终态、journal 清理与 release 记录 |
| EV101 / B04 | 保存草稿不确认、超 30 分钟、同 `(artifact_id, base_version_no)` 并发第二个草稿、journal 逼近 256MiB | 未确认只留 `pending_confirm` 且不发网络请求；过期需显式保留或丢弃——**丢弃只能由 §1.1 第 6 条 `confirmLocalWrite{action=discard}` 发起，且该 `request_id` 有未决提交时必须拒绝；`expired` 由下一次触碰懒标（不设常驻定时器），六值闭集见本机 §6.1（第十一轮 R11A-5/R11B-6：此前 oracle 要求"显式丢弃"而全包没有调用得了的入口）**；第二个草稿被单飞拒绝；水位达上限停新保存与新 Run，不删 pending 记录 | local_content 状态与时间戳（含 discarded/expired 两条迁移记录）、拒绝响应、水位与停摆日志、viewer↔主进程消息与 IPC 白名单记录 |
| EV102 / B01/B09 | 慢盘/慢网使 fsync+上传+校验逼近 permit 5s；同一 Run 连续两次模型请求；第一次后设备失联不回；Run 终态后仍有 active 行 | 新函数直接插入 `state='active'` 且 holder/lease 齐全，`input_checkpoint_ref` 可为 NULL（不复用 `register_runtime_execution`）；`lease_until=permit到期+2s` 且 permit 本身仍在边缘校验；残留过期行先标 expired，第二次请求不撞 `one_live_per_run`；`finish_local_run` 把仍 active 的行 revoked | runtime_execution 行序列与状态、gate 决策码、唯一索引无冲突、慢路径时序测量 |
| EV103 / B03 | 对已 succeeded 且已结算的 `resend_undelivered` 旧 Operation 执行取代；对 `held` 预留执行取代；对已终态 Operation 重复取代 | 取消与释放都是条件式：succeeded 保留终态与结算、不释放预留（否则 `release_quota` 抛 `only_held_reservations_can_be_released`）；仅 held 被释放；`cancel_operation` 对终态静默返回不被当作成功；旧调度标 superseded | Operation/审批/预留三元组前后、异常码缺席、device_dispatch 状态 |
| EV104 / B03/B04 | 上一 Run 留有 unknown，当前 Run 全部终结且有成果；分别测收尾、新 Run 准入、采纳 | 收尾判定只覆盖本 Run，当前 Run 可到 awaiting_acceptance；新 Run 准入与采纳仍被 task 级 unknown 阻断（不变量 3）；两个谓词分别有实现与用例，不复用同一个 task 级函数 | 本 Run 与 task 级两套查询结果、Run/Task 状态、拒绝码 |
| EV105 / B05/B03 | 一个用户被注销（`sub=None`、membership 行仍在）；随后其 membership 被编辑；再跑增量与全量同步；另测只停用不改行；再测唯一 active owner、部门主管、`offboard_membership` 失败三种注销场景 | 匿名化前保存最后有效 sub，归并输出发**墓碑项** `status=left, work_seat=false` 并推进 revision，Work 在**增量**内即收窄、建 deny 并发取消意图（不等全量）；响应形状不变、无新增计数字段；增量同步不因 gaps 反复失败、水位正常前进、R0a 写请求不降级；注销三种受限场景分别按 `actor=None`+`transfer_head_to`/`allow_orphan_head`/"最后 owner 必须先移交或整组织停用"处理，失败时整体回滚，**不得先匿名化再报错**，Work 侧维持原投影；`user.sub`/`is_active` 变化都推进 revision | Host 输出项与 revision 序列、Work 投影前后差分与 deny/hint、offboard 失败回滚与审计、`meet_user` 触发器与锁序断言 |
| EV106 / B05 | 跨库播种：`dry_run` 先跑；组织**未带维护旗标**时尝试 Seed；**暂停同步但旗标未置**时提交 Host `ChangeSeat(desired=true)` 再跑 Seed 覆盖；某行在快照后被推进、再用旧 `snapshot_revision` 重放；分批中途中断后用同 command_id 重放；同 command 异 payload；无投影记录的用户 | 只有**该组织带"迁移维护"旗标**期间接受写入——"暂停同步"只停 Work 拉取、不停 Host 治理写，因此必须以旗标为准（缺旗标返回 `governance_maintenance` 的反向：维护期内的普通治理写返回 `governance_maintenance`）；每条 item 以 `snapshot_revision` 做 CAS，行已前进则**不写**并进报告由 owner 复核，不得用旧快照盖回暂停期新授的座或改回刚撤的座；幂等重放返回原结果、异 payload 409；无记录用户走"非 left 行一致为 true"回退；逐人对比报告只声明"静默窗口内 work_seat 逐项相同"，不声明全局行为不变；端口凭据执行后撤销 | 迁移报告（含 CAS 冲突清单）、command 去重行、旗标置位/撤销与治理写拒绝记录、凭据撤销审计 |
| EV107 / B05 | `event_seq` 在两个组织并发产生事件；身份首次启用时已有历史事件；人为制造单组织内跳号；**只重做显式授座、不推进游标**（反例）；再按"先 `advance_governance_event_cursor`、后 `ChangeSeat`"的正确顺序执行；缺口区间内确实还有一条未消费的 seat 事件（用逐条列出分支）；把 `event_seq` 序列挂到 `meet_organization` 上（反例） | 序列按组织独立、跨组织互不干扰；游标初始化取当前最大值，历史授座不回溯；同组织跳号即停并告警、后续事件不消费；**只做授座不推游标时必须观察到 deny 仍 active**（证明"唯一恢复路径=重做授座"是错的）；正确顺序下：工单引用+区间证明通过→受影响 deny 标 `reconcile_required`、写 `governance_gap_skipped` 审计、游标推进，随后新授座事件才真正解除；**逐条列出**分支下被列出的事件按"已消费但不解除任何 deny"处理且不再重放；序列不得放 `meet_organization`（否则 0235 触发器会连带推进 `directory_revision`）；**推进自身的四条负例必须有断言**：缺 `ticket_id`、无 Host 区间证明、`to_seq` 不高于当前游标——三者都返回 `cursor_advance_not_allowed`（§1.4 端点行、§9），游标不动、deny 保持 active；**第四条是第二十三轮随 `0027` 补的：同一个 `client_request_id` 携带语义不同的 payload（换 `to_seq`、换 `gap_report_id` 或换 `ticket_id`）必须返回 409 `idempotency_key_conflict`，且回执仍只有一条——此前的实现会拿前一次命令的成功结果回答，等于给一条从未执行的跳跃发 200（`0027:309-314`／`0027:343-344`，已由 `TestR0bGapSkipReceiptIsBoundToItsPayload` 与端点用例断言）【2026-11-10 J40=A 符号化：两处读作 0027 生效体 `work.advance_governance_event_cursor` 内的 `v_request_hash` 载荷哈希构造与 `idempotency_key_conflict` 拒绝分支；行号仅作当日注记（现读仍真），以符号名为准】**；调用者不持 `org.work.seat.write` 时被拒且不改任何状态 | 两组织事件序列、游标初值与推进审计、两种顺序下的 deny 状态对照、列出事件的 consumed 记录、四条负例的拒绝码（含同键异载荷的 409 `idempotency_key_conflict` 与回执唯一性）、目录 revision 未被事件写入影响的断言 |

### 7.12 第七轮复审修订补充（解除谓词列、复职守卫、验真 resolver、收尾写者与出口闭合）

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV108 / B05 | Work 撤座 saga 建立 `work_seat_change` deny（此时 Host 尚未应用，`host_revision` 必为 NULL）；随后 Host 原生页面授座产生 `kind=seat, desired=true` 事件；反例：把解除谓词写成比较 `host_revision`；再测 `host_seat` deny 同一路径 | 解除一律比较 `release_floor_revision`：NULL `host_revision` 不影响判定，事件 `member_revision > release_floor_revision` 即释放并写 `released_by_revision`；**按 host_revision 比较时必须观察到 deny 永久 active（NULL 比较恒不为真）**，这条反例是本轮 P1 的回归锚点；`released_by_revision` 与 consumed 事件的 member_revision 一致；非席位类 deny 不被连带释放 | access_restriction 行（含 release_floor_revision/host_revision）、授座事件与 consumed 记录、释放前后执行权判定、反例分支的 deny 状态 |
| EV109 / B05/B07 | 注销一名用户（`sub` 被匿名化）后，分别从 admin 视图（`admin_org.py:1108`）、邀请链接接受（`invite_links.py:209`）、成员批量导入（`member_import.py:544`）三个入口复职同一行【2026-11-10 J40=A 符号化：三处依次读作 `src/backend/core/api/admin_org.py` 的 `MembershipAdminViewSet.rehire`、`src/backend/core/services/invite_links.py` 的 `_place` LEFT 分支、`src/backend/core/services/member_import.py` 的 `_apply_one` ACTION_REHIRE 分支（三者都调 `offboarding.rehire_membership`）；行号仅作当日注记（现读仍真），以符号名为准】；成功后立刻跑增量同步 | 三处都在**写库之前**返回 `subject_unreadable` 且 `status` 保持 left；Host 列表不出现 `gaps:["subject_id"]` 项、Work 水位正常前进、`directory_sync_fresh` 不失效、R0a 写请求不转 `service_degraded`；重新供给 subject 后才允许复职，subject 变化时按新 subject 建行、旧 subject 行保持终态 | 三入口响应与 Membership 前后差分、Host 列表项、Work 同步报告与水位、`WorkMemberState.last_subject_id` 与两行状态 |
| EV110 / B05/B08 | 一名成员归并 status 为 suspended/left，分别用现有 `/work-host` 验真路径与新的 `ResolveWorkAccess` 请求同一 subject；另一场景：用户 `sub` 缺失但存在 active membership | `ResolveWorkAccess` 必须返回 `member_status=suspended/left` 的归并结果而不是 401（复用 `get_caller_organization`/`get_caller_membership` 时它们只认 ACTIVE 行 → 401 `session_invalid`，这条反例要单独观察到）；Work 据此给出 `member_inactive` 403 而非 `work_seat_required`；`sub` 缺失时验真拒绝且**绝不签发 `str(user.id)` 作为 subject**；拆码增量未上线前客户端只看到 `work_seat_required`，不得声称已区分 | 两路径响应对照、Work 错误码矩阵、签发 claims 的 subject 与目录项一致性断言、反例分支日志 |
| EV111 / B04/B08 | 断言 R0b 交付面里**不存在**任何"支持包/诊断包"上传端点或命令；尝试把 `local_only` 正文、本机绝对路径、checkpoint 或成果文件放进设备诊断输出与审计导出；只走 §1.4 read-tickets 与本机 §7.3 的限时逐对象读取票据取正文（第十轮 R10A-15：旧引 §7.2 是上行 chunk permit，方向相反） | 除 egress 模型入口与内容 ticket 两条已签收出口外，网络侧无第三条正文上行路径；诊断/审计内容只含 hash、枚举码、计数与随机 ref，出现正文或本机绝对路径即为失败；审计导出不含本机路径（control §8.3） | 出口全量抓包与端点清单比对、诊断产物内容扫描、审计导出 CSV 字段断言、ticket 唯一性日志 |
| EV112 / B03 | 上一 Run 留 unknown、当前 Run 全终结（测 succeeded 能否写入）；对 `cancel_requested` 的 Run 提议 completed；对已 succeeded 的 Run 重复 finish；Run 经取消路径进终态时残留一条 active `runtime_execution`；模型 receipt 落库后检查该行状态 | 本机终态经**新增的 `finish_local_run_state`** 写入：task 级 `task_has_blocking_operation` 不参与本 Run 判定（复用 `work.finish_run` 时 succeeded 会被 `run_has_unresolved_operation` 拒绝，这条反例必须单独观察到）；`cancel_requested` 返回 `run_cancel_requested`（生效体 `0002:3252-3254` 已有此拒绝，**不是本机新增**；第八轮已更正第七轮"该函数不检查 cancel_requested"的错误断言）；终态重复 finish 只回读原 `terminal_run_revision`、不再抬 `control_revision`，且**幂等键必须是 `finish_id`**：同一 Run 上不同 finish payload 而 outcome 相同不得被静默吞掉（生效体 3248-3250 按 outcome 判等，做不到这一点）；`failed 或 canceled` 在 `cancel_requested` 下不覆盖 `terminal_reason`（生效体 3261-3267 会覆盖）【2026-11-10 J40=A 符号化：本格三处行号同指基线 0002 的生效体 `work.finish_run`（`CREATE OR REPLACE`）——`0002:3252-3254`＝其 `run_cancel_requested` 拒绝分支，3248-3250＝按 outcome 判等的幂等早退，3261-3267＝无条件写 `terminal_reason` 的 UPDATE；行号仅作当日注记（现读仍真），以函数名＋分支语义为准】；取消收尾同事务 revoke 残留 active 行；`completed` 只由 `record_device_receipt → complete_device_model_execution` 写入（`attach_dispatch_receipt` 与 `commit_runtime_checkpoint` 都不是写者） | 两函数分支的 SQL 断言、Run/Task 状态与 revision 序列、runtime_execution 状态时间线、拒绝码 |

### 7.13 第八轮复审修订补充（unknown 阻断强制点、本机用量写者、封存证明落点）

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV113 / B03 | 本 Run 留一条 `unknown`，设备继续发下一个 `action_prepare`；同状态下再调 `consume_device_permit`；同状态下 `renew_device_lease` 与 receipt/checkpoint 上行；随后迟到 receipt 到达并核账 | 不变量 3 的两个强制点都命中：`prepare_local_operation` 与 `consume_device_permit` 同事务断言本 Run 无 unknown/unresolved，回 **`run_has_unreconciled_operation`**（与被拒动作自身无关的 `execution_unknown` 不得复用，R9-9），不建 Operation、不预留配额、不发许可；`acquire_device_lease` 不签新 `run_start`；**但 `renew_device_lease` 与 receipt/checkpoint 上行必须放行**（否则设备传不回迟到证据，unknown 变成无人可推的死锁）；迟到 receipt 核账后上述三个拒绝点自动恢复；**收尾的转移边要一起验（第十一轮 R11B-1）：Run 处于 `waiting(reconcile)` 时直接提议 `succeeded` 必须以 `invalid_transition:run:waiting->succeeded` 失败，只有 `finish_local_run_state` 在同事务内走 `waiting→active→succeeded` 两步才成立**；**并验收 J12 的边界**：unknown 未清或租约已过期时，为"核账与收尾"新签的 lease 必须成功，而该 lease 存续期内**零新 `run_start`、零新 Operation、零新许可**（`lease.purpose` 可审计），此时提议 `run_finish(failed)` 仍须通过 §6.4 第 1 条的 lease 精确匹配 | 三命令的判定日志与拒绝码、配额无新增行、lease 续租与 purpose 记录、收尾期零新许可的断言、核账后新动作可签出的正例 |
| EV114 / B06/B09 | `device_local` 与 `org_private` 各完成一次模型调用；尝试用云厂商枚举值（如 `aliyun`）为本机调用填 provider 以通过**生效函数守卫**；对照守卫的真实位置 `increments/0009:1404-1406`（生效 `record_usage`）与 `0009:1498-1500`（`finish_operation_from_receipt`），**第十轮 R10B-1：旧文本引的 `0002:316、347` 是 `provider_credential`/`provider_access_config` 两表的 CHECK、与用量写入无关，`0008:225-227` 已被 `0009:1385` 整段覆盖，两者都不得再当证据**【2026-11-10 J40=A 符号化：本格行号引用一律改读符号——`increments/0009:1404-1406`＝0009 生效体 `work.record_usage` 的 provider 守卫；`0009:1498-1500`＝`work.finish_operation_from_receipt` 的 provider 守卫；`0009:1385`＝`CREATE OR REPLACE FUNCTION work.record_usage`（覆盖 0008 死体）；`0002:316、347`＝基线 `work.provider_credential`／`work.provider_access_config` 的 provider CHECK（错表）；`0008:225-227`＝0008 版 `work.record_usage` 守卫（死体）。行号均仅作当日注记（现读仍真），以符号名为准】；renderer/Node 直接调用该函数 | 用量必须由**新增 definer `record_device_model_result`** 写入并标 `usage_source='device_adapter'`（**列名是 `usage_source`（`0009:296`【2026-11-10 J40=A 符号化：读作 0009 `CREATE TABLE work.operation_usage_fact` 的 `usage_source` 列定义；行号仅作当日注记，现读仍真】），表里没有 `source` 列，另有一个 `origin` 列不得混用——R10B-3**），provider 取本机/私有 profile 的专用值、**不得为空也不得填云厂商名冒充**；同批必须 (a) 扩 `operation_usage_fact.usage_source` 的 CHECK 增加 `device_adapter`、(b) 为新增 definer 单独放开或另立 provider 判定，**否则生效函数守卫会直接拒绝本机用量**（不是"现有 CHECK 拒绝"，实现者拿 ALTER CONSTRAINT 找不到可改的约束）；结算沿用 record_usage→settle 且只一行；`work_api`/renderer 无 EXECUTE；usage 报表能把本机与云端分列 | **函数守卫反例断言**（分别用云厂商枚举值、空值、`usage_source` 集外值各打一次，记录抛出的 `invalid_request:provider`/`invalid_request:usage_source`）、行内容与被改的 CHECK 增量、权限（catalog 断言 `work_api` 无 EXECUTE）、结算与预留差分、报表分列截图、越权调用拒绝记录 |
| EV115 / B03 | Run 终态后立即请求 `issue_run_seal`（receipts 尚未全部 durable-recognized）；核账完成后重发同 seal_id；设备不回 `run_sealed_ack`；设备永久失联（水位 `not_applicable`）；设备在收到 seal 前尝试清理 Action tombstone；**session 重建后未 ack 的 seal 是否重推；recovery-only 会话读取 seal 但不推进 Run（第八轮 R9：S14 曾声称本条覆盖，实际原文没有这两个断言）**；按 §4.1 表字段签出的封存能否通过本机 §3.1 的闭合信封校验（`generation`/`final_operation_set_hash`/`durable_proof_ref` 缺任一即失败） | 前置不满足时回 `seal_precondition_pending` 且不签封存证明；同 seal_id 幂等返回原签名；ack 只推进 `device_run_seal.seal_delivery/acked_at`，**不阻塞 Run 终态与 tombstone 释放判定**；未收到 run_sealed 证明时设备不得清 Action tombstone（本机 §6.4），清理只按已 recorded 的 release 水位与 seal 双条件推进；三个 ack 帧（`operation_resolution_ack`/`journal_ack`/`run_sealed_ack`）都必须由 `consume_device_ack` 有写者，不得出现无主列 | device_run_seal 行与签名、两类水位状态、tombstone 存活与清理时间线、ack 消费日志 |

### 7.14 第九轮复审修订补充（披露决定的产生者、封存字段对齐、运维证明载体）

| ID / 需求 | 前置与注入 | 期望事实 | 必交证据 |
|---|---|---|---|
| EV119 / B01/B07/B09 | 组织只发布 `org_remote` profile、任务所选根含 `local_only`：在预览阶段就请求该组合；随后只 list 该根并提交模型动作；再在其后做一次 `workspace.read` 并重放同一 preview_hash；**第十一轮 R11C-7：本行必须分两种组织夹具各测一次——(i) 组织可以发布 `device_local`（建议句含"联系管理员开通设备内执行"）；(ii) RB-A20 三要素不齐、`device_local` 按 §8.4 根本不可发布（建议句只能剩"请改选允许脱敏摘录的目录"，出现"开通"承诺即判失败，并须显示不可发布的原因）** | 预览阶段返回明确拒绝＋`unavailable_reason=no_device_destination`＋可行动建议，**建议只能是本档 §2.2 第 5 步那两句原文里的出口：改选允许脱敏摘录的根，或联系管理员开通设备内执行**（**第十一轮 R11A-6：旧写"或用 `device_local`"是自相矛盾的假出口——本行夹具明写组织只发布 `org_remote`，此刻 device_local 按定义不可用；要提 device_local 只能以"请管理员开通"的形式出现**），**零副作用**：不建 Task/Operation、不写审批、不预留配额；list-only 情形仍放行（J11）；read 之后新模型动作为 `destination_not_allowed_for_local_only`；该组合的出处是**三处且只有三处**：架构 §1.1（本期不支持声明，第十轮 R10A-5 补的归属）、控制面 §1.2（枚举 `unavailable_reason=no_device_destination`）、本档 §2.2 第 5 步（用户可见句子）——三处必须逐字同源，实现期不得自造话术或另立矩阵；**建议出口与 §2.2 第 5 步完全一致，不得出现"用 `device_local`"这类在本案夹具下不可走的选项** | 预览响应与 `available_destinations`/`unavailable_reason` 字段、Task/Operation/审批/预留的零新增行断言、list-only 正例的模型调用成功记录、界面文案截图与错误码出处 |
| EV120 / B03/B04 | 只读动作（`workspace.read`）journal 丢失、无任何 egress/provider 证据；**先逐项拆掉五项前置各测一次负例（lease 未过期／设备仍可走 recovery／有 gate 事实／有 egress receipt／动作是 `artifact.write` 或模型调用）——每种缺项都必须仍留 unknown 并阻断**；随后测该 Task 的新 Run 准入与采纳 | 五项前置齐备的只读类动作由服务端 `issue_operation_resolution` 签 `failed` + `code=evidence_unavailable` + `settlement_state=unknown` 的降级终态，Run 的 `wait_reason` 由 `reconcile` **改判为 `input`（不是清空）**、不计为"已执行成功"、不产生成果版本；**预留必须原样保留为 `unknown`，既不释放也不结算**（第十轮 R10A-2：EV94 已签的"unknown 预留不因降额/过期释放"在此不得被顺手放宽，且 `release_quota` 对非 held 本会拒绝）；该 Task 的新 Run 与采纳**不再被永久阻断**；**第十四轮 J38 把本行从"两向"扩为"三向"**：①只读类五项前置齐备 → `evidence_unavailable` 降级；②副作用类**前置不齐**（例如仍能拿到 gate 事实、或工单缺失）→ 维持 unknown/unresolved 与全部阻断；③副作用类**前置齐备** → `evidence_exhausted` 降级，此时必须同时断言**新 Run 准入被放开**、**采纳被 `acceptance_blocked_unresolvable`/409 拒绝且零 acceptance 行**、**预留仍为 `unknown` 且无 release 条目**、成果可本机查看与导出；三个方向各测一次，任何一方向缺失即判本 EV 未覆盖；审计记录降级判定依据（许可过期时间、journal 不可得、无 receipt、无 gate 事实、工单号）；界面在 `wait_reason=input` 下给出"继续/起新 Run/结束"三选，不出现"重试该只读动作"的假入口 | operation_resolution 帧（state=failed、code=evidence_unavailable、settlement_state=unknown）、**`operation.state` 落 `reconciled` 的行断言与 `task_has_blocking_operation` 转 false 的正例（第十一轮 R11B-1：把 Operation 直接写 `failed` 必须以 `invalid_transition:operation:unknown->failed` 失败——白名单未登记该边，这是"文档词汇与 DB 白名单一致"的强制验收）**、`quota_reservation` 前后差分（应仍为 unknown 且无 release 条目）、`wait_reason` 取值序列与 `control_revision` 抬升、五个负例各自仍 unknown 的行、新 Run 准入/采纳的正例、有副作用两类仍阻断的对照行、审计中的降级判定依据字段、成果版本零新增断言、界面截图 |
| EV121 / B04/B07/B09 | **J15（第十一轮拍板：(B) 含 `workspace.list`，接受退化但必须提前告知）**：任务只挂 `remote_excerpt_allowed` 根 → 预览显示成果可同步；所选根含 `local_only`（即使计划中只有 list 动作）→ 预览显示"只留本机、不可云同步"；成果生成后点同步仍按原规则拒；用户在提示后仍提交任务 → 执行不受影响、成果照常本机可用 | 预览必含 `artifact_classification_floor` 且值与服务端所选 grant 分类一致；含 `local_only` 时告警出现**在选择目录/预览阶段**，不是成果页或同步按钮后；提交不因该告警被阻断（B01 的本机整理与采纳仍完整可交付）；`local_only` 成果点同步仍 `destination_not_allowed_for_local_only` 且零写入；不存在任何"确认已知晓即可同步"的绕过入口（B08） | PreviewV2 字段快照、两种类别的界面截图、提交后 Run/Operation/成果行数对照、同步拒绝响应与零副作用断言、**改绑或换 grant 使实际 (B) 比预览预测更严时，任务页必须在同步前再次提示（第十二轮 R12C-13：预览用"所选 grant"、生效用"被引用 grant"，两者可偏离，缺这一例就仍可能到点同步时才第一次知道）**、无绕过入口的交互走查 |
| EV122 / B01/B03/B04 | **J16（第十一轮拍板：不放宽不变量 2/3，改修"没人能推"与"看不见在等什么"）**：副作用类动作（`artifact.write`/模型调用/外发）留 `unknown` 且 journal 不可得，观察用户可见状态与出口；另测运维一次性作业 `work-reconcile` 无凭据/无工单引用/伪造设备自报 evidence 三种输入；再测用户删除 Task 后的宽限期行为（本机查看与导出、票据要求、跨设备恢复读取） | 三类副作用动作**一律不得**套用 `evidence_unavailable` 降级终态，仍留 unknown 并阻断续跑/新 Run/采纳；界面必须显示"该动作正在人工核账，成果暂不可采纳"＋等待时长与联系路径，不得呈现为无解释的卡住（EV §3.1 需有该状态行）；三种非法运维输入全部拒绝且不写业务表（角色/凭据来源/evidence 边界/SLA/工单引用/强审计须在运维文档逐项具名，J16 把它变成硬要求）；删除后本机在 24h 宽限期内仍可查看与导出既有成果且**不要求控制面票据**，宽限期后清除密文缓存；tombstone 后跨设备/Web 的恢复读取始终被拒 | 状态与文案截图、`unknown` 行的前后差分、三种拒绝记录与审计、宽限期前后的本机导出对照、票据与 ACL 断言 |
| EV123 / B01/B02/B04/B08 | **第十一轮 R11C-1′／R11A-5 收尾：证明与窗口的载体正反例**——(1) 采纳、恢复、读取票据、同步四个动作各走一次正常签署；(2) 缺 viewer `signObjectProof` 手势（或该消息由主窗口/其它 frame 伪造）时分别尝试四个动作；(3) 缺 `confirmDisclosureDecision` 手势时尝试披露与同步；(4) `sync_disclosure` 窗口打开时断言渲染源；(5) renderer/Node 直接调四个端点 | 正常签署时各动作成功且 proof 的 `purpose` 与端点匹配；**缺手势时 Broker 不签任何 proof、主进程一条请求都不发、控制面零行**；伪造 purpose 或跨 purpose 复用同一 proof 一律验签失败；非 viewer 主 frame 发出的 `signObjectProof`/`confirmDisclosureDecision`/`confirmLocalWrite` 全部按 §1.1 第 6 条发送方谓词拒绝；`sync_disclosure` 窗口正文只能来自本机封存副本、目的地与留存说明只能来自服务端下发集合，主窗口/renderer 传入的字符串一律不采信；renderer/Node 直调被专用 authz 拒绝且不写行 | 四类 proof 的签名与字段对照、无手势时的抓包零请求断言、IPC/消息拒绝记录、窗口渲染源快照、控制面行数前后差分 |
| EV116 / B04/B08 | 对 `local_only` 版本请求披露决定；对**分类本就为 `remote_excerpt_allowed`、且来源 Run 只读过非敏感根**的版本（`source=user` 版本也可，但其分类下限必须已按控制面 §7.1 第 3 步/EV98 判为 `remote_excerpt_allowed`；base 或剪贴板来源含 `local_only` 的一律判回、不可同步）签披露决定后同步——**第十轮 R10A-6：J13 之后没有"派生版本"这一类对象，前置不得再写它**；签署载体只有 viewer `confirmDisclosureDecision` 一条，另测 renderer/Node 直接调端点；同 proof 改 destination/retention/content_hash/bytes/format 逐个重放（**第十三轮 J29：proof 绑定的字段逐项点名，不再只写"任一字段变化"**）；决定过期后再点同步；同一决定用于第二次同步；跳过披露直接 POST syncs | `local_only` 版本请求披露决定一律 `destination_not_allowed_for_local_only` 且**不写任何行**；合法披露决定落 `disclosure_decision` 且 classification 不被追改；缺决定或已消费的 syncs 返回 `disclosure_decision_required`；proof 任一字段变化验签失败、不同步；过期决定不可用，须用户在本机内容窗口重新确认；finalize 消费的 hash 与版本 content_hash 逐项一致；同文第二次同步必须新确认；**载体断言（第十轮 R10A-7）：缺 viewer `confirmDisclosureDecision` 手势时 Broker 不签 proof、主进程一条请求都不发；renderer/Node 直接调 disclosure-decisions 或 syncs 按专用 authz 拒绝且不写 `disclosure_decision`、不建 upload-session；`retention_notice_id` 不在 BootstrapV2 当前 `retention_notices[]` 内即 `disclosure_decision_required` 且零写入** | 端点响应、`disclosure_decision` 行与状态、artifact_version 分类未变的断言、出口抓包、审计与 publish 记录、viewer↔主进程消息与 IPC 白名单记录、bootstrap `retention_notices[]` 快照 |
| EV117 / B05 | 跳号后由 `consume_governance_events` 生成 `governance_gap_report`；运维分别用「无报告」「报告区间不覆盖」「报告含未列出的 seat 事件」「报告齐备」四种输入调 `POST /admin/governance-event-cursor`；随后再走一次显式授座 | 前三者都返回 `cursor_advance_not_allowed` 且游标与 deny 不变；第四者推进游标并把 deny 标 `reconcile_required`；**其后到达的授座事件必须能命中 `reconcile_required` 的 deny 并转 `released`（第八轮 R9-7：若消费方只扫 active，两步恢复的第二步永不生效）**；报告由事件身份写、`work_api` 不可写；**第十轮 R10A-11：同一 `gap_report_id` 第二次推进（换 request_id/ticket_id 也算）必须 `cursor_advance_not_allowed`，状态迁移只允许 `pending→consumed`，闭集中不再存在 `discarded`** | gap_report 内容与 host_fetch_seq、三次拒绝码、deny 状态全链（active→reconcile_required→released）、consumed 记录与审计 |
| EV118 / B01/B08/B09 | **夹具前置（第十轮 R10A-4）：组织同时发布 `device_local` 目的地**——否则该组合命中 J14 的本期不支持项、预览阶段即拒，下面第一段的"必须放行"不成立，改由 EV119 覆盖；**只 list `local_only` 根**后提交 `org_remote` 模型动作；随后做一次 `workspace.read` 再提交同类动作；再测已 prepared/authorized 的动作在 permit 时才出现 taint；再测 list 结果（文件名/大小）被 Node 拼进待发正文后走远程目的地；反例：把 read 引用伪装成 list 上报 | 第一段**必须放行**（证明粗闸不过度阻断，J11）：list 引用不进 **(A) 目的地闸引用集**；同一 Run 的成果版本仍按 **(B) 成果分类下限**判 `local_only`（与 EV97 同夹具对照，两侧都要断言，只测目的地侧发现不了两个谓词被错误合并，第十轮 R10A-1）；read 之后新的模型动作在 `prepare_local_operation` 即拒 `destination_not_allowed_for_local_only`，**不建 Operation、不写审批行、不写 `quota_reservation`**；已 authorized 的动作在 permit 复验被拒时按其拒绝路径释放预留并置 `canceled`（**第十二轮 R12C-14：旧文本要求记 `rejected_not_executed`，而控制面与本机都规定"未执行"只认三种权威回执，permit 阶段被服务端拒绝时设备从未拿到许可、不可能签出该回执**；不得留悬挂预留）；预览与确认页显示"本 Run 已读取 local_only 内容，设备外目的地不可用"及当前可用目的地列表；list 元数据进正文的场景必须由设备 provenance 细闸＋逐次批准拦下，且批准页显示的确切 bytes 含这些文件名；伪装引用被服务端按 grant 实际动作类型判定驳回；**第十一轮 R11A-1 补：所选 `artifact.write` 输出根本身为 `local_only` 时，即使从未 read/search，(A) 也必须触发拒绝——与"只 list 敏感根仍放行"成对照，证明输出根确实在 (A) 集合内** | Run 引用动作类型序列与推导出的下限值、三个时间点的 Operation/审批/预留行数（应为 0）、PreviewV2 与确认页文案、细闸批准页字节比对、拒绝码与释放记录 |
| EV124 / B01/B02/B07/B09 | **J19（第十二轮拍板：目录分类由组织映射决定，用户只能在允许选项内收紧）**：组织配了"某卷/某前缀→`local_only`"的有序规则后新选目录；用户试图确认得更松；无匹配规则时选新目录；管理员改映射后已有 grant；映射完全未配的组织 | 分类值由服务端按 `local_execution_policy.classification_rules` 判定并落 `workspace_grant.classification`，设备申报值仅作交叉核对、低于判定即 `classification_floor_required` 且 grant 登记失败；用户确认只能更严，界面不提供放宽控件；无匹配条目一律取 `classification_default`（缺省 `local_only`），并在授权页明写"该目录被组织策略判为只留本机，原因：映射第 n 条/默认值"；改映射不追改既有 grant（后续动作复验按新策略时不得静默放宽）；完全未配映射的组织＝全部新目录 `local_only`，此时界面必须给出"成果不可同步＋无设备外模型目的地"的既有告警而不是让用户以为坏掉了 | grant 行 classification 与规则序号对照、放宽尝试的拒绝码、无匹配默认值断言、授权页文案截图、改映射前后同一 grant 的后续动作判定 | 
| EV125 / B01/B07/B09 | **J20（第十二轮拍板：配了目录分类映射才允许开本机能力）**：未配映射的组织里普通用户尝试配对设备／登记目录／提交本机任务；管理员配好一条映射但未确认默认值；两者都补齐后同一用户重试；已存在活跃 grant 的组织事后清空映射 | 前三类入口一律 `local_policy_not_configured`/409 且零副作用（不建 device_session、不登记 grant、不建 Task、不预留配额）；BootstrapV2 的 `execution_profiles[]`/`allowed_permission_modes[]` 为空数组，选目录入口置灰并显示"联系管理员配置目录分类策略"，**界面不得给出用户自选分类的绕行控件（J19）**；默认值未确认时同样拒（映射条目本身不构成开通条件）；补齐后立即放行且无需重新登录；事后清空映射不追改既有 grant 已判定分类，但**新的 grant 登记与新的本机任务被拒**，任务页对受影响用户显示原因而非报错；**第十四轮 J37 新增一例**：管理员配了映射但每条规则都判 `local_only`（就是照 J22"全严起步"模板配、尚未放宽任何根），且组织未发布可用的 `device_local` profile（**`org_private` 不算**——第二十一轮按本机 §5.1 更正：`local_only` 目录的正文一律不得发往 `org_private`；第二十三轮把本文件里残留的两处也改齐） ⇒ 三类入口返回 `local_policy_incomplete`/409 且零副作用，界面句子指向管理员（"管理员尚未放宽任何一个根"）而不是给用户自选控件；放宽任意一个根后同一用户立即放行、无需重新登录 | 三类入口的拒绝码与零新增行断言、bootstrap 快照、界面置灰截图、补齐后同一账号成功配对的正例、清空映射后新旧 grant 的对照、**J37 两例（全严映射被拒／放宽一根后放行）的拒绝码、零新增行与可见文案** |
| EV126 / B02/B08/B09 | **正向端到端锚（第十二轮 R12C-15／R12C-2）**：基准任务（§8.1 夹具）在默认 `ask_each` 档一次跑通；同夹具在 `local_only` 根＋已发布 `device_local` 的组织跑通一次；再造一条副作用类 `unknown` 且 journal 不可得，用 `GET /runs/{id}/reconciliations` 查状态；非 owner／无席位／跨设备调该端点 | 默认档一次跑通：审批次数＝9、终态 `awaiting_acceptance`、成果已发布并可采纳，**审批次数与 §8.1 表一致（不一致即判本档失效）**；`device_local` 档同样跑通且零设备外请求；核账查询口返回 `reconcile_requested_at`、等待时长、受影响必选结果与是否已有权威证据，且**只读、不改变任何状态、不解除阻断**；越权调用一律 `permission_denied`/403 或 404（§9 的无码 404），不泄漏对象是否存在；B08 侧同时断言该端点响应不含正文与本机绝对路径；**第十四轮 J38 追加一条端到端腿**：副作用类 `unknown` 在五项前置齐备后签 `evidence_exhausted`，此时**同一 Task 的采纳必须 409 `acceptance_blocked_unresolvable` 且零 acceptance 行、开新 Run 必须成功、原成果仍可本机查看与 `exportArtifactVersion` 导出、`quota_reservation` 仍为 `unknown` 无 release**——三件证据缺一即判本 EV 未覆盖 J38 | 审批计数与操作日志、两档 Run 终态与成果行、查询响应快照与等待时长、三类越权拒绝记录、响应字段扫描 |

## 8. 实施验证步骤

以下为获批实施后的执行顺序，不是本轮执行记录；每步不满足出口则停在该层，不以 mock 或旧版本数字替代真实证据。

**【2026-11-10 卡片 E=B：EV 归属与排程修订】** 按 [B03 载体设计](work-r0b-b03-reconciliation-carrier-2026-11-10.md) §5：**本期不执行**（随正文离机链移出）EV95（recovery 通道）、EV51（recovery 限流）、EV63/EV107（device egress 入口）、EV116/EV123 的 sync 腿；**改写** EV100（去 recovery-only 腿、ack 缩到 resolution）、EV115（seal 三类 ack 水位→finish ack＋resolution 水位）、EV102/EV114（device_local 保留、device-egress 去）、EV97/EV98（classification 本机闸保留、sync 路径去）、EV121（分类下限预览告知保留）；**保留且更承重** EV80/EV113/EV120/EV70/EV71。下表 I4 行的 EV95/EV63、UV04 的"仅同步选中版本/另一端查看"本期不适用（云同步移出）；I 编号与架构 §6 的对齐随 #43 修订。原文保留供追溯。

| 顺序 | 实施及验证工作 | 出口/阻断条件 |
|---|---|---|
| I1 合同冻结 | 对齐架构 B01–B10、control 权限/状态/错误/命令字段、device 身份/工具/审批正文接口，冻结 profile 计数夹具 | 有逐字段映射与负例；委派规则、Host 写、正文隔离未审清不得进入真实数据 |
| I2 领域与 Host | 在独立测试组织/数据库实现并发命令、Host 权威写/deny/`record_audit`+§3.1 治理命令事件（**Host 侧不存在 outbox，不得按"权威写/outbox"验收**）、Work 侧 outbox、token/RLS；执行 EV23–EV32/EV38/EV44/EV74–EV77/EV83–EV86/EV90/EV94/EV96/EV105–EV110/EV112 | 新权限不被 admin 通配继承；席位/取消/账本可交叉核对；`work_seat_change` deny 在 NULL `host_revision` 下仍可经授座事件解除（EV108） |
| I3 真安装/Broker | 构建固定签名发行组合，在干净 Windows 标准用户执行 EV01–EV08、EV72/EV73、EV78/EV79 | F13/F27、安装链、窄 IPC、本机内容窗口出网任一失败不做真实客户文件测试 |
| I4 编排/恢复/模型 | 真实 PG+Temporal+Gateway+Broker+模型执行 EV09–EV18/EV40–EV42/EV63–EV67/EV70/EV71、EV80–EV82、EV87、EV91/EV92/EV95 | unknown 不重发、同步持久性与断网/重启结果证据完整；mock 只辅助定位 |
| I5 前端/成果 | 接入现有组件并执行 EV19–EV22/EV33–EV37/EV43/EV45/EV68/EV69/EV93、EV88 | 本机数据分支不经过云端 input/content；按能力拒绝与可访问性通过 |
| I6 云端回归 | 同一候选构建执行 EV38–EV44，并重复 EV26/EV29 的云端分支 | R0a 提交/模板/取消/成果/鉴权/计量/迁移不退化；不得仅跑本机 happy path |
| I7 用户与运维 | 完成 UV01–UV07、灰度关闭/回滚、真实安装升级和恢复演练；收齐 §9 证据 | 继承 R0a 退出门及 R0b 准入评审另行判断；设计完成不等于可试点 |

可用性招募原口径（**第十四轮 J39 改写：这是无人力承接时的诚实替代，不是降低证据要求**）：目标仍是 7–8 名合作伙伴用户、其中至少 3 名治理者；**在单人开发现实下凑不齐时，该门槛一律标 `not_run`，不得把自测或专家走查报成"已满足"**。可执行的最低替代：主签按 UV 脚本逐条自测并留录屏；能找到的**非项目成员**（任意 1 名）走查一次即单独记录其身份与观察；找不到就写"无外部使用者"。使用获准的真实候选安装包和合成资料，不新建 UI 原型。主持人只读任务、不指路，辅助完成单独计为失败；录屏须同意并脱敏。**自测结果的分母与来源必须在报告里标明是"主签自测"还是"外部使用者"**——两者不可混在同一个通过率里。

| ID | 前置 | 注入/任务 | 期望事实 | 证据 |
|---|---|---|---|---|
| UV01 云端首任务 | 新用户有席位/云端可用 | 用既有模板创建方案并解释执行边界 | 能提交并说明云端不访问本机；观察 60 秒内提交目标，不冒称已达成 | 起止时间、操作录屏、四问逐字回答、失败原因 |
| UV02 本机整理 | 已安装合格 Windows 包，未授权目录 | 找到本机、授权文件夹、预览后提交 | 能说清当前设备执行、读取范围、原文件不上传及摘录可能外发 | 实际授权/提交事件、四问回答、完成时间 |
| UV03 审批/撤销 | 有读、写、外发三类待审批任务 | 批准一次、拒绝一次、撤销只读允许 | 理解拒绝后果、同类许可边界，不认为读取批准等于外发/同步；**能说出"人工核账中"意味着什么（在等什么、大约多久、成果为什么暂时不能采纳），不把它读成系统坏了（第十二轮 R12C-2 的可理解性一侧）。**；**能说出审批有效期与"同一步骤最多取代 5 次"的后果（第 6 次要重新预览或结束 Run），不把"已取代 n/5"读成系统卡住（第十轮 R10A-12）** | 决定/撤销审计、口述、错误点击与主持辅助记录、核账状态文案截图与 `GET /runs/{id}/reconciliations` 响应 |
| UV04 成果采纳 | 已核账 local-only 两版本 | 选择版本采纳，仅同步选中版本，再用另一端查看 | 理解不可变/采纳不等同步/跨端只元数据，能找到本机文件 | 版本与同步事实、录屏、理解回答 |
| UV05 待处理/未知 | 我的工作中有审批、离线、unknown 三任务 | 找“需要你”并处理，询问未知结果下一步 | 能区分批准、重连核对与禁止重发；不期待换设备接管 | 导航路径、回答、误操作与关联状态 |
| UV06 首用/过渡 | 新用户引导、旧任务链接、一个不兼容桌面 | 跳过/重看、查看导出旧成果、理解升级提示 | 不自动提交，旧任务只读及原设备内容可达性可解释 | 录屏、旧 URL/导出事件、理解与时间记录 |
| UV07 治理 | 至少 3 名获委派治理者，包含无席位者 | 授予/撤席、处理满席、调 token 护栏、导出审计 | 能完成授权/撤销/护栏/审计；理解 soft/hard、权限分工与不读正文 | Host/命令/账本/导出记录、治理者逐人结果与 SEQ |

通过口径：各适用 UV 任务完成率 ≥80%，UV07 至少 3 名治理者完成；边界/数据去向和审批理解正确率各 ≥90%，SEQ ≥5/7。记录分子/分母，不把不适用或主持辅助当成功；首次任务 ≤3 分钟（**第十一轮 R11C-4′ 拆口径：本目标只计"选定目录 → 提交成功"的界面耗时，不含用户在无网络窗口内阅读与批准所花的时间——逐次审批下这条链必然超过 3 分钟，把它算进通过口径等于逼实现压缩人的阅读时间。审批次数、切窗次数与签名次数按"基准任务计数表"单独考核，设计期必须先算出来，不得留到试点**）、正常网络状态变化 ≤2s 可见分别记录任务起止/服务端提交至渲染时延，不把目标写成实测。
安全越权、正文外泄、未知重发、隔离逃逸为阻断项，不以用户满意度抵消。其余 P1 须修复或有明确接受理由与复验安排；无证据不得归零。



## 8.1 基准任务动作计数（第十一轮 R11C-4′ 补：此前"摩擦已量化"只有 TTL 乘积，没有一次任务的动作数）

**基准任务**：1 个文件夹 → 2 次 `workspace.list` ＋ 3 次 `workspace.read` ＋ 1 次 `workspace.search` ＋ 2 次设备外模型动作 ＋ 1 次 `artifact.write` → 查看并采纳 1 个成果。一次"审批"按本包交互记 3 个用户动作（主窗口点"在本机查看并决定" → 无网络窗口内阅读并决定 → 关窗回到主窗口）。

| 档 | 审批次数 | 审批动作数 | 必须在本机窗口完成 | 其它动作（配对/选目录/输入/提交/采纳证明） | 合计 |
|---|---|---|---|---|---|
| 默认 `ask_each` | 9（6 只读＋2 外发＋1 写成果） | 27 | 10（9 次决定＋1 次 `signObjectProof(accept)`） | ≈11（配对、系统选择器、原生框确认位置与分类、读预览、输入、提交、主窗口点查看、主窗口点采纳；采纳的「打开窗口→阅读→关窗」按本表口径就是 3 个动作，不再另计一次证明） | **≈37（下界）** |
| `auto_readonly`（组织与快照都允许：只读动作走 policy_auto，**不建 Approval**，仍登记 Operation/hash/审计） | 3（2 外发＋1 写成果） | 9 | 4（2 次外发批准＋1 次写成果批准＋1 次采纳证明） | ≈11 | **≈21** |
| `ask_each` ＋ 已签「同类只读允许」（**同一 Run 内**追加同类只读，见下行限定） | 3（只读合并为一次同类许可；外发与写成果仍逐次） | 9 | 4 | ≈11 | **≈20**；同一 Run 内再追加一轮只读只多 ≈3 动作 |
| 跨日／休眠重授权（第十二轮 R12C-8 新增档） | 3＋**未派发的全部步骤重批**（改绑使旧 grant 上的同类只读许可作废） | 视剩余步骤数（基准任务剩 3 步则 9） | 3 次决定＋1 次原生确认 | 4（重开系统选择器、原生框确认实际位置、`rebindRunWorkspace`、重读预览） | **+13 左右**；目录许可 8h 上限使跨夜任务每天重演一次 |

**要求**：这三行是**设计期推导值，不是实测值**；试点前必须由 UV02/UV04 实测同一基准任务的真实次数并回填，偏差 >20% 时必须重估 §5 的审批 TTL、J3 的取代上限与 RB-A28 的摩擦结论，不得靠"用户应该会跳过阅读"来解释差距。任何为了缩短本表而放宽逐次批准或闸的想法，都要先对照不变量 5 与 J9/J10 的已签口径。

## 9. 评审与准入证据

### 9.1 必交证据包

证据只在后续获授权的证据系统保存，本文不创建目录、脚本或报告文件。每项包含 B/EV/UV 关联、构建 commit/package hash、环境/OS、前置与注入时间、实际观察、原始证据位置、失败处置和**自决结论与延迟复评记录**（第十四轮 J39：原写"独立复核记录"，本包已无独立复核人；外部审计发生后再另立审计记录）；此处不预填通过、姓名或签字。

| 证据类别 | 必须证明 | 复核职责与阻断规则 |
|---|---|---|
| 合同/权限 | 前端状态/字段映射、Host 可委派权限与无席位治理、正文隔离、输入 profile/版本兼容 | 主签自决＋延迟复评（J39：**2026-11-01 起不存在"前后端/Host/安全联合复核"这些角色**，不得把自决写成联合复核）；新权限不能套用 R0a 签字；六个新入口在真实客户数据前须外部审计 |
| Windows/隔离 | 真实签名包、干净机、F13 句柄约束、F27 OS 隔离、升级回退与日志保存 | 桌面/Broker/安全复核；历史 S2 F13 曾逃逸，参考“8/8”或自签包不能替代 |
| 编排/持久性 | 断网/休眠/重启、journal 丢失、unknown、自动定向取消、同步 WAL/release 和灾备冻结 | 控制面/平台/安全复核；无明确同步故障域证明不发布安全许可 |
| 隐私/模型/成果 | 原文件零上传、摘录 hash 审批、同步分授权、local-only 元数据、模型真实受理/计量及凭据隔离 | 隐私/安全/后端复核；真实供应商数据处理授权不能继承演示数据豁免 |
| 云端/过渡 | 同候选构建 R0a 回归、旧 URL/版本/账本、灰度关闭、历史导出/留存与通知 | 前后端/QA/运维复核；不得破坏已应用迁移或旧成果 |
| 用户/发布 | UV 原始记录与分母（**分母必须标明来源：主签自测／外部使用者，见 §9 招募口径**）、至少 3 名治理者（凑不齐标 `not_run`）、缺陷处置、安装组合 manifest、回滚联系人及步骤（**单人条件下"回滚联系人"＝主签，步骤必须写到可被第二人照做**） | 主签自决＋延迟复评（J39：已无 QA/发布负责人角色）；**"不能把专家走查当用户测试"这句继续有效，且自测同样不是用户测试** |

### 9.2 准入与未决证据

设计评审要求四份文档对 B01–B10 无缺口，兄弟合同字段/权限/状态与本文逐项一致，所有阻断设计问题有处置；完成本文只产生评审输入。
InputV2 的local分支以控制面 §1.2 的判别联合为准：goal/background/交付要求/来源摘要只在本机，API仅收签定ref/hash/计数，禁止local请求夹带正文。远程模型批准只覆盖本次外发，不授权云端持久保存输入；EV21/EV41必须分别验证响应、存储、日志与出口。
进入本机实现前按架构 §1.2 核对继承闸门；进入试点前另须**至少一个真实组织完成云端任务并采纳**（原口径"R0a 三家组织"在单人条件下若确实凑不齐，**如实写"1/3 家"并说明覆盖面缺口，不得把一家报成三家**）、边界理解/时间等退出证据及全部 R0b 安全、安装、故障、用户验证证据；**六个新入口在接入真实客户数据前须完成外部审计（J39 触发条件）**。状态及批准只记 [work-project](work-project.md)，本轮不回写。
尚需实施/评审产出的证据：通过测试的最低桌面组合 manifest；各批准模型实际 token/context/bytes 与估算版本；Host 新权限码/委派和写入口复核；真实 Broker F13/F27；同步持久边界及 journal 恢复；真实模型与用户测试；旧系统留存/URL 清单及通知安排；**试点前采集的真实批准/取代次数分布（第十轮 R10A-12：B02 的"审批 10min × 最多取代 5 次 × 只能本机窗口"三项叠加是否可接受只能由此复核，控制面 §5 已声明不得假装已解决）**。
上述不重新开放已定选择：细分可委派、无内置角色预置、owner 显式委派、必选闭环优先、云端 2000/4000 与本机总 8000 标量均为本轮设计约束。缺失证据只意味着对应门不得放行，不能用降低安全、扩大范围或捏造签收补齐。
