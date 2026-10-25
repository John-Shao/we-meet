# 豆包工作 / 千问办公「扩展」能力统一调研与 we-meet 路线图

- 日期：2026-10-25
- 独立报告（保留逐项证据与细节）：
  - [豆包工作「扩展」能力调研与 we-meet 任务能力方案](work-extension-doubao-research-2026-10-25.md)
  - [千问办公「扩展」能力调研与 we-meet 专家套件方案](work-extension-qwen-research-2026-10-25.md)
- 截图资产：[豆包 14 张](assets/doubao-work)、[千问 14 张](assets/qwen-work)
- 代码基线：`7fb9818d4`（`refactor/work-module`）
- 证据：两家产品截图、官方帮助中心、当前仓库代码与测试
- 统一口径：`WorkPreset`（`kind='suite' | 'partner'`）与 E1 / E2a / E2b / E3a / E3b / E4 路线图
- 定位：这是决策版；两份独立报告保留完整的截图索引、逐项拆解、未核验项和证据分级

---

## 目录

- [0. 结论摘要](#0-结论摘要)
- [1. 范围、术语、证据与方法](#1-范围术语证据与方法)
- [2. 两家扩展模型对照](#2-两家扩展模型对照)
- [3. 新建任务时的组合方式](#3-新建任务时的组合方式)
- [4. 权限、治理与安全](#4-权限治理与安全)
- [5. we-meet 现状与硬约束](#5-we-meet-现状与硬约束)
- [6. 统一产品模型：WorkPreset](#6-统一产品模型workpreset)
- [7. 统一路线图与工作量](#7-统一路线图与工作量)
- [8. UX、契约与数据模型](#8-ux契约与数据模型)
- [9. 测试、验收与指标](#9-测试验收与指标)
- [10. 产品假设与验证](#10-产品假设与验证)
- [11. 风险与开放问题](#11-风险与开放问题)
- [12. 证据与索引](#12-证据与索引)
- [13. 一句话结论](#13-一句话结论)

---

## 0. 结论摘要

1. **两家都把扩展收敛为三层任务能力。** 最高层是角色或方案包：豆包的「工作伙伴」、千问的「专家套件」；中间层是「技能」：方法、流程、输出要求；底层是「连接器（豆包称插件）」：外部数据、账号和工具。三层最终都进入新建任务。
2. **两家最值得借鉴的共识是「安装、启用、授权、调用」分离。** 安装不等于启用，启用不等于授权，授权不等于每次任务自动使用；连接器和技能不能共用一个 `enabled` 布尔值。
3. **千问的专家套件更接近「完整工作方案包」。** 它由技能、数据连接、工作流、输出标准组成，有版本、快捷命令、链式上下文和连接器增强；适合团队统一产出。豆包的工作伙伴更偏「角色 + 指令 + 默认能力」，适合复用角色配置。
4. **千问的链式/增强模式是真正的差异化。** 技能可独立运行，也可读取 `brief.json`、`flow-*.json` 等项目上下文，或在 Figma/designLang/WebSearch 等连接器下增强；三种模式产出同一份 schema。这不是「多选几个技能」能复刻的。
5. **两家的任务输入框都是组合面板。** 豆包把环境、项目、按需确认、技能、插件放在同一行，伙伴通过「召唤」或 `@` 进入；千问把「套件 · 技能」直接内联在输入框，配快捷命令、工作台模式、默认权限和模型档位。
6. **we-meet 不能先做扩展 UI。** 当前执行层关闭了 Skills/MCP/外部写入，只开放 `read,bash,write,edit`；`work-agent/v1` 与 `work-local/v1` 是严格字段白名单；先放入口会变成假能力。
7. **成果管线是第二道硬约束。** 当前只支持 `.txt/.md/.csv/.json`；Markdown 编辑/采纳版本上限 40,000 字符；执行器单次最多 20 个文件/400,000 字节。千问式 HTML/Office/PPT/画布成果不在当前范围。
8. **统一产品模型采用 `WorkPreset`，不再建两套对象。** `kind='suite'` 是套件模板，`kind='partner'` 是可选的轻量工作伙伴；首版做 E2a 套件，E2b 后置。`preset_id`/`quick_command_id` 取代 `partner_id`。
9. **统一路线图为 E1 → E2a → E2b → E3a → E3b → E4。** E1 8–12 人日；E2a 8–12、E2b +2–4（E2 合计 10–16）；E3a 20–35、E3b 15–25、管理/安全 5–10（E3 合计 40–70）；E4 60–95+；设计/幻灯片工作台 30–50+。
10. **E1/E2a/E2b 只做提示词组合，不承诺链式。** 真正的链式上下文、schema 传递、确定性编排和富成果属于 E4；E2 对外应叫「套件模板/技能包」，不要叫完整专家套件。
11. **安全边界必须比竞品更保守。** 首版不做原始 `SKILL.md` 全量展示、用户文件系统安装、任意 MCP/STDIO、浏览器接管、计算机控制；连接器只读 SaaS、逐任务 scope、默认关闭、令牌不进模型上下文。
12. **两份独立报告是证据附录。** 本文给结论、统一模型、路线图和契约；具体截图索引、逐项差异、官方链接与未核验项以两份独立报告为准。

---

## 1. 范围、术语、证据与方法

### 1.1 范围

本文回答：

- 豆包工作和千问办公如何定义伙伴/套件、技能、连接器；
- 新建任务时如何直接使用或组合使用三层能力；
- 两家在链式上下文、连接器授权、成果形态和治理上的差异；
- we-meet 当前能支持到哪一步，哪些必须先改执行器/成果管线/项目模型；
- 统一的 `WorkPreset` 模型、组合规则、路线图、契约、测试和验收；
- 哪些结论是证据，哪些是待验证假设。

不在本文范围：

- 两家产品的完整工作台、定时任务、云盘、IM、企业后台实现；
- 具体连接器供应商的商务与合规；
- 真实生产压测、计费定价、法务数据出境结论；
- 完整 UI 视觉设计与像素级交互。

### 1.2 术语

| 术语 | 两家对应 | 本文定义 | 不是什么 |
|---|---|---|---|
| 扩展 / 任务能力 | 豆包「任务能力」；千问「扩展」 | 伙伴/套件、技能、连接器的统称 | 不是模型，也不是工作台模式 |
| 套件 | 千问专家套件；豆包岗位预设 | `WorkPreset(kind='suite')`：有序技能 + 快捷命令 + 输出标准 | 不是单技能；不是人设记忆 |
| 工作伙伴 | 豆包工作伙伴 | `WorkPreset(kind='partner')`：套件 + 短 `instructions` + 默认环境/审批偏好 | 不是首版主模型；不单独建表 |
| 技能 | 千问 Skill；豆包技能 | 封装方法、步骤、输出要求的方法包 | 不持有外部账号；不等于连接器 |
| 连接器 | 千问连接器；豆包插件 | 在授权范围内访问外部数据/工具的集成 | 不是方法包；不等于权限 |
| 快捷命令 | 千问套件 `/命令` | 套件预置的任务入口，点击后预填提示词模板 | 不是独立技能 |
| 独立模式 | 千问技能模式 | 无前序上下文，直接调用技能 | 不等于无状态任务 |
| 链式模式 | 千问技能模式 | 读取前序上下文文件，按 schema 传递 | 不是简单多选技能 |
| 增强模式 | 千问技能模式 | 连接器/组件库/项目状态增强输出 | 不是连接器自动授权 |
| 上下文文件 | 千问 `spark-output/context/*.json` | 技能之间传递的结构化中间产物 | 不是普通用户附件 |
| 安装/启用 | 两家安装/开关 | 加入可用集合 / 打开能力 | 不等于授权，也不等于调用 |
| 授权 | 两家连接器授权 | 连接器获得账号、范围和凭据 | 不等于所有任务自动可用 |
| 调用 | 两家任务内使用 | 某次任务实际使用能力 | 不能由客户端伪造或越权 |
| 能力快照 | — | 任务创建时冻结的 preset/技能/连接器/上下文版本 | 不是实时查询 |
| 环境 | 本地/云端 | 执行位置 | 不是能力；决定能力可用性 |
| 工作台模式 | 千问通用/设计/幻灯片/写作 | 产出形态与画布 | 不是扩展，也不是模型档位 |
| 默认权限 | 千问 | 风险动作的审批策略 | 不能代替连接器 scope |

### 1.3 证据分级

| 等级 | 来源 | 用途 |
|---|---|---|
| A | 官方帮助中心/法律文本原文 | 定义、安装、授权、限制；作为事实依据 |
| A- | 官方页面摘要/动态渲染摘录 | 作为事实依据，但与原文冲突时以原文为准 |
| B | 产品截图 | 观察界面、控件、版本、开关；不推断内部实现 |
| C | 第三方报道/教程 | 背景数字与旁证；不单独支撑机制结论 |
| D | 当前仓库代码、文档、测试 | we-meet 可行性与硬约束 |

证据边界：

- 截图能证明界面存在，不能证明多选上限、取消方式、自动匹配是否可撤销、企业权限细节；
- 官方文档可能落后于客户端；
- 本文对未核验项标注「未核验」，不把推断写成事实；
- 正文「官方文档」对应 §12.2 的链接；「截图 N」对应独立报告的截图索引。

### 1.4 关键截图

完整 14+14 截图索引见两份独立报告；这里只列对统一结论最关键的画面。

| # | 产品 | 界面 | 关键观察 | 资产 |
|---|---|---|---|---|
| 1 | 千问 | 专家套件详情 | 「产品设计」`v0.5.10`；28 个 Skill 链式工作流；每个 Skill 读取前序产出；28 个快捷命令 | [01](assets/qwen-work/01-expert-kit-product-design.png) |
| 2 | 千问 | 新建任务 | 「产品设计 · 动效规划」内联 + 提示词模板；`+`、技能/工具、通用、默认权限、标准 | [04](assets/qwen-work/04-new-task-composer.png) |
| 3 | 千问 | 技能详情 | 独立 / 链式 / 增强三种模式；读取 `brief.json`、`flow-*.json`、`avatar.json`；统一输出 schema | [05](assets/qwen-work/05-skill-motion-plan-modes.png) |
| 4 | 千问 | 套件说明 | ALWAYS 独立工作；SUPERCHARGED 连接 Figma/designLang/WebSearch；基础能力不依赖连接器 | [06](assets/qwen-work/06-expert-kit-how-it-works.png) |
| 5 | 千问 | 连接器 | 系统级浏览器/计算机控制/M365；SaaS；自定义 MCP；默认关闭 | [10](assets/qwen-work/10-connector-market.png) |
| 6 | 豆包 | 新建任务 | 环境、项目、按需确认、技能、插件；右侧模型/推理强度；已选能力与目标同排 | [05](assets/doubao-work/05-new-task-composer.png) |
| 7 | 豆包 | 工作伙伴市场 | 角色卡、召唤；伙伴可携带默认能力 | [06](assets/doubao-work/06-workmate-market.png) |
| 8 | 豆包 | 伙伴详情 | 指令、能力、管理；内置技能 13；任务/自动化/资源主页 | [07](assets/doubao-work/07-workmate-detail-senior-engineer.png) |
| 9 | 豆包 | 伙伴能力 | 技能与连接器分栏；来源标签；逐项开关 | [12](assets/doubao-work/12-workmate-capabilities-skills.png) |
| 10 | 豆包 | 伙伴管理 | 授权模式：默认允许/部分限制；粗粒度权限 | [14](assets/doubao-work/14-workmate-authorization-mode.png) |
| 11 | 豆包 | 技能详情 | 启用开关、目标、使用边界；完整内容暂不展示；在对话中试用 | [04](assets/doubao-work/04-skill-detail-product-manager.png) |
| 12 | 豆包 | 连接器 | GitHub OAuth 弹窗；账号与数据共享范围 | [02](assets/doubao-work/02-github-connector-auth.png) |

### 1.5 方法与限制

- 未登录两家产品做真实任务，未验证多选上限、取消、执行中追加、连接器撤销、企业后台；
- 未获得两家客户端源码或内部协议；
- 千问版本/技能数量来自截图，可能随版本变化；
- we-meet 侧只读代码与文档，未改代码、未跑真实任务、未应用迁移；
- 本文是决策版，详细证据见两份独立报告。

---

## 2. 两家扩展模型对照

### 2.1 共同的三层结构

```text
任务目标
├── 伙伴 / 套件：谁来做、整套工作怎么做
│   ├── 角色/指令（豆包伙伴）
│   ├── 技能组合与工作流（千问套件）
│   └── 默认连接器/数据连接
├── 技能：怎么做
│   └── 方法、步骤、输出 schema、边界
└── 连接器（豆包称插件）：用什么数据和工具
    └── 外部系统、账号、scope、读取/写入
```

| 层 | 回答的问题 | 豆包 | 千问 | 在任务中的形态 |
|---|---|---|---|---|
| 最高层 | 谁来做/整套怎么做 | 工作伙伴：角色 + 指令 + 默认能力 | 专家套件：技能 + 连接 + 工作流 + 输出标准 | 伙伴 chip / 套件 · 技能内联 |
| 中间层 | 怎么做 | 技能：方法包 | 技能：`SKILL.md` 方法包 | `/`、`@`、自动匹配、快捷命令 |
| 底层 | 用什么数据/工具 | 插件：SaaS + OAuth/CLI/MCP | 连接器：系统级 + SaaS + 自定义 MCP | 连接器 chip、授权、调用 |

### 2.2 千问：完整工作方案包 + 链式技能

官方定义：专家套件把多个 Skill、数据连接、工作流和输出标准整合为一个完整方案包；技能是包含 `SKILL.md` 的方法包；连接器连接外部系统与账号。

关键事实：

- 截图中的「产品设计」套件为 `v0.5.10`（截图版本），包含 28 个技能/快捷命令；每个技能读取前序产出，避免重复填写项目信息；
- 技能的三种模式：独立、链式、增强；链式检测 `spark-output/context/brief.json`、`flow-web.json`、`flow-mobile.json`、`avatar.json`；增强读取 `SparkDesign`/`motion-apply.md`；三种模式输出同一份 `motion-plan.json` schema；
- 套件说明给出 ALWAYS（独立工作）与 SUPERCHARGED（连接工具后增强）：Figma → design tokens，designLang → 线上站点 tokens，WebSearch → 竞品信息；
- 技能安装在 `~/.qwenworkcn/skills/`，支持对话/GitHub/手动上传；`@` 用于补充文件/文件夹上下文，不用于调用技能；
- 连接器默认关闭；开启/关闭后需要新建任务才生效；浏览器仅 Chromium；自定义 MCP 支持 HTTP/SSE/STDIO；
- 工作台模式：通用/设计/幻灯片/写作；设计产出 HTML/CSS/JS/React 工程文件，幻灯片可导出 PPTX/PDF/HTML；
- 官方文档还说明：套件更新会覆盖个人修改；企业空间资源不自动公开；分享套件为 ZIP。

**判断**：千问把「扩展」做成了「工作方案 + 上下文 + 成果」的完整链路。它的优势是团队标准化、链式复用、可交付；代价是上下文存储、schema、富成果和系统级连接器的复杂度。

### 2.3 豆包：角色伙伴 + 默认能力

官方定义：工作伙伴是面向专业场景的企业智能体；支持内置/自定义伙伴；任务中通过 `@` 伙伴/小队分派任务。

关键事实：

- 伙伴有指令（`IDENTITY.md`、`USER.md`、`SOUL.md`、行为准则）、能力（技能/连接器开关）、管理（默认允许/部分限制）、主页（任务/自动化/资源）；
- 伙伴可以携带默认技能和连接器；任务可以在伙伴默认值上追加技能、插件、项目和文件；
- 技能有市场、安装、启用、详情、目标、使用边界；完整内容暂不展示；支持 `/`、`@`、自动匹配；
- 连接器（插件）以 SaaS 为主，OAuth/CLI/HTTP/STDIO/MCP；安装后需授权；权限由连接账号及设置决定；
- 伙伴级授权模式：默认允许/部分限制，粒度较粗；
- 官方文档补充：团队伙伴可共享群上下文；自定义模型限企业订阅；导入伙伴仅当前用户；小队至少 2 人，在 `aily.feishu.cn` 创建。

**判断**：豆包的伙伴更偏「角色代理 + 配置复用」。它的优势是上手自然、角色感强、默认能力一键带出；风险是提示词不透明、记忆/人设边界不清、默认允许容易扩大权限。

### 2.4 横向对照

| 维度 | 千问办公 | 豆包工作 | 对 we-meet 的含义 |
|---|---|---|---|
| 最高层 | 专家套件：完整工作方案包 | 工作伙伴：角色 + 指令 + 默认能力 | 采用 `WorkPreset`，首版 suite，伙伴后置 |
| 技能形态 | `SKILL.md` 透明；文件系统安装；可带辅助文件 | 技能市场；完整内容不展示；自动匹配/`/`/`@` | 终端用户看结构化摘要；管理员看原文 |
| 技能执行 | 独立/链式/增强；上下文文件 + schema | 自动匹配 + 任务内选择；未见公开的文件级链式契约 | E2a/E2b 只做提示词顺序；链式放 E4 |
| 连接器 | 系统级 + SaaS + 自定义 MCP；默认关闭 | SaaS 为主 + OAuth/CLI/MCP；伙伴级默认允许/部分限制 | E3a 只读 SaaS；E3b 本机/MCP/写入另立 |
| 新建任务 | 套件 · 技能内联 + `/` 命令 + 工作台/权限/模型 | 伙伴/技能 chip + 技能/插件工具栏 | composer 用 chip + 本次任务计划 |
| 上下文 | 项目级 `spark-output/context/*.json` | 伙伴记忆/用户档案；链式文件未核验 | 链式需要项目上下文，属 E4 |
| 成果 | HTML/代码/PPTX/PDF/Office/图片/网页 | 本轮截图未覆盖同等富成果/链式，不作比较 | 当前 we-meet 只支持文本 |
| 治理 | 企业空间、套件 ZIP、更新覆盖、默认关闭 | 团队伙伴、导入仅本人、伙伴级授权 | 版本/快照/组织策略 |
| 透明度 | 原始 `SKILL.md` 可见 | 完整技能内容不展示 | 摘要 + 管理员原文 |
| 主要风险 | 任意 MCP/STDIO、浏览器/桌面控制、文件系统安装 | 默认允许、数据共享范围、隐藏提示词 | we-meet 取更保守边界 |

### 2.5 对 we-meet 的五条结论

1. **先做套件，不做人设。** 办公任务更需要「可复用的方法 + 输出标准」，而不是持久记忆的角色。伙伴作为 E2b 的可选形态。
2. **技能与连接器分层。** 技能是方法，连接器是数据/工具；技能不能持有凭据，连接器不能决定方法。
3. **链式不是多选。** 没有项目上下文、schema、来源追踪，就不能承诺链式；E2a/E2b 只做预设。
4. **连接器默认关闭、只读优先。** 不复制伙伴级「默认允许」；逐 scope、逐任务、写操作逐次确认。
5. **成果管线决定上限。** 没有富成果管线，就不要做设计/幻灯片类套件；先做文本型套件。

---

## 3. 新建任务时的组合方式

### 3.1 两家输入框

豆包（截图 6）：

```text
[已选：◇ 产品经理] 帮我设计一个技术博客网站
[+] [本地电脑] [项目] [按需确认] [技能] [插件]        [自动 低] [发送]
```

千问（截图 2）：

```text
[⌐ 产品设计 · 动效规划] 输入页面/组件 + 期望调性…
[+] [技能/工具] [通用] [默认权限]                 [标准] [语音] [发送]
[新建项目]
```

共同点：

- 能力在提交前可见，与目标同屏；
- 环境、项目、权限、模型是正交配置，不属于扩展层；
- 能力可以手动选择，也可能被自动匹配；
- 安装/授权状态影响任务内可选集合。

差异：

- 豆包用伙伴 chip/`@`，千问用「套件 · 技能」内联 + `/` 命令；
- 豆包把环境、项目、权限放在工具栏；千问把工作台模式/权限/模型放在工具栏，项目在下方；
- 千问的快捷命令直接预填提示词模板；豆包更像任务内选择能力。

### 3.2 直接使用与组合使用

- **直接使用**：只选一个技能、一个套件或一个连接器；
- **组合使用**：套件提供工作流和默认技能，任务选择具体技能/快捷命令，连接器增强数据/工具，项目提供上下文；
- 组合不是必须三层同时出现；环境、项目、权限、模型是正交配置。

| 场景 | 选择 | 执行 | 用户确认 | we-meet 阶段 |
|---|---|---|---|---|
| 单技能 | 技能 A | 独立模式；A 的步骤与输出 | 看到技能名、输出要求 | E1 |
| 套件 + 技能 | 套件 P + `/命令` | P 的工作流 + 当前技能；不读项目上下文 | 看到套件、技能、输入模板 | E2a |
| 套件 + 技能 + 连接器 | P + A + 连接器 C | 连接器增强；链式需 E4 | 看到连接器、scope、数据去向 | E3a |
| 伙伴 + 默认能力 | 伙伴 P | P 的 instructions + 默认技能 | 看到 P、默认技能、可移除项 | E2b |
| 多个技能 | 技能 A + B | 按套件顺序；schema 串联 | 看到顺序/依赖 | E4 |
| 多个套件 | 套件 P1 + P2 | 组合方案 | 看到套件组合与冲突 | E4 |
| 仅连接器 | 浏览器/计算机控制 | 多步骤外部操作 | 看到 Tab/桌面控制范围 | E3b（不建议首版） |
| 项目 + 套件 | 项目 + P | 项目上下文供技能读取 | 看到项目、上下文文件 | E4 |

### 3.3 组合规则

```text
组织策略（允许/禁用、scope、上限）
  → preset 默认值（套件技能/快捷命令，或伙伴 instructions）
  → 任务显式选择（技能、连接器、上下文、环境）
  → 服务端校验（存在、启用、授权、环境、预算、长度）
  → 冻结 capability_snapshot
  → 生成执行计划
```

规则：

1. 组织策略优先于 preset 和任务；
2. preset 默认技能是预填，未锁定项可移除；
3. 任务追加技能按 ID 去重，顺序为套件定义 + 用户追加；
4. 连接器必须显式授权；preset 的连接器建议不等于已授权；
5. 环境决定可用集合；不自动换环境/降级；
6. 服务端解析并冻结；客户端不发送原始提示词/凭据；
7. 提交前展示「本次任务计划」；
8. 约束建议：1 个 preset、3 个技能、2 个连接器；技能/快捷命令总字符 ≤ 2000；组合后的最终执行目标 payload ≤ 8000 字符（含背景前缀/分隔符）；
9. 冲突（输出格式、重复技能、缺失连接器、组织禁用、环境不匹配、预算）在提交前提示；
10. 版本冻结：preset/技能/连接器更新不回溯已创建任务。

### 3.4 链式与增强

千问的三种模式：

| 模式 | 输入 | 处理 | 输出 |
|---|---|---|---|
| 独立 | 用户目标/调性 | 引导补全 | 统一 schema |
| 链式 | 前序 `brief.json`/`flow-*.json`/`avatar.json` | 跳过基础提问，提取项目调性/目标元素 | 统一 schema |
| 增强 | 前序 + 组件库/连接器状态 | 对齐风格、读取增强数据 | 统一 schema，供下游消费 |

对 we-meet 的分解：

- **E2a/E2b**：只做提示词层面的顺序，不读项目文件，不保证 schema 传递；
- **E4-A**：项目上下文目录/文件存储、冻结项目 ID + 上下文版本、schema、来源/哈希；
- **E4-B**：服务端确定性编排器，按套件顺序创建子 run/模型调用，每步 schema 校验，不依赖模型自行决定顺序；
- **E4-C**：富成果管线（HTML/Office/PDF/图片），先支持存储/预览/下载，再考虑在线编辑；
- **E4-D**：连接器增强，基础能力不依赖连接器。

单 run 工具循环只用于探索型/独立技能，不作为套件链式路径。

### 3.5 交互语法

建议统一：

- `/`：打开套件快捷命令/技能列表；
- `@`：补充文件/文件夹/项目上下文，不用于调用技能或伙伴；
- 套件/伙伴：独立 chip 选择，不使用 `@`；
- 连接器：独立 chip + 授权状态，不通过自然语言静默启用；
- 自动匹配：只做建议，用户点击才加入；连接器禁止自动启用。

理由：千问的 `/` 与 `@` 分工更清晰；豆包把 `@` 同时用于伙伴/技能/插件容易混淆。we-meet 取千问的语法，但保留豆包的伙伴 chip。

### 3.6 未核验

- 两家技能/连接器多选上限与取消方式；
- 自动匹配是否可拒绝；
- 执行中能否追加能力或修改权限；
- 千问「默认权限」的具体选项；
- 豆包团队伙伴/小队的企业权限；
- 两家连接器撤销后运行中任务的行为；
- 千问套件更新覆盖个人修改的具体提示/回滚。

---

## 4. 权限、治理与安全

### 4.1 四个状态

| 状态 | 含义 | 谁控制 | 界面 |
|---|---|---|---|
| 可见 | 在市场/列表可见 | 平台/企业 | 卡片/详情 |
| 已安装/启用 | 加入可用集合/打开 | 用户/管理员 | 安装、开关 |
| 已授权 | 连接器获得账号、scope、令牌 | 用户/管理员 | 已连接、配置 |
| 可调用 | 本次任务实际选择并通过校验 | 任务 + 服务端 | 任务计划/事件 |

### 4.2 技能供应链

- 首版只做内置/组织策展；管理员审核内容、版本、输出要求；
- 技能内容视为不可信指令：不能覆盖系统安全策略、不能获得凭据、不能绕过审批；
- 版本化 + 内容哈希；任务快照固定版本；更新不回溯；
- 终端用户看结构化摘要（做什么、输入、输出、边界、版本、来源）；管理员可看原文；
- 不支持用户文件系统直接安装；本地缓存只读、校验签名；
- 个人自建技能后置，需要审核、签名、可见范围和使用审计。

竞品风险：

- 千问原始 `SKILL.md` 全量可见，可能泄露方法论/示例；文件系统安装的签名校验未在公开文档说明；
- 豆包完整技能内容不展示，透明度不足；
- 两家都可能出现技能更新覆盖个人修改。

### 4.3 连接器授权

- 默认关闭；逐任务显式选择；逐 scope 授权；
- 只读优先；写操作逐次确认；不支持「全部允许」；
- 新授权/新启用只影响新任务；撤销是安全覆盖，运行中任务在下一次调用前停止使用；
- 令牌只存加密引用；broker 注入；模型上下文不见令牌；
- 连接器结果可能进入模型上下文，必须向用户说明数据去向；
- 企业管理员可禁用/限制/审计；成员不能绕过。

首版边界：

- E3a：只读 SaaS，OAuth/HTTP；不含 MCP、本机、写入、公开市场；
- E3b：本机连接器、MCP/STDIO、写入；单独立项，桌面/适配器 v2；
- 不做浏览器接管、计算机控制、任意 STDIO、公开市场。

### 4.4 企业空间与版本

- 组织 preset 由管理员发布，成员只读；个人 preset 字段保留但暂不开放创建；
- 分享 preset 不携带连接器授权/凭据；
- 组织禁用/撤权是终态；任务快照保留审计，但不能继续调用；
- 套件更新不回溯已创建任务；个人修改另存，不覆盖组织版本。

### 4.5 失败模式

| 失败 | 行为 | 禁止 |
|---|---|---|
| 未授权 | 阻止提交/调用，提示连接 | 自动用匿名/共享账号 |
| scope 不足 | 提示缺少的 scope | 自动申请更大 scope |
| 令牌过期 | 提示重新授权 | 用旧令牌继续调用 |
| 连接器不可用 | 提交前阻止；运行中失败保留任务 | 自动换连接器/降级 |
| 限流 | 有上限重试，保留用量 | 无限重试 |
| 部分写入 | 记录副作用，人工处理 | 自动回滚/重复写 |
| 执行未知 | 保留原任务，查询同一记录 | 自动重放付费调用 |
| 撤权 | 停止新调用，保留审计 | 删除历史/继续调用 |
| 技能冲突 | 提交前阻止 | 运行时静默择一 |
| 上下文超限 | 提交前提示减少能力 | 截断用户目标 |
| schema 不匹配 | 阻止/降级并提示 | 假装链式成功 |

### 4.6 路径与审计

- 云端只使用 `project_id` + 文件别名/哈希；本机绝对路径不出设备；
- 本机 context 只在授权目录内读写；跨设备只传内容/别名，不传路径；
- 审计记录：安装/启用/授权/撤销、任务使用能力快照、连接器调用、schema 校验、token/费用；
- 不记录：令牌、OAuth code、模型密钥、本机绝对路径、任务/成果正文、连接器返回原始数据。

---

## 5. we-meet 现状与硬约束

### 5.1 执行层

| 面 | 现状 | 证据 |
|---|---|---|
| capabilities | `skills: ["office_agent"]`；无 preset/技能/连接器注册表 | `src/backend/work/api.py:59-80` |
| 云端任务输入 | `goal ≤ 2000`、`background ≤ 4000` | `src/backend/work/task_api.py:20-22` |
| 云端 agent payload | `goal/files/timeout_seconds/limits`；无能力选择 | `src/backend/work/agent_runs.py:59-69` |
| 本机准入 | `goal/model/workspace_label`；无背景/技能 | `src/backend/work/local_api.py:27-33` |
| 桌面提交 | 只接受 `goal/run_id/workspace_id/track_cloud` | `src/desktop/src/main.ts:794-804` |
| 本机适配器提交 | 只接受 `run_id/workspace_id/goal` + 可选 `files/limits` | `src/work-agent/work_agent/local.py:146-153` |
| 执行器能力 | 关闭 extensions/MCP/skills；工具只有 `read,bash,write,edit` | `src/work-agent/work_agent/drivers.py:120-145` |
| 执行器声明 | `no_business_tools`、`no_user_files`；无技能/连接器 feature | `src/work-agent/work_agent/config.py:111-169` |
| 官方范围 | Skills/MCP、业务外部写入、GUI、二进制成果、会话恢复、多副本调度不在范围 | `src/work-agent/README.md:155` |
| 契约严格性 | 请求只允许固定键 + `limits/operation`；未知键拒绝 | `src/work-agent/work_agent/contract.py:39-52` |
| 导航 | 左栏只有「新建任务」 | `src/frontend/src/features/work/routes/WorkNavigation.tsx:61-74` |

**结论**：先做扩展 UI 会变成假入口；E1/E2a/E2b 可以走提示词组合，E3a 必须改执行器，E3b/E4 是独立工程。

### 5.2 成果管线

| 约束 | 现状 | 代码 |
|---|---|---|
| 格式 | `.txt/.md/.csv/.json` 扁平文件名 | `src/work-agent/work_agent/contract.py:33-45`；`src/backend/work/agent_client.py:141-150` |
| Markdown 版本 | 上限 40,000 字符 | `src/backend/work/services.py:7`；`src/backend/work/task_api.py:27`；`src/backend/work/agent_runs.py:199` |
| 执行器总量 | 最多 20 个文件；总文本 400,000 字节 | `src/backend/work/agent_client.py:131-150` |
| 存储 | `WorkArtifactFile.text` / `WorkArtifactVersion.body` 文本字段 | `src/backend/work/models.py:197-235` |
| 前端 | Markdown 版本编辑/采纳/下载 | `src/frontend/src/features/work/routes/RunOutput.tsx` |

千问会产出 HTML、代码、PPTX、PDF、Office、图片、网页；当前 we-meet 除 JSON/Markdown 外都不支持。E2a/E2b 只能做文本型套件；E4-C/Workbench 才做富成果。

### 5.3 项目与上下文

- `WorkTask` 没有 project 字段；`WorkRun` 属于单个 task（`src/backend/work/models.py:10-32`、`src/backend/work/models.py:67-108`）；
- 每个 run 的成果只属于该 run；没有跨任务共享上下文目录；
- 云端执行器只挂载当前任务目录；本机有工作空间，但没有项目上下文抽象；
- 没有 `brief.json`/`flow-*.json` 之类的上下文 schema。

因此：**当前无法做真正的链式专家套件**；最多做「套件模板 + 提示词顺序」。

### 5.4 可复用资产

| 资产 | 复用方式 |
|---|---|
| `capabilities/` | 扩展为 preset/技能/连接器目录 |
| `WorkTask`/`WorkRun` | 增加 capability_snapshot；复用 owner/org、幂等、预算、审计 |
| `Idempotency-Key` | 能力选择纳入签名 |
| `agent_payload` | 组合后的执行目标/上下文引用 |
| 本机审批 | 连接器写操作复用逐命令确认 |
| 本机工作空间 | 未来项目上下文的本地落点 |
| `WorkArtifactVersion` | 文本成果版本；富成果升级 |
| Pi 复核 | 运行后策略，不进能力选择器 |
| 失败/未知处理 | 不自动重放、不自动扩权 |

### 5.5 差距矩阵

| 能力 | 现状 | E1 | E2a/E2b | E3a/E3b | E4 | 主要阻塞 |
|---|---|---|---|---|---|---|
| 方法技能 | 无 | 注册表 + 独立模式 | 套件默认技能 | 技能声明连接器依赖 | 链式 schema | 提示词长度、审核 |
| preset | 无 | 无 | E2a 套件；E2b 伙伴 | preset 建议连接器 | 完整工作流 | 产品定义、权限 |
| 链式上下文 | 无 | 无 | 无 | 无 | 项目上下文 + schema | 项目模型、文件目录 |
| 连接器 | 无 | 无 | 无 | E3a 只读 SaaS；E3b MCP/写入 | 增强 | 凭据、出网、MCP |
| 富成果 | 文本-only | 文本 | 文本 | 文本 | HTML/Office/PDF/图片 | 存储、预览、编辑、安全 |
| 工作台 | 无 | 无 | 无 | 无 | 设计/幻灯片 | 画布/编辑器 |
| 能力 UI | 无 | 技能 chip | 套件/伙伴 chip | 连接器 chip | 上下文/成果 | P0 composer 插槽 |
| 管理/审计 | 无 | 组织技能管理 | preset 管理 | 连接器管理 | 上下文/成果审计 | 管理员界面 |

### 5.6 上下文预算

```text
goal ≤ 2000 + background ≤ 4000 = 6000 字符
work-agent/v1 / work-local/v1 goal 上限 = 8000 字符
可用余量 ≈ 2000 字符（还须扣除前缀/分隔符）
```

- E1 技能说明合计 ≤ 2000；
- E2a/E2b 套件说明 + 技能说明 + 快捷命令模板 ≤ 2000；
- 不能把千问完整 `SKILL.md`/套件说明直接拼进目标；
- 长说明需要扩展 agent 契约（`instructions` 字段或提高上限），属于 E4/契约升级；
- 链式上下文不塞进 goal，而应作为文件/上下文引用。

---

## 6. 统一产品模型：WorkPreset

### 6.1 原则

1. 未实现不渲染；
2. 套件优先，伙伴后置；
3. 方法与数据分离；
4. 安装/启用/授权/调用分离；
5. 服务端解析并冻结；
6. 链式需要上下文，不靠提示词硬拼；
7. 输出标准优先；
8. 最小权限；
9. 环境边界清晰；
10. 富成果是独立工程。

### 6.2 类型

```ts
type PresetKind = 'suite' | 'partner'

type WorkPreset = {
  id: string
  kind: PresetKind
  name: string
  description: string
  version: number
  scope: 'builtin' | 'organization' | 'personal'
  enabled: boolean
  instructions?: string          // partner 模式；suite 可为空
  skill_ids: string[]            // 有序
  quick_commands: {
    id: string
    label: string
    prompt_template: string
    skill_id: string
  }[]
  output_standard?: {
    format: 'markdown' | 'json'
    schema?: string
    template?: string
  }
  connector_ids?: string[]       // E3a 才可用；E2a/E2b 只是建议
  preferred_environment?: 'cloud' | 'local'
  approval_mode?: 'ask' | 'read_only_auto'
  requires?: { connector_ids?: string[] }
  content_sha256: string
}

type WorkSkill = {
  id: string
  slug: string
  name: string
  description: string
  version: number
  scope: 'builtin' | 'organization'
  enabled: boolean
  instructions: string
  input_schema?: string
  output_schema?: string
  output: 'markdown' | 'json'
  requires?: {
    environment?: ('cloud' | 'local')[]
    connector_kinds?: string[]
    context_files?: string[]
  }
  content_sha256: string
}

type WorkConnector = {
  id: string
  name: string
  provider: string
  version: number
  scope: 'organization'
  enabled: boolean
  authorized: boolean
  grant_id?: string
  scopes: {
    id: string
    label: string
    access: 'read' | 'write'
  }[]
  environments: ('cloud' | 'local')[]
}

type CapabilitySnapshot = {
  version: 1
  resolved_at: string
  policy_version: string
  preset?: { id: string; kind: PresetKind; version: number; name: string; content_sha256: string }
  skills: { id: string; version: number; name: string; content_sha256: string }[]
  connectors: { id: string; version: number; name: string; grant_id: string; scopes: string[] }[]
  context?: { project_id: string; files: string[] }   // E4
}
```

### 6.3 suite vs partner

| 维度 | `suite`（E2a） | `partner`（E2b） |
|---|---|---|
| 定位 | 可复用工作方案包 | 轻量角色 + 默认能力 |
| 内容 | 技能 + 快捷命令 + 输出标准 | suite + 短 `instructions` |
| 记忆 | 无 | 无（首版） |
| 主页/自动化/资源 | 无 | 无 |
| 适用 | 团队统一产出 | 个人/团队角色复用 |
| 首版 | 是 | 可选，后置 |

没有 `instructions` 的 preset = 套件模板；有 `instructions` = 轻量伙伴。两者共用同一表、同一迁移、同一 API。

### 6.4 任务输入与快照

```json
{
  "kind": "office_agent",
  "goal": "...",
  "background": "...",
  "preset_id": "uuid",
  "quick_command_id": "uuid",
  "skill_ids": ["uuid"]
}
```

- E1 只接受 `skill_ids`；
- E2a/E2b 增加 `preset_id`/`quick_command_id`；
- E3a 增加 `connector_ids`/`connector_scopes`，例如：

```json
{
  "connector_ids": ["uuid"],
  "connector_scopes": { "uuid": ["read:projects"] }
}
```

- 未启用的字段拒绝，不忽略；
- 云端任务 API 不接受 `environment`；本机 tracked 走 `local/tasks/`；统一入口是 P2-A 的工作。

### 6.5 幂等、版本与命名

- 同键 + 相同目标/背景/preset/技能/连接器 → 返回原任务；
- 同键 + 不同选择 → `idempotency_conflict`；
- 任务快照冻结 preset/技能/连接器版本；更新不回溯；
- 对外：
  - `suite` 可叫「套件模板/工作方案」；
  - `partner` 才叫「工作伙伴」；
  - 没有 E4 时不要叫「完整专家套件」。

### 6.6 与两份独立报告的差异

统一版相对两份独立报告做了以下决策收敛：

| 项目 | 独立报告早期 | 统一版 |
|---|---|---|
| 产品模型 | 豆包篇 `WorkPartner`；千问篇 `WorkPreset` | 只用 `WorkPreset` |
| E2 | 豆包 E2 伙伴；千问 E2 套件 | E2a 套件；E2b 可选伙伴 |
| E3 | 早期范围不同：豆包含 MCP/写入，千问只读；旧估算已废弃 | 已收敛为 E3a 20–35 + E3b 15–25；以 §7.2 为准 |
| E4 | 编排器或单 run 二选一 | 服务端确定性编排器为基线 |
| 估算 | 两篇不同 | 统一表、统一开关/迁移 |

---

## 7. 统一路线图与工作量

### 7.1 分期

| 阶段 | 范围 | 依赖 | 退出标准 |
|---|---|---|---|
| P0 | 统一 composer、会话、历史、注意项（既有） | 无 | 既有 P0 验收 |
| E1 | 方法技能注册表、独立模式、选择、快照 | P0 composer；迁移 0013；`WORK_SKILLS_ENABLED` | 技能可见/可移除/冻结；untracked 不支持 |
| E2a | 套件模板：技能 + 快捷命令 + 输出标准；无链式 | E1；迁移 0014；`WORK_PRESETS_ENABLED` | 套件预填正确；无链式/连接器/富成果入口 |
| E2b | 可选工作伙伴：短 instructions、组织共享 | E2a；无新迁移 | preset 默认值可移除；无记忆/主页/自动化 |
| E3a | 云端只读 SaaS 连接器：OAuth/HTTP，不含 MCP/写入 | E2a/E2b；迁移 0015；Gateway v2；`WORK_CONNECTORS_ENABLED` | 只读连接器可授权/调用/撤销；令牌不泄露 |
| E3b | 本机连接器、MCP、写入 | E3a；迁移 0016+；桌面/适配器 v2 | 本机凭据、审批、审计、撤销 |
| E3 管理/安全 | 管理员目录、策略、审计、威胁建模、渗透 | 可与 E3a/b 并行 | 管理/审计/安全评审通过 |
| E4-A | 项目上下文、schema | P2 项目；迁移 0017+ | 上下文可读写；来源可追溯 |
| E4-B | 链式执行：服务端确定性编排器 | E4-A | 技能读取前序产出；schema 校验 |
| E4-C | 富成果管线（存储/预览/下载；编辑另估） | E4-A/B | 格式白名单；安全扫描 |
| E4-D | 连接器增强 | E4-A/B/C；连接器 | 基础可用、增强可选 |
| E4 测试/安全 | 编排/成果/上下文测试、威胁建模、渗透 | E4-A/B/C；可与 D 并行 | 测试/安全评审通过 |
| Workbench | 设计/幻灯片画布 | E4；详见独立报告 | 工作台验收 |

### 7.2 工作量

> 估算假设：1 名前端 + 1 名后端/桌面为主；不含视觉设计、QA、发布值守、运维、法务/合规评审、存储与模型调用成本。数字为规划区间，不是承诺；E3b/E4/Workbench 单独排期。

| 阶段 | 内容 | 估算（人日） | 说明 |
|---|---|---|---|
| E1 | 注册表、组合、快照、前端、测试 | 8–12 | 不改 Gateway wire；tracked 需桌面小改 |
| E2a | 套件模型、快捷命令、输出标准、前端 | 8–12 | 仅预设 |
| E2b | 伙伴 instructions、组织共享、审计 | +2–4 | E2 合计 10–16 |
| E3a | 只读 SaaS、OAuth/HTTP、凭据、工具循环、审计 | 20–35 | 暂定，需 bottom-up 重估 |
| E3b | 本机连接器、MCP/写入、桌面运行时 | 15–25 | 单独立项 |
| E3 管理/安全 | 管理员目录、策略、审计导出、合规、威胁建模、渗透 | 5–10 | 可与 E3a/b 并行 |
| E4-A | 项目上下文、schema | 20–30 | 依赖项目模型 |
| E4-B | 确定性编排器 | 10–15 | 最小实现；多子 run 重试/取消/审计另计 |
| E4-C | 富成果存储/预览/下载/安全 | 20–30 | 不含完整 Office 在线编辑/画布 |
| E4-D | 连接器增强 | 5–10 | 可后置 |
| E4 测试/安全 | 编排/成果/上下文测试、威胁建模、渗透 | 5–10 | 可与 E4-B/C 并行 |
| Workbench | 设计/幻灯片画布 | 30–50+ | 独立工程，需重估 |

E1+E2：18–28 人日；E3：40–70；E4：60–95+；Workbench：30–50+。设计/幻灯片工作台不含在 E4 的 60–95+ 内。

### 7.3 估算边界

- E4 60–95+ 覆盖 E4-A/B、E4-C 的基础存储/预览/下载、E4-D 增强和 E4 测试/安全；
- 不含完整 Office 在线编辑、设计画布/PPT 编辑器（Workbench 30–50+）；
- 若把 Office/HTML 在线编辑纳入 E4-C，需再加 15–25 人日；
- E4-B 10–15 只指最小确定性编排器；若把多子 run 重试/取消/审计纳入，需再加 5–10 人日；
- 含上述增项的完整 E4 约 80–130 人日，需在立项后按团队能力、存储/安全评审、QA 成本二次估算。

### 7.4 开关与迁移

- E1：`WORK_SKILLS_ENABLED`；迁移 0013；
- E2a/E2b：`WORK_PRESETS_ENABLED`；迁移 0014；不新增 `WORK_PARTNERS_ENABLED`；
- E3a/E3b：`WORK_CONNECTORS_ENABLED` + 按连接器/租户 kill switch；迁移 0015/0016+；
- E4：`WORK_CONTEXT_ENABLED` / `WORK_RICH_ARTIFACTS_ENABLED`；迁移 0017+；
- `0012` 未上生产前不应用 `0013+`；每期独立开关、独立回滚。

### 7.5 发布与回滚

- E1：关闭开关隐藏技能选择，已创建任务保留快照；
- E2：关闭后不能新建/选择 preset，已创建任务保留快照；
- E3：按连接器/租户 kill switch；撤销 grant；保留审计；Gateway v2 回滚前排空；
- E4：项目上下文/富成果独立开关；存储/预览回滚不回删成果；未知执行不重放；
- 旧客户端：E1/E2a/E2b 的 `execution_goal` 可选，旧桌面忽略并退化；E3a/E3b/E4 不承诺旧 Gateway 兼容。

---

## 8. UX、契约与数据模型

### 8.1 UI

**E1 技能**

```text
[目标输入]
[已选：技能 A ×] [技能 B ×]
[+] [技能] [环境] [权限]                 [发送]
本次使用：技能 A（输出 Markdown）、技能 B（输出清单）
```

**E2a/E2b 套件/伙伴**

```text
[目标输入]
[已选：套件 P ×] [技能 A ×] [技能 B ×]
[+] [套件/工作伙伴] [技能] [环境] [权限]      [发送]
本次使用：套件 P（技能 A、B；可移除）· 预设模式，暂不支持链式上下文
```

**E3a 连接器**

```text
[目标输入]
[已选：套件 P ×] [技能 A ×] [连接器 C ×]
[+] [套件/工作伙伴] [技能] [连接器] [环境] [权限]   [发送]
本次访问：C（只读：项目、任务）；账号已连接；数据将发送到模型服务
```

**E4 完整套件**

```text
[目标输入]
[已选：套件 P ×] [快捷命令 /动效规划] [连接器 C ×]
[+] [套件/工作伙伴] [技能] [连接器] [项目] [环境] [权限]  [发送]
本次计划：项目「会员改版」· 读取 brief.json / flow-web.json · 输出 motion-plan.json
```

状态：

| 状态 | 文案 | 动作 |
|---|---|---|
| 无可用能力 | 不渲染 | 无 |
| 加载中 | 正在加载… | 禁用 |
| 未安装/未启用 | 未启用 | 去设置启用 |
| 未授权连接器 | 未连接 | 连接 |
| 授权过期 | 授权已过期 | 重新连接 |
| 组织禁用 | 组织已禁用 | 不可选 |
| 环境不支持 | 仅云端/仅本机 | 阻止；不自动切换 |
| 套件无链式 | 当前为预设模式 | 显示说明；不假装链式 |
| 上下文缺失 | 缺少 brief.json，将按独立模式执行 | 提示；可继续 |
| schema 不匹配 | 上游输出不符合套件 schema | 阻止/降级并提示 |
| 成果格式不支持 | 当前仅支持 Markdown/JSON | 阻止；不做假下载 |
| 超限 | 最多 3 个技能 | 禁用更多 |

可访问性：button + `aria-expanded`；多选 `aria-pressed`；chip 移除 `aria-label`；错误 `role="alert"`；计划摘要可朗读。

### 8.2 API

**capabilities** 新增（保留旧字段）：

```json
{
  "skills": ["office_agent"],
  "task_skills": [],
  "presets": [
    {
      "id": "uuid",
      "kind": "suite",
      "name": "产品设计",
      "version": 1,
      "skill_count": 5,
      "quick_command_count": 8,
      "scope": "organization",
      "enabled": true
    }
  ],
  "connectors": []
}
```

**任务创建**：

```json
{
  "kind": "office_agent",
  "goal": "...",
  "background": "...",
  "preset_id": "uuid",
  "quick_command_id": "uuid",
  "skill_ids": ["uuid"]
}
```

E3a 在同一请求追加：

```json
{
  "connector_ids": ["uuid"],
  "connector_scopes": { "uuid": ["read:projects"] }
}
```

**响应**：

```json
{
  "capability_snapshot": {
    "version": 1,
    "preset": { "id": "uuid", "kind": "suite", "version": 1, "name": "产品设计", "content_sha256": "..." },
    "skills": [{ "id": "uuid", "version": 1, "name": "动效规划", "content_sha256": "..." }],
    "connectors": []
  }
}
```

**幂等**：同键 + 相同目标/背景/preset/快捷命令/技能/连接器 → 原任务；不同 → 409。

**执行 payload**：

- E1/E2a/E2b 不改 Gateway wire；服务端把 preset/技能说明组合进 `agent_payload.goal`；
- 本机 tracked 在 `WorkRun.agent_payload` 保存 `execution_goal`，claim 返回；桌面用它提交，历史显示原目标；
- E3a/E3b 使用 `work-agent/v2` 或先升级所有 Gateway；job payload 只传连接器 ID/grant 引用/scope/操作白名单，不传令牌；
- E4 增加 `context` 引用；E4-B 由服务端确定性编排器逐步执行。

### 8.3 环境支持

| 能力 | 云端 | 本机 tracked | 本机 untracked |
|---|---|---|---|
| E1 技能 | 支持 | 支持（`execution_goal`，需新桌面） | 不支持 |
| E2a 套件 | 支持 | 支持（同上） | 不支持 |
| E2b 伙伴 | 支持 | 支持（同上） | 不支持 |
| E3a 只读 SaaS | 支持（Gateway v2） | 不做 | 不支持 |
| E3b 本机/MCP/写入 | 不做 | 另立 E3b | 不做 |
| E4 链式 | 支持（项目上下文） | 支持（本地工作空间，需桌面） | 不支持 |
| E4 富成果 | 支持（对象存储/预览） | 支持（本地文件 + 同步策略） | 有限 |
| 浏览器/计算机控制 | 不做 | 不做 | 不做 |

### 8.4 与 P0/P1/P2 的关系

- P0 统一 composer、会话、历史、注意项不受影响；E1 使用 composer 的 `tools` 插槽；
- E1 可与 P1 档位并行；E2a/E2b 依赖 E1；
- E3a 依赖执行器 v2；E3b 依赖桌面/适配器 v2；
- E4 依赖 P2 项目/工作区、成果管线、存储；
- 扩展工作不阻塞 P0；不渲染未实现能力。

---

## 9. 测试、验收与指标

### 9.1 分阶段验收

**E1**

- 技能可见/可移除/冻结；独立模式；
- 同键同选择幂等；不同选择冲突；
- 超长/跨组织/禁用/未知技能拒绝；
- 云端/tracked 执行带技能；untracked 明确不支持；
- 技能内容不含密钥/工具调用；注入测试通过。

**E2a/E2b**

- preset/快捷命令/默认技能正确预填；
- 技能选择顺序确定；执行顺序不保证（E4 才保证）；
- preset 版本/哈希冻结；组织 preset 只读；个人字段保留但首版不开放；
- 无链式/无连接器/无富成果入口；
- 伙伴模式无记忆/主页/自动化/小队；
- 云端/tracked 一致；untracked 不支持。

**E3a/E3b**

- E3a 只读 SaaS 可连接/授权/调用/撤销；E3b 另立验收；
- 未授权/过期/scope 不足/限流/不可用状态明确；
- 令牌不在 payload/日志/事件/埋点；
- 跨组织/越权 scope 拒绝；
- 任务详情可审计；撤销后停止新调用；
- 不自动调用/写入/降级。

**E4**

- 项目上下文可读写；技能输出 schema 校验；
- 链式技能读取前序产出；缺失/不匹配有明确状态；
- 上下文来源/版本/哈希可追溯；
- 富成果可预览/下载；HTML 沙箱；Office 安全扫描；
- 任务快照包含 preset/技能/上下文版本；
- 连接器增强可选，基础能力不依赖连接器；
- 不自动扩权/不自动重放。

### 9.2 测试分层

| 层 | 用例 |
|---|---|
| 纯函数 | preset 解析、技能顺序、快捷命令、去重、上限、字符预算、快照哈希、幂等签名 |
| 后端 | preset/技能 CRUD、组织范围、禁用、未知 ID、跨组织、版本冻结、上下文 schema、撤销 |
| 前端 | preset/技能/连接器选择、快捷命令预填、chip 移除、禁用原因、超限、冲突、链式/预设提示 |
| 桌面/适配器 | `execution_goal` 透传、旧桌面兼容、历史显示原目标、本机审批 |
| Gateway | v2 字段、feature 协商、工具白名单、出网、令牌 broker、调用审计 |
| 成果 | HTML 沙箱、Office 预览、MIME/病毒扫描、大小/数量上限、下载授权 |
| 安全 | 提示词注入、技能内容越权、连接器结果注入、令牌泄露、SSRF、跨租户、写操作审批 |
| 手工 | 安装/启用/授权/调用/撤销；组织禁用；离线/过期/限流；项目上下文；富成果 |

### 9.3 指标与埋点

指标：

- 套件采用率、套件内技能使用率、快捷命令点击率；
- 组合率（套件 + 技能 + 连接器）；
- 技能独立/链式/增强模式占比；
- 任务成功率/返工率（按组合分组）；
- 连接器授权完成率、调用成功率、撤销时延；
- 上下文命中率、schema 校验失败率；
- 富成果预览/下载/编辑率；
- 预算/上下文超限率；
- 用户移除预设技能的比例。

埋点（不采集正文/路径/令牌/连接器返回数据）：

- `work_preset_view`（kind/id）
- `work_preset_select`（id/version）
- `work_quick_command_click`（preset_id/command_id）
- `work_skill_select`（id/version/mode）
- `work_connector_authorize`（id/scope_count/status）
- `work_connector_call`（id/operation/status）
- `work_context_resolve`（file_count/schema_status）
- `work_artifact_preview`（mime/status）
- `work_capability_blocked`（reason）

---

## 10. 产品假设与验证

竞品与代码分析不能替代用户验证；以下三条在立项前需要小样本验证：

1. **套件模板是否比“角色伙伴”更容易上手**：5–8 位目标用户，3 个任务场景（写作、分析、整理），观察首次配置耗时、能力理解度、复用意愿；如果用户更偏好角色人设，E2b 应提前。
2. **可见计划与只读连接器是否提升信任**：用原型对比“自动匹配”与“提交前展示本次任务计划”，观察授权完成率、放弃率和错误率。
3. **E4 的链式/富成果是否有真实需求**：如果用户只需要一次性文本成果，E4 不应启动；如果用户愿意为连续工作流等待/付费，再投入项目上下文与富成果。

验证退出：

- H1 失败 → 调整 E2b 优先级或改回伙伴优先；
- H2 失败 → 简化计划展示，但保留连接器显式授权；
- H3 失败 → 停在 E1/E2a/E3a，不投入 E4/Workbench。

---

## 11. 风险与开放问题

| 问题/风险 | 影响 | 建议 |
|---|---|---|
| 首版要不要做链式？ | 决定 E2a 是否能叫「专家套件」 | 不做链式就称「套件模板」；真链式放 E4 |
| 项目上下文放哪里？ | 云端/本机/跨设备 | 云端项目 + 本地工作空间双轨；绝对路径不出设备 |
| 富成果优先级？ | 决定能否做设计/幻灯片套件 | 先做文本型套件；富成果独立立项 |
| 是否支持 HTML/Office/PDF？ | 存储、预览、编辑、安全 | E4-C；先只读预览/下载，编辑后置 |
| 套件更新策略？ | 覆盖个人修改 vs 冻结 | 任务快照冻结；更新只影响新任务 |
| 是否允许用户自建技能？ | 质量/安全/版权 | 首版组织策展；个人后置 |
| 是否展示原始 SKILL.md？ | 透明度 vs 泄露 | 终端摘要；管理员原文 |
| 自定义 MCP/STDIO？ | 任意命令/出网 | 首版不做；仅管理员签名运行时 |
| 浏览器/计算机控制？ | 高权限/误操作 | 首版不做；本机保留逐命令审批 |
| 连接器写操作？ | 副作用/审计 | E3a 只读；E3b 逐次确认 |
| 套件市场/分享？ | 质量/责任主体 | 首版组织内策展；公开市场后置 |
| 模型档位与套件耦合？ | 质量/成本 | 套件声明最低档位；服务端解析；客户端不覆盖 |
| 远程派发携带套件？ | 设备 A→B 一致性 | 首版不带；后续扩展 `work-device/v1` |
| 本机 untracked 支持？ | 隐私 vs 组织策略 | 首版不支持；避免绕过审计 |
| 用户是否愿意为 E4 等待/付费？ | 投入回报 | 先做 5–8 人验证；不通过则停在 E1/E2a/E3a |

需要产品拍板：

1. 首版 E2a 套件模板是否足够，E2b 工作伙伴是否同批？
2. 是否投入 E4 的项目上下文/富成果？
3. 连接器边界：E3a 只读 SaaS，还是同时做 E3b 本机/MCP/写入？
4. 套件内容来源：组织策展，还是允许个人上传/市场？

---

## 12. 证据与索引

### 12.1 独立报告

- [豆包工作「扩展」能力调研与 we-meet 任务能力方案](work-extension-doubao-research-2026-10-25.md)
  - 14 张截图、伙伴配置、技能/插件、任务组合、安全、E1–E4 细节、完整证据索引。
- [千问办公「扩展」能力调研与 we-meet 专家套件方案](work-extension-qwen-research-2026-10-25.md)
  - 14 张截图、专家套件/快捷命令/链式模式、连接器、富成果、工件边界、完整证据索引。

### 12.2 官方资料

千问：

- [扩展：专家套件、技能与连接器](https://help.aliyun.com/zh/qwenwork/qwenwork-extensions-1)
- [专家套件](https://help.aliyun.com/zh/qwenwork/expert-kit)
- [技能](https://help.aliyun.com/zh/qwenwork/skills)
- [连接器](https://help.aliyun.com/zh/qwenwork/desktop-connectors)
- [Web 端使用链路](https://help.aliyun.com/zh/qwenwork/qwenwork-web-usage)
- [工作台-设计](https://help.aliyun.com/zh/qwenwork/qw-workbench-design)
- [工作台-幻灯片](https://help.aliyun.com/zh/qwenwork/workbench-slides)

豆包：

- [在豆包工作中使用伙伴和小队](https://www.doubao.com/work/docs/zh-cn/articles/559204524686-workmates)
- [在豆包工作中使用技能](https://www.doubao.com/work/docs/zh-cn/articles/081010973544-skills)
- [在豆包工作中使用插件](https://www.doubao.com/work/docs/zh-cn/articles/705018132598)
- [使用工作任务模式](https://www.doubao.com/work/docs/zh-cn/articles/047323472965-work-task-mode)
- [《豆包工作任务功能须知》](https://www.doubao.com/legal/DoubaoAgentModeNotice)
- [使用豆包工作伙伴（飞书帮助中心）](https://www.feishu.cn/hc/zh-CN/articles/790732948604)

### 12.3 截图资产

- [豆包 14 张](assets/doubao-work)
- [千问 14 张](assets/qwen-work)
- 两张早期新任务全图：[豆包](assets/doubao-work-new-task-2026-10-25.png)、[千问](assets/qwenwork-new-task-2026-10-25.png)

### 12.4 代码索引

| 主题 | 位置 |
|---|---|
| capabilities 返回 | `src/backend/work/api.py:59-80` |
| 云端任务输入 | `src/backend/work/task_api.py:20-22` |
| 云端 agent payload | `src/backend/work/agent_runs.py:59-69` |
| 幂等比较 | `src/backend/work/runs.py:89-113` |
| 本机准入 | `src/backend/work/local_api.py:27-33` |
| WorkTask / WorkRun | `src/backend/work/models.py:10-32`、`:67-108` |
| 成果模型 | `src/backend/work/models.py:197-235` |
| 成果字符上限 | `src/backend/work/services.py:7` |
| agent 客户端成果校验 | `src/backend/work/agent_client.py:131-150` |
| agent 严格请求 | `src/work-agent/work_agent/contract.py:39-52`、`:33-45` |
| 本机适配器提交 | `src/work-agent/work_agent/local.py:146-153` |
| 桌面提交白名单 | `src/desktop/src/main.ts:794-804` |
| 执行器禁用扩展 | `src/work-agent/work_agent/drivers.py:120-145` |
| 执行器能力声明 | `src/work-agent/work_agent/config.py:111-169` |
| 执行器范围说明 | `src/work-agent/README.md:155` |
| 本机 claim | `src/backend/work/local_runs.py:170-198` |
| 协调器 claim 使用 | `src/desktop/src/work-coordinator.ts:145-158` |
| 前端 capabilities 类型 | `src/frontend/src/features/work/api/work.ts:4-18` |
| 前端任务输入 | `src/frontend/src/features/work/api/tasks.ts:24-39`、`:56-66` |
| composer | `src/frontend/src/features/work/routes/TaskComposer.tsx:21-43` |
| 云端 composer 接入 | `src/frontend/src/features/work/routes/AgentWork.tsx:249-277` |
| 本机 composer 接入 | `src/frontend/src/features/work/routes/LocalWorkspaceWork.tsx:407-566` |
| 工作导航 | `src/frontend/src/features/work/routes/WorkNavigation.tsx:61-74` |
| 成果前端 | `src/frontend/src/features/work/routes/RunOutput.tsx` |

---

## 13. 一句话结论

**两家产品共同证明「扩展必须是任务能力组合」，千问进一步证明「套件 + 链式上下文 + 富成果」是团队级工作流的方向；we-meet 应先用 `WorkPreset` 做 E1 方法技能和 E2a 套件模板，再做 E3a 只读连接器，E3b/E4 单独立项；在没有项目上下文、schema 和富成果管线之前，不要把「套件模板」说成完整专家套件。**
