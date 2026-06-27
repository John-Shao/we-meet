# P6 — UX 框架对齐飞书(左栏工作台外壳)

> 这是一次**跨模块的外壳 / IA 重构**,不是 P1–P5 那种"只扩展不修改"的加法。性质:动现有布局 + 全局视觉,blast radius 大,所以 **design-first**(本文)→ 拍板 → 增量实现。
> 这也正是当初把 IM 群聊那批 UX 小瑕疵"攒着待飞书大调整"的那个调整。

## 一、Context / 目标

we-meet 现在是 **LaSuite Meet fork**,外壳是 Meet 自带的**顶部 Header**;P1–P5 一路把入口(通讯录/日历/审批/文档/IM)一个个加进 Header,已经挤、ad-hoc。目标:换成**飞书式持久左栏工作台**——左侧竖排一级模块导航,右侧模块内容,各模块(消息/会议/日历/通讯录/审批/文档/知识库)统一在一个壳里;**结构 + 视觉都对齐飞书**(用户已拍板)。

**范围边界**:
- 改的是**会外的工作台外壳 + 导航 IA + 全局视觉 token**。
- **不动会中 LiveKit 房间 UI 的结构**(全屏沉浸式保留;仅随 token 改色)。
- 一套 `src/frontend` React 前端(Electron 桌面只是包它,自动跟着;Docs 作外链;Android 另算)。

## 二、现状(grounded)

| 件 | 现状 |
|---|---|
| 外壳 | `layout/Layout.tsx`:`<Header/>` + `<main>{children}</main>` + `<Footer/>`,由 valtio `stores/layout`(`showHeader`/`showFooter`)开关 |
| 页面切换 | `layout/Screen.tsx`:每页用 effect 设 `layoutStore.showHeader/footer`;**会中房间 `showHeader=false` 全屏** |
| 导航 | `layout/Header.tsx`:顶部 logo + 一排 `<Link>`(contacts/calendar/approval + docs 外链 + im)+ 用户菜单 |
| 主题 | `panda.config.ts`:LaSuite **法政紫** primary(`#6A6AF4` / `#000091`),greyscale/error 自定义,semantic tokens 引 blue/gray/red/green/amber |
| 路由 | wouter;`routes.ts` 路由表(home/room/im/contacts/calendar/approval) |

**好消息**:`layoutStore` 的"会中全屏 vs 会外带壳"机制现成,左栏直接复用——会中继续全屏,会外渲染左栏工作台。

## 三、关键决策

- **D1 外壳 = 飞书式三栏(会外)+ 全屏(会中)。** 据用户飞书截图,飞书是经典**三栏**:① 全局**主导航栏**(窄,图标+文字,顶部工作区头像 + ⊕ + 搜索 Ctrl+K)② 模块**二级面板**(会话列表 / 迷你月历+日历列表 / 联系人分类 / 会议动作磁贴+历史)③ **主内容区**。**P6 建 ①(全局主导航栏)+ 三栏框架**;②③ 交给各模块:IM、通讯录已是"列表+详情"天然贴框架,日历/会议首页的丰富二级面板(周/月网格、动作磁贴)属**模块级增强、可增量补**。在 `layoutStore` 增壳模式(`shell: 'workspace' | 'fullscreen'`),`Layout` 据此渲染:workspace = 主导航栏 + 模块内容;fullscreen = 裸内容(房间)。沿用现有 `Screen` toggle 习惯,房间设 fullscreen。**顶部 Header 导航职责移交主导航栏**。
- **D2 左栏 IA(见 §四)。** 竖排图标+文字一级模块;顶部 logo/工作区,底部 用户头像/设置。各项映射现有路由,Docs 作外链(gated on `config.docs.url`),知识库为 P4 占位(Docs 上线后填)。
- **D3 视觉对齐 = 中心化重映射 panda token + 据截图的具体规格。** 从飞书截图提炼:主操作按钮**飞书蓝**(锚点 `#3370FF`,如「创建日程」「添加企业成员」);**应用底色极浅蓝灰**(面板浮其上),**白色圆角面板 + 极淡边框**;主导航栏选中项 = 浅高亮底 + 蓝色图标/文字;字体中性、留白足。落地:`panda.config.ts` primary 法政紫→飞书蓝系 + 加 app 背景/面板的 semantic token,radii 用现有 6/8。改一处、全局生效。**注意 blast radius:连会中 UI 也跟着变蓝**——期望的统一,但需回看会中观感。
- **D4 与 Meet fork 共存。** 会中房间 UI 结构不动(沿用 fork 的全屏会议体验),只继承新 token 颜色。左栏只包会外路由。降低与上游 merge 冲突面(已是重度 fork,可接受)。
- **D5 响应式 / 桌面。** ≥md 显示左栏;窄屏折叠成底部 tab 或抽屉。Electron 包同一份 React → 自动得到左栏。
- **D6 无 Figma → 对齐飞书公开设计语言**(蓝 primary、中性灰、左栏、卡片/间距规范)做**忠实近似**;若你能给关键页 Figma/截图,我再逐步精修到像素。**视觉这块先求"神似 + 一致",再迭代细节。**
- **D7 顺带收 IM 群聊 UX 欠债。** 借这次大调整,把 `project-im-group-ux-feishu-pending` 里攒的(建群默认选中自己、转让群主等)一并修。

