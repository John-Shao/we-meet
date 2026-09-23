# Work 办公模块

当前实现私人材料上传与沟通准备：上传 → 解析预览 → 选择版本和沟通目标 → 后台生成 → 引用核对 → 编辑、采纳和 Markdown 下载。支持 TXT / Markdown、文本型 PDF 和受限 DOCX。**已通过本地隔离联调，真实模型与生产部署尚未验收，不能据此宣布 P0-1 正式放行。** 周报和表格分析仍为后续批次。产品范围统一维护在 [Work 计划](../../../docs/plan/work-module-product-architecture-agent-plan-2026-09-21.md)。

## 启用与运行

默认关闭 `WORK_ENABLED`、`WORK_MATERIALS_ENABLED`。部署时先执行 `python manage.py migrate`，确认私有存储和独立 worker 可用，再将两个环境变量设为 `true`；前端配置接口据此显示“工作”导航。共用 Web / 桌面路由为 `/work`（兼容 `/work/new`），本批的选中文件和列表页码保存在查询参数中。

使用现有 Django / Celery 环境，启动专用队列：

```sh
celery -A meet.celery_app worker -Q work --concurrency=2 --loglevel=INFO
```

由现有 Celery beat 每 5 秒投递 `work.tasks.tick_materials` 到 `work` 队列，不让会议队列执行文件解析。数据库中的材料状态同时作为持久解析队列；无需在上传事务后依赖一次不可靠的 broker 投递。也可用 `python manage.py process_work_materials` 执行有界批次（最多 20 份），用于开发或调度恢复。关闭开关后停止领取新解析，已开始的步骤在保存时重新检查开关；读取已有材料与删除仍可用。

解析领取采用行锁、两分钟租约与递增 generation；worker 超时或崩溃后可重新领取，迟到结果不能覆盖新一轮或已删除记录。删除立即清除解析文本并拒绝后续访问，原文件由同一调度器清理；失败保留墓碑重试，不因清理失败恢复可见性。

沟通准备额外使用以下独立设置，不读取会议模型的 `from_settings()`，不改变会议队列或模型配置：

| 设置 | 默认 / 用途 |
|---|---|
| `WORK_COMMUNICATION_ENABLED` | `false`；开启生成入口仍须同时启用 `WORK_ENABLED` 并配置下列模型项 |
| `WORK_MODEL` | 空；实际兼容接口模型 ID |
| `WORK_MODEL_BASE_URL` | 空；经部署方验证的模型接口根地址 |
| `WORK_MODEL_API_KEY` | 空；通过现有 SecretFileValue / secret 注入，不写入前端或运行记录 |
| `WORK_DAILY_TOKEN_BUDGET` | 100000；按服务端时区自然日、owner 全组织合计的预占 token 额度 |
| `WORK_MAX_OUTPUT_TOKENS` | 3000；代码硬上限 4000 |

`GET /api/v1.0/work/capabilities/` 只在配置完整时返回 `communication_enabled=true`，这属于配置预检，不等于模型可用性和效果验收。只有材料开关开启时也可先使用上传预览。共用路由 `/work?view=communication`；成功提交后 URL 增加 `task=<uuid>`，刷新恢复同一任务。

Beat 每 5 秒投递 `work.tasks.tick_runs`，每次最多处理一个运行。开发和调度恢复可执行 `python manage.py process_work_runs`。数据库 `WorkRun(status=queued)` 行本身承担事务 Outbox，任务、运行和首条事件在同一事务创建；Worker 在数据库领取，重复投递不产生第二次调用。运行租约 2 分钟，SDK 单次请求超时 45 秒、重试次数 0，Celery 软 / 硬时限为 65 / 80 秒。

关闭沟通开关后拒绝新建和重试，已排队运行保留等待；在途结果交付前重新检查开关，关闭时以失败终态结束，不发布成果。已有运行、编辑、采纳和下载仍按权限开放。回退时先关闭生成和材料写入开关、停领新工作，保留数据库迁移与历史数据；不要直接反向删除有数据的迁移。

## 运行与成果契约

