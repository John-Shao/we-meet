# Work 办公模块

当前交付材料底座：私人 TXT / Markdown 上传、异步解析、列表、按行预览、删除与失败重试。暂不提供任务生成、沟通准备、周报或表格分析。产品范围与后续步骤统一维护在 [Work 计划](../../../docs/plan/work-module-product-architecture-agent-plan-2026-09-21.md)。

## 启用与运行

默认关闭 `WORK_ENABLED`、`WORK_MATERIALS_ENABLED`。部署时先执行 `python manage.py migrate`，确认私有存储和独立 worker 可用，再将两个环境变量设为 `true`；前端配置接口据此显示“工作”导航。共用 Web / 桌面路由为 `/work`（兼容 `/work/new`），本批的选中文件和列表页码保存在查询参数中。

使用现有 Django / Celery 环境，启动专用队列：

```sh
celery -A meet.celery_app worker -Q work --concurrency=2 --loglevel=INFO
```

由现有 Celery beat 每 5 秒投递 `work.tasks.tick_materials` 到 `work` 队列，不让会议队列执行文件解析。数据库中的材料状态同时作为持久解析队列；无需在上传事务后依赖一次不可靠的 broker 投递。也可用 `python manage.py process_work_materials` 执行有界批次（最多 20 份），用于开发或调度恢复。关闭开关后停止领取新解析，已开始的步骤在保存时重新检查开关；读取已有材料与删除仍可用。

解析领取采用行锁、两分钟租约与递增 generation；worker 超时或崩溃后可重新领取，迟到结果不能覆盖新一轮或已删除记录。删除立即清除解析文本并拒绝后续访问，原文件由同一调度器清理；失败保留墓碑重试，不因清理失败恢复可见性。

## 存储、权限与限制

默认 `WORK_STORAGE` 使用 `work.storage.PrivateMaterialStorage`，沿用部署的 S3 连接参数，独立 `work-materials` 前缀、随机对象名、私有 ACL 与禁止公共 URL 的访问方式。可用该设置的 `OPTIONS` 指定独立 bucket。生产启用前验证 bucket policy 也不允许公共读取；ACL 不能覆盖宽松的 bucket policy。开发测试可将 `WORK_STORAGE` 改为 `FileSystemStorage`，但目录必须位于 Web 不提供静态访问的位置；多 worker 必须共享该存储。

- 权限要求真实、有效、非设备账号；查询同时限制 owner 和服务端解析的当前组织。没有组织的个人资料也只属于 owner，组织改变不自动迁移旧资料。
- 每请求一份文件，上传流与实际读入均限制 10 MiB；前端每批最多 10 份、30 MiB。当前按账号限制 100 份 / 100 MiB（待清理文件仍占额度），未实现的任务级配额在 WorkTask 落地时补齐。
- 仅接受 `.txt / .md / .markdown` 的 UTF-8 文本；拒绝已知二进制签名、空文件及控制字符。解析上限 20 万字符、5 万行，不静默截断源文。
- 预览一次 100 行、每行最多展示 2000 字符，长行明确标记截断。前端以文本显示 Markdown / HTML，不运行脚本、不加载外链。
- 预览和列表不返回存储 key，响应带 `Cache-Control: no-store`。上传必须提供 UUID `Idempotency-Key`；相同键与内容复用原结果，改变内容返回 409，已删除返回 410。重试还校验 generation，避免旧请求启动新一轮。
- 解析时不调用模型、不读会议、不发送消息；输入正文不进入日志。会话认证保留 CSRF 校验，前端退出工作区时中止余下上传批次。

本批在数据库提交失败时尝试清理新对象；进程在对象落盘和数据库提交之间被硬杀仍可能留下未登记对象。生产上线前需配置该前缀的孤立对象对账 / 留存清理，并验证私有 bucket、资源限制和真实上传。没有把本地文件系统测试当成生产对象存储验收。

## 验证记录（2026-09-23）

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

前端测试为 `src/features/work/routes/WorkRoute.test.tsx`。本地浏览器证据保留在 gitignored 的 `src/desktop/test-results/work-ui-local.json` 和 `work-materials-*.png`，测试会话文件不提交。