## 四、左栏 IA(目标)

竖排一级模块(参考飞书,按 we-meet 现有能力裁剪):

| 顺序 | 模块 | 路由 / 行为 | 来源 |
|---|---|---|---|
| 1 | 消息 | `/im` | IM(jusi-light-im) |
| 2 | 视频会议 | `/`(发起/加入会议首页) | Meet 核心 |
| 3 | 日历 | `/calendar` | P2 |
| 4 | 云文档 | 外链 `config.docs.url`(新标签) | P3,gated |
| 5 | 知识库 | (P4 占位,Docs 上线后) | P4 |
| 6 | 审批 | `/approval` | P5 |
| 7 | 通讯录 | `/contacts` | P1 |
| 底部 | 用户/设置 | 头像菜单 + 设置 | 现有 SettingsButton/用户菜单 |

> 未配 `docs.url` 时"云文档/知识库"隐藏(同 P3-b 的 gating,不出死链)。顺序可调,先按"沟通→会议→日程→文档→知识→流程→人"。

## 五、实现分期(拍板后)

- **P6-a 外壳骨架**:`AppShell`/左栏组件 + `layoutStore.shell` 模式;`Layout` 按模式渲染;路由接入左栏;房间保持 fullscreen。先用**现有视觉**搭骨架跑通(结构先立)。
- **P6-b 视觉 token 重映射**:`panda.config.ts` primary→飞书蓝 + neutrals/radii 微调,中心化;回看会中 UI 观感。
- **P6-c 模块页适配**:各模块页统一页头/间距/卡片到新壳(消息/日历/审批/通讯录已是我写的,适配快;会议首页 + 会中条适配)。
- **P6-d 收尾**:IM 群聊 UX 欠债(D7)+ 响应式(窄屏左栏折叠)+ 细节精修。

每期 `tsc -b`/eslint 把关;骨架阶段重点人工过一遍交互(无前端单测)。

## 六、风险
1. **blast radius 大**:动 `Layout` + 每页对 Header 的假设 + 全局 token。→ 分期、先骨架后视觉,每期可单独回滚。
2. **token 改色波及会中 UI**:primary 变蓝后会议界面也变;需专门回看会中观感(D3)。
3. **fork 偏离上游**:进一步偏离 LaSuite Meet;已重度 fork,可接受。
4. **无 Figma 的视觉保真度**:先忠实近似飞书设计语言,像素级需你给参考图再精修(D6)。
5. **会中/会外切换的边界 case**:从会议页返回工作台、深链进房间等路径要测壳模式切换不闪。

## 七、立即下一步(本文档拍板后)
1. **P6-a 骨架**:左栏 `AppShell` + `layoutStore.shell` + `Layout` 分模式 + 路由接入(沿用现有视觉),房间全屏不变。
2. 跑通后给你看结构;再 **P6-b** 切飞书蓝 token。
3. 逐期推进 P6-c / P6-d。