- `WorkTask` 是私人办公目标，独立于 `core.Task`（人的待办）。最多选择 10 份 / 合计 30 MiB 的 ready 材料，冻结 ID、SHA-256、解析器版本及 generation；对象、目标和背景按字段限制长度。任务参数不可覆盖修改，修改目标新建任务。
- 创建使用 UUID `Idempotency-Key`，owner 行锁串行执行配额和请求去重；同键同输入返回原任务，同键不同输入返回 409。重新生成产生新 `WorkRun`，原稿保留；相同重试 key 只创建一次，每任务最多 20 个运行，不允许同时存在两个活动运行。
- `WorkRun` 保存模型、端点、固定执行版本、预占额度、调用起点、实际输入 / 输出 token 和用量记录。状态为 `queued / running / succeeded / failed / canceled`；过期 running 转为 `failed + execution_unknown`，**不自动重发结果不明的付费调用**。用户明确选择重新生成才再调用；取消只阻止后续成果发布，已开始的模型请求可能仍计费。
- 当前是 token 额度，不是人民币预算：按完整提示的 UTF-8 字节数 + 消息余量 + 最大输出预占，失败、取消或缺用量仍保留当日预占，不自动退还；实际 usage 另存并归因 `AIUsageRecord.ref_type=work_run`，组织按任务冻结。缺 usage 展示“待确认”，未配置模型价格不宣称免费。金额预算、结算及额度释放对账后续完善。
- 固定 `CommunicationExecutor` 一次结构化调用，无工具、检索、会议或外部写入。选中材料与补充背景合计最多 12000 字符，序列化提示另限 55000 UTF-8 字节；完整读取超限直接拒绝，不静默截断。模型结果用 JSON Schema 校验，事实引用必须属于选中材料、行号有效、引文是对应行的精确片段；事实含义和建议仍需人工核实。
- `WorkRunEvent` 在运行锁内分配单调 seq，`GET runs/<id>/events/?after=<seq>` 最多返回 100 条，前端重连按游标补拉并去重。事件只包含阶段和时间，不含源文、密钥或供应商错误正文。
- 提交、执行和成果读取 / 修改 / 下载时均重查 owner、当前组织和来源版本。删除材料会让引用它的成果不可再读；晚到结果无法覆盖取消或失效状态。当前没有公开链接、共享或自动发送。
- 成果按版本追加；保存必须携带 `base_version`，并发覆盖返回 409，前端保留本地修改并支持读取最新版比较。每运行最多 100 版本、正文最多 40000 字符。采纳明确指定当前版本且幂等；历史版本保留，编辑后的版本需重新采纳。人工编辑不会自动重写或再次校验初稿引用，界面明确说明。
- 下载指定已保存版本，走认证接口，`Content-Disposition: attachment`、`Cache-Control: no-store`；前端使用带身份校验的 Blob 下载，不创建公开存储 URL。未保存时先保存再采纳 / 下载；离开页面的未保存文本不持久化。

接口前缀均为 `/api/v1.0/work/`：`tasks/`（列表 / 创建）、`tasks/<id>/`（恢复）、`tasks/<id>/retry/`；`runs/<id>/events/`、`cancel/`、`artifact/`（读取 / 追加版本）、`adopt/`、`download/?version=N`。读取旧版本使用 `artifact/?version=N`。

## 存储、权限与限制

默认 `WORK_STORAGE` 使用 `work.storage.PrivateMaterialStorage`，沿用部署的 S3 连接参数，独立 `work-materials` 前缀、随机对象名、私有 ACL 与禁止公共 URL 的访问方式。可用该设置的 `OPTIONS` 指定独立 bucket。生产启用前验证 bucket policy 也不允许公共读取；ACL 不能覆盖宽松的 bucket policy。开发测试可将 `WORK_STORAGE` 改为 `FileSystemStorage`，但目录必须位于 Web 不提供静态访问的位置；多 worker 必须共享该存储。

- 权限要求真实、有效、非设备账号；查询同时限制 owner 和服务端解析的当前组织。没有组织的个人资料也只属于 owner，组织改变不自动迁移旧资料。
- 每请求一份文件，上传流与实际读入均限制 10 MiB；每批、每任务最多 10 份 / 30 MiB，账号限制 100 份 / 100 MiB（待清理文件仍占额度）。
- `.txt / .md / .markdown` 使用 UTF-8，拒绝伪装的二进制文件、空文件及控制字符；`.pdf / .docx` 校验扩展名与文件签名后异步解析。所有解析上限 20 万字符、5 万行，不静默截断源文。
- PDF 使用锁定的 `pypdf==6.19.0`，最多 100 页，单页解压内容流最多 2 MiB；加密 PDF、存在无文字页的 PDF 拒绝，OCR 后置。页内行序由提取器决定，不能保证复杂多栏文档的阅读顺序；预览标明页码供人工核对。[上游内存与文字提取说明](https://github.com/py-pdf/pypdf/blob/main/docs/user/extract-text.md)
- DOCX 使用 ZIP 检查与 `defusedxml==0.7.1`，最多 1000 个部件 / 解压合计 20 MiB；解析正文段落和表格单元格，引用定位到段号或表 / 行 / 列。不执行宏，不抓取超链接；拒绝宏、嵌入文件、图片、修订、页眉页脚、注释、脚注、嵌套表格及不支持的正文容器，避免把局部正文当作完整材料。复杂文件需核对后另存纯文本。
- PDF / DOCX 在不继承应用凭证的子进程解析，父进程超时 25 秒；子进程硬限 512 MiB，Linux 使用 RLIMIT_AS / CPU 20 秒，Windows 使用 Job Object，资源隔离创建失败则拒绝解析。解析代码不发网络请求；部署仍应按工作池配置网络出口与容器资源边界，不能将本地容器验证视为生产网络隔离已配置。
- 预览一次 100 行、每行最多展示 2000 字符，长行明确标记截断。前端以文本显示 Markdown / HTML，不运行脚本、不加载外链。
- 预览和列表不返回存储 key，响应带 `Cache-Control: no-store`。上传必须提供 UUID `Idempotency-Key`；相同键与内容复用原结果，改变内容返回 409，已删除返回 410。重试还校验 generation，避免旧请求启动新一轮。
- 解析时不调用模型、不读会议、不发送消息；输入正文不进入日志。会话认证保留 CSRF 校验，前端退出工作区时中止余下上传批次。

本批在数据库提交失败时尝试清理新对象；进程在对象落盘和数据库提交之间被硬杀仍可能留下未登记对象。生产上线前需配置该前缀的孤立对象对账 / 留存清理，并验证私有 bucket、资源限制和真实上传。没有把本地文件系统测试当成生产对象存储验收。

## 验证记录（2026-09-23）

第二批沟通准备（基线 `09a7841f9`）：

- PostgreSQL 16 的 53 项后端测试通过，随后新增实际内存分配上限检查并通过文档子集 9 项复验（合计 54 项）；13 项前端交互测试通过。覆盖请求重放 / 并发去重、额度拒绝、引用造假、模型异常、取消晚到、过期运行、跨账号 / 撤权、版本冲突、历史与下载。模型响应是明确的测试 fixture。
- Windows 真实子进程的 PDF / DOCX、加密 / 无文字 PDF、文档嵌入内容、XML 实体、ZIP 超限和超时路径通过；另在 Python 3.13 Linux 容器（无网络、只读挂载、512 MiB、1 CPU）验证文字 PDF / DOCX、加密 PDF、无文字 PDF 四个样本通过。
- Playwright 专用窗口通过真实本地 Django + PostgreSQL + Worker + OpenAI 兼容 SDK，对接本地 HTTP fixture 模型：上传 → 生成 → 刷新 → 编辑 v2 → 采纳 → Markdown 下载 → 删除材料后拒绝读取成果；页面异常为 0，1440 / 1024 / 390 px 无横向溢出。fixture 模型用于联调，不是实际模型能力验收。
- 类型、ESLint、Ruff、迁移一致性与生产构建通过；保留既有大 chunk / 品牌资源提示。未部署生产，也未重打 Electron 安装包。
- 待完成：确认真实模型服务配置并运行有引用与实际用量的合成样本，验证生产私有存储 / 工作池资源和办公桌面冒烟，再决定 P0-1 放行与 P0-2 周报开工。

首批材料（提交 `09a7841f9`）历史验收：

- 独立 PostgreSQL 16：30 项 API / 存储 / 恢复测试通过，包括真实并发上传去重、CSRF、跨账号 / 撤权、租约恢复、删除晚到与清理失败。
- 前端：7 项交互测试通过，另通过 TypeScript、ESLint、JSON / 语言键结构检查和生产构建。构建仍有既有品牌资源及大 chunk 提示。
- Playwright 专用窗口连接本地真实 Django API、PostgreSQL 和解析 worker：上传 → 解析 → 预览 → 刷新恢复 → 删除 → 旧链接拒读通过，页面错误为 0；1440 / 1024 / 390 px 已查看，无横向溢出。
- 浏览器使用本地自建账号与测试会话；不是生产 OIDC、生产对象存储或已安装 Electron 包的验收。没有部署到 `meet.we-meet.online`，也没有改变会议配置。

复验命令（使用隔离数据库和项目既有测试环境设置）：

```sh
python -m pytest work/tests --reuse-db
python -m ruff check work
python manage.py makemigrations work --check --dry-run
```

前端测试为 `src/features/work/routes/{WorkRoute,Communication}.test.tsx`。本地浏览器证据保留在 gitignored 的 `src/desktop/test-results/work-ui-local.json`、`work-communication-ui.json` 及对应截图；测试会话、合成文件和模型 fixture 服务均不提交。
