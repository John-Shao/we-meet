# Work 办公模块

当前实现私人材料上传与沟通准备：上传 → 解析预览 → 选择版本和沟通目标 → 后台生成 → 引用核对 → 编辑、采纳和 Markdown 下载。支持 TXT / Markdown、文本型 PDF 和受限 DOCX。**2026-09-24 生产仍为 backend `30cab9491` / Helm revision 419 的 `communication-v3`。v4 候选 20/20 契约通过，语义审阅 17 条通过 / 3 条需修正，不发布；v5 候选待真实评测。此前业务用量和材料清理回执通过；P0-1 尚未整体放行。** 周报和表格分析仍为后续批次。产品范围统一维护在 [Work 计划](../../../docs/plan/work-module-product-architecture-agent-plan-2026-09-21.md)。

## 启用与运行

默认关闭 `WORK_ENABLED`、`WORK_MATERIALS_ENABLED`。部署时先执行 `python manage.py migrate`，确认私有存储和独立 worker 可用，再将两个环境变量设为 `true`；前端配置接口据此显示“工作”导航。共用 Web / 桌面路由为 `/work`（兼容 `/work/new`），本批的选中文件和列表页码保存在查询参数中。

京东云现有 Helm 部署：用户提供的发布日志确认 `e82d71f91`、Helm revision 400 的前后端 / Celery / Beat 已更新。随后检查线上 `config/` 仍为 `work.enabled=false`；原 Chart 只有 `meet-backend` 队列，没有 Work 专用消费者。因此代码部署完成不等于 Work 已启用。

已补充 `workWorker`（默认关闭）与服务器上的启用入口。在 `~/we-meet` 执行：

```sh
git pull --ff-only
bash deploy/aliyun/enable-work.sh materials
```

脚本先检查当前后端的 Work 迁移，再上传一份随机合成文件，验证认证读写、匿名读取返回 403，并删除该测试对象；任何检查或清理失败都会停止，不开启材料功能。随后生成服务器本地 `src/helm/env.d/aliyun-prod/values.work.yaml`，用**当前正在运行的后端镜像 tag** 发布 Work 配置，等待 `meet-celery-work` Ready，并验证真实队列消费者与开关。无需为这次 Chart / 脚本改动重新构建前后端镜像；当前镜像必须已包含 Work（如 `e82d71f91`）。发布仍经过现有 Helm 迁移 hook，其他模块镜像沿用发布脚本的版本保护。

- `bash deploy/aliyun/enable-work.sh check`：只读检查迁移、开关、模型配置是否完整、Work 队列消费者，不上传、不生成、不打印密钥。
- `bash deploy/aliyun/enable-work.sh cleanup <cleanup_key>`：重试删除上次失败输出中的单个合成探针，并验证对象不存在。只接受 `_deployment-probes/<随机标识>.txt`，不接受材料路径或目录；不会新建探针、修改开关或发布。
- `bash deploy/aliyun/enable-work.sh materials`：启用 Work 和材料，**沟通生成保持关闭**。仅检查随机探针对象的私有读写，不修改 bucket policy / ACL 配置；若出现 `anonymous_read_allowed` 或存储不可用，先为 Work 配置合适的私有存储再重试。
- `bash deploy/aliyun/enable-work.sh off`：关闭 Work 写入和生成，保留独立 Worker 进行已请求删除的清理，并保留历史数据；不反向执行数据库迁移。
- 脚本依赖服务器已有的 `kubectl / helm / python3 / python3-yaml`。发布或最终检查失败时以非零状态退出，不宣称已启用；本地 overlay 保留，可修复后重试或执行 `off`，不自动回滚其他团队同时发布的变更。

`release-meet.sh` 后续自动加载这份 gitignored overlay，避免常规发布丢失 Work 开关；模板为 `src/helm/env.d/aliyun-prod/values.work.yaml.dist`。生产 Worker 使用独立 `work` 队列、prefork / 并发 1、1 CPU / 1 GiB 上限、只读根文件系统与 256 MiB 临时盘，继承 backend 的 Work / DB / Redis / S3 配置，使用 Celery ping 就绪探针。它需要现有 Beat 开启；没有把办公任务加进会议 Worker 的队列列表。

材料上线后，在 overlay 的 `backend.envVars` 配置下表的独立 Work 模型，API key 使用已有 Kubernetes Secret 的 `secretKeyRef`。在受控验收时启用 `WORK_COMMUNICATION_ENABLED`，验证真实模型引用、实际用量与业务闭环后再开放使用；重新执行 `materials` 模式会将它重置为 `False`。

### 沟通准备启用（2026-09-24）

当天服务器只读回执确认：Work / 材料已开启、消费者 1、迁移通过，沟通关闭且 `model_configured=false`。以下流程复用正在运行的 backend 镜像，新增脚本通过 stdin 在现有容器内执行，**这次无需构建应用镜像**：

```sh
git pull --ff-only
bash deploy/aliyun/enable-work.sh prepare-communication && \
  bash deploy/aliyun/enable-work.sh communication
```

1. `prepare-communication`：要求材料与消费者已就绪；在服务器本地 overlay 三个模型字段均未设置时，绑定 `.dist` 中的 `qwen3.8-flash`、兼容地址和 `meet-ai-credentials/DASHSCOPE_API_KEY`。已有完整自定义配置保留；只有部分字段或使用明文 key 时拒绝，不混用供应商配置。发布后验证模型配置完整，沟通仍关闭。该步骤不调用模型。
2. `communication`：要求 backend / Work Worker 的滚动更新已结束，且实际模型配置与本地 overlay 一致；先检查迁移、材料、消费者和私有存储，再在 **Work Worker 容器**内运行一次合成沟通调用。使用已部署的 `CommunicationExecutor`、提示词及引用校验，单次超时 45 秒、SDK 不重试、输出上限 1200 token。只有结构、非空来源、必要段落、精确引文和供应商用量均通过，才开启沟通、发布并验证 `generation_available=true`。预检失败不修改 overlay、不发布；供应商失败原因只输出白名单类型，不打印原始异常、源文或密钥。
3. 接着使用 demo 账号做下方业务验收。**模型预检成功只说明合成调用可用，不等于 P0-1 或真实业务验收完成。** 当前生成开关作用于所有有权使用 Work 的账号，尚无组织白名单；不能将它描述成已实现单组织灰度。

只检查模型、保持现有开关，可执行 `bash deploy/aliyun/enable-work.sh probe-model`。它和 `communication` 都会实际发起一次可能计费的模型请求，不必连着执行两者。预检只发送内置合成文本，不读取用户材料、不创建 WorkTask，也不写用户用量账本；输出的 `input_tokens / output_tokens / elapsed_ms` 属于部署探针记录，需保存服务器回执。业务调用的 WorkRun / AIUsageRecord 用量仍需单独验收。

日常发布会沿用本地 overlay，**无需重复 prepare 或 materials**。修改模型配置后先运行 `prepare-communication`，再验收开启，避免用旧配置的探针结果给新配置放行。关闭生成但保留材料使用 `materials`；关闭全部新 Work 写入使用 `off`。若发布或发布后检查失败，当前配置可能已部分生效，应先 `check` 再修复或回退，不将脚本非零退出视为集群已自动回滚。

宿主机配置与预检工具的离线验证覆盖 23 项存储 / Chart / 启用脚本测试、12 项模型预检 / 配置一致性测试和 6 项既有发布回归，另通过 Ruff、Bash 语法及差异检查（模拟供应商，不是实际 Qwen 调用）；后续生产回执记录在下方：

```sh
PYTHONPATH=src/backend src/backend/.venv/bin/python deploy/aliyun/test_work_rollout.py
src/backend/.venv/bin/python deploy/aliyun/test_work_model.py
bash -n deploy/aliyun/enable-work.sh
```

Windows 将 Python 路径换为 `src/backend/.venv/Scripts/python.exe`，并设置 `PYTHONPATH` 指向 `src/backend`。下一步验收项统一记录在计划第 14.6 节，保持周报 / 表格批次未开始。

### 账本 / 清理核对与固定语义评测（2026-09-24）

**当前下一步评测 v5 候选，无需先构建或发布。** v4 本轮已纠正 S20 引文问题，但 S01 新增“本周五”、S11 预设阻碍、S16 推断“次日重置”，因此不发布 v4。v5 针对三类无依据推断收紧所有字段的规则，生产仍为 v3。完整记录见主计划第 15.1–15.3 节。在发布服务器执行：

```sh
git pull --ff-only &&
bash deploy/aliyun/accept-work.sh evaluate-candidate
```

该命令最多执行 20 次付费调用，保持原样本与预期，无自动重试。v5 系统哈希 `dc3ee67e083d977c09574f2a42fd17d284857ea070e86b8ced13795e3a3cfd5c`；与已部署 v3 的适配器源码指纹一致，23 项离线工具回归及 Ruff 通过，真实效果待本轮结果。不要先发布，也不要用本地 v5 直接执行 `evaluate`（它会因生产仍为 v3 而零调用拒绝）。

v4 完整回执为 `20260924T082616Z-evaluate-candidate-QAmt8O`：版本、提示词 / 集合 / 单例哈希和汇总均核对一致，23666 / 5555 输入 / 输出 token，中位耗时 4.984 秒，最大 8.041 秒。采集完成与契约通过不代表语义通过；本次 17/20 的语义审阅是助手按既有标准的判断，非用户业务签收，不与下一版输出拼接放行。

诊断工具在引用失败时保留结构与大小约束均合规的合成 `rejected_output`、`output_status=rejected` 及逐事实 `citation_diagnostics`，区分错误来源、越界行号、空引文和非原文片段；不输出正常 `output`，契约仍失败。无效 JSON / 超限 / 其他结构错误和供应商异常不回显。`20260924T081657Z-evaluate-7uUtBB` 的独立 S20 调用为 952 / 550 token、10.447 秒，第一条引文自行插入 `...`，其余已知要素未发现含义偏差，仍按引用失败拒绝。新结果不恢复或覆盖原完整轮次 S20，也不与旧结果拼接宣布全套通过。

后续尚未部署的提示词使用 `evaluate-candidate`。候选模式把仓库中的 `SYSTEM / EXECUTOR_VERSION` 字面量通过 Base64 JSON 送入单独的 `kubectl exec` 评测进程，仅在该进程内临时替换系统提示词，结束时恢复；不修改 Pod 文件、Celery Worker、功能开关或用户任务。它比较已部署执行器与本地执行器的源码指纹：统一换行，用 AST 定位并移除系统提示词和版本赋值后，对剩余 UTF-8 源码计算哈希，不使用依赖 Python 版本的 `ast.dump`。其他源码必须一致（包括格式和注释，保守拒绝），不同则 `candidate_adapter_mismatch / model_calls=0` 拒绝，不能用该模式跨越实际执行器 / Schema 代码变更。所有样本仍走现有 `CommunicationExecutor`、SDK、校验器及实际模型，最多 20 次付费调用，无自动重试。`evaluation_mode=candidate`、候选和已部署版本 / 系统哈希分别记录；不得把候选通过写成生产已升级。

后续提示词迭代先收集并审阅相同 S01–S20 的候选结果，完整通过后才执行下述构建发布步骤。`evaluate` 表示测试**已部署版本**，会检查它是否与本地提示词匹配；本地与生产提示词不同时以 `deployed_prompt_mismatch` 零调用退出。候选也支持 `--case S01`，但放行须同一候选版本的完整集合，不能挑选跨版本结果。

候选评测通过后的生产升级按以下步骤进行。评测脚本本身通过 stdin 在**已部署容器**中运行，不改变功能开关；要让正式业务使用新提示词与执行版本，**必须先构建并推送 backend 镜像，再部署 backend（包含 Work Worker），最后复验**。`release-meet.sh` 只发布已存在的镜像，不负责构建。不要运行 `enable-work.sh materials`，它会关闭沟通生成。构建环境需具备 Docker 和镜像仓库凭据，推荐沿用已有构建机；发布在已有 kubectl / Helm 的生产服务器执行。若同一台机器具备两种环境，可按以下完整顺序运行：

```sh
git pull --ff-only &&
WORK_RELEASE_SHA=$(git rev-parse HEAD) &&
WORK_RELEASE_TAG="${WORK_RELEASE_SHA:0:9}" &&
IMAGE_TAG="$WORK_RELEASE_TAG" bash deploy/aliyun/build-and-push.sh backend &&
bash deploy/aliyun/release-meet.sh --skip-git-pull --tag "$WORK_RELEASE_TAG" backend &&
bash deploy/aliyun/accept-work.sh evaluate
```

构建与发布分机时，构建机记录完整 `WORK_RELEASE_SHA` 和输出的镜像 tag；发布机使用同一源码版本和该 tag 执行 `release-meet.sh --skip-git-pull --tag <已推送的tag> backend`，再评测。不要在构建后让发布命令自动拉取新的 HEAD 并推导另一个尚不存在的镜像 tag。若出现 `image not found`，说明在 Helm 更新前停止；先补构建推送，不跳过镜像检查，也不以旧镜像代替 v2 验证。

- `audit`：使用 PostgreSQL 只读、可重复读事务，限定 9 月 24 日已授权的 3 次 Web / 2 次桌面生成及 6 份合成材料。逐笔检查成功状态、调用时间、来源、预期 token、唯一 `AIUsageRecord`、关联指针及 owner / organization / model 一致性；检查删除时间、清理完成时间、存储键与解析内容清空。缺记录、重复账本、归属或 token 不匹配、软删除未完成清理都返回非零。输出仅含样本 ID 和检查布尔值，不输出账号、材料正文、存储键或凭证。`purge_evidence=worker_database_acknowledgement` 是清理 worker 的数据库回执；不是独立的 OSS 对象不存在证明，也不代表供应商金额账单已对平。
- `evaluate`：顺序执行 S01–S20 共 20 条**新增合成语义样本**，扩充 C01 / C05–C09，不替代产品计划中的 C01–C20 业务验收清单。使用已部署的 `CommunicationExecutor`、提示词与引用校验，每次输出最多 1600 token、SDK 超时 45 秒、无自动重试；首个契约 / 供应商错误后停止。会产生模型费用，只发送内置合成材料，不创建业务任务或写入用户用量账本。保存样本、预期标准、实际结构化输出、token、耗时及人工评审占位；不将精确引用或 JSON 正确当作语义通过。
- `catalog`：仅列出固定样本和评审标准，不访问模型或集群；可先查看。`catalog / evaluate --case S01 --case S03` 可限定样本，重复 ID 不会重复调用。中断后按已留存回执选择未完成项，不自动重跑整个付费集合；是否重跑结果未知的那一项需明确判断。

每次服务器执行在 gitignored `.work-acceptance/<UTC>-<mode>-<随机后缀>/` 下保存 `environment.txt` 与逐行刷新的 `results.jsonl`；目录权限仅当前用户可读写，保留脚本提交 / 脏文件标记 / SHA-256、部署镜像，以及评测的模型 / 系统提示词 / 样本哈希。失败或中断保留已有输出，单次目录互不覆盖。把两份结果文件与对应环境记录返回后再核定验收结论。

`evaluate` 会从宿主机 `src/backend/work/executor.py` 的字面量计算期望提示词哈希，容器实际哈希不匹配时返回 `deployed_prompt_mismatch / model_calls=0`，避免遗漏部署后仍付费测试旧规则。启动记录包含实际 `executor_version`。已部署 v2 系统提示词 SHA-256 为 `043b4e0659950184de037d3b8242c9e59a63c49d6ae27c8ad0cc37942b503d5c`；v3 候选为 `21672877c8c89f5aabd6aa63ace9313aaab565554531da81f0f76c7efb6327b7`。发布完成、backend / Work Worker 滚动更新就绪后再新建业务或做评测；不把滚动更新中的混合版本当验收环境。

已收到第一轮服务器回执：`20260924T034742Z-audit-nc9GaS` 核验全部通过；无需为同一批已完成业务重复运行 `audit`。`20260924T034804Z-evaluate-fdo3Ai` 返回 S01–S19 后 `^C`，无 S20 或 summary，19 条合计 5847 / 6740 输入 / 输出 token，耗时中位数 6.825 秒、最大 8.690 秒。S20 可能已发起调用但结果未知，不计入上述用量，也不自动补跑。样本 / 单例哈希均与固定集合吻合，系统哈希 `b56d26e5…c53bcf91` 与旧提示词一致；本次附件没有 `environment.txt`，不推定实际部署镜像版本。账本与清理通过不抵消语义问题。

随后收到第二轮完整旧版结果 `20260924T035106Z-evaluate-jl0uWm`：20 条契约通过、6166 / 7123 token，中位数 6.819 秒、最大 13.613 秒，系统提示词与上一轮相同。集合、全部单例哈希和汇总用量核对一致。它是额外的完整一轮，不与上一轮拼接；S20 的新输出不能证明上轮中断调用的结果。第二轮逐条审阅为 6 条通过、14 条需修正；即使核心事实或防注入专项通过，只要出现无依据状态、无关制度 / 流程或不满足目标的建议，整体也不算该条语义通过。S13 再次编造不支持视频的质量 / 稳定性原因，S17 再次用当前日期换算旧记录，S20 添加了未要求的改期规则。详见主计划 v1.18 的两轮分开记录。

这些是助手对合成结果的审阅，不代表用户业务签收。新版规则明确原记录日期基准、全字段不虚构承诺、问题不预设未知状态、围绕用户目标、允许空数组及每组建议最多 3 项。未修改固定样本或降低预期。新建 Run 显式记录 `communication-v2`；旧版排队项不能直接用新版提示词与旧预占执行，新 worker 在调用前以 `generation_unavailable` 结束该项，由用户显式重新生成创建新版 Run，旧记录保留。已生成的历史草稿不被改写。

v2 最新真实回执：镜像 `2f2d1a443` 已构建推送（digest `sha256:c7cdac68a10821b4375655d6f1fa59f88ff1a58dbed7b4c142cf44a55e7b7850`），revision 418 的 backend / Work Worker / Beat 已滚动更新成功。`20260924T054840Z-evaluate-qJQZWF` 的 20 条结构及哈希核对通过，13586 / 5581 输入 / 输出 token，中位耗时 5.190 秒、最大 7.476 秒。S13、S16、S17、S20 已纠正；逐条语义审阅仍有 S01 / S02 / S10 / S11 / S15 五条问题，详见主计划 v1.19。

v3 补充按“核对 / 说明 / 讨论”收敛输出、中性询问进度、背景或身份缺失不自动构成信息缺口；复验保持同一集合和模型。此前 Work 后端 55 项通过。初次本地数据库尚在恢复时测试连接失败，就绪后复验通过，不视为代码失败或生产故障。

revision 419 后的 `20260924T062332Z-evaluate-candidate-suVHZQ` 返回 `candidate_adapter_mismatch / model_calls=0`。本地复现相同源码在 Python 3.10.12 与镜像 Python 3.13.5 下的旧 AST 哈希不同；已改为上述源码指纹，两个环境与本地 `30cab9491` 镜像源码均得到 `9a8f787b8874cf293a9c7391bf7a4b7f47e07a08f6539d1e448b080240b6b962`。未读取生产宿主机 Python 版本，跨版本误报为本地复现结论。修复仅涉及宿主机传入的评测工具，21 项工具回归和 Ruff 通过，包含多行中文、CRLF、相邻代码保留及真实代码变化拒绝；无需重建镜像。v3 已部署，下一步用 `evaluate` 收集完整语义结果，通过后复查新业务版本、用量和成果路径，最后决定周报开工。

语义人工评审维度：逐事实引用蕴含（含否定、条件、主体、单位）、不确定性保留、建议范围、指令边界、具体可用性。每条还须满足脚本中 `expected` 的专项要求；20 条全部评审通过，才完成该固定语义集。S01 / S02 / S18 / S19 / S20 重点检查稀疏或不匹配材料下是否无依据扩展流程或制造缺口；冲突、未批准预算、用户猜测、注入等由其余样本覆盖。`collection_ok=true` 只代表采集和契约通过；`semantic_passed=null / review_status=pending / release_gate_passed=false` 明确保留人工判断。出现失败时先定位并修改提示词或实现，部署后用同一固定集复验，不靠修改预期或挑选输出放行。

工具验证：15 项离线测试覆盖账本缺失 / 重复 / 错配、软删除不等于清理、错误脱敏、20 条样本经过真实提示构造与结构校验、无依据但精确引文仍待人工评审、停止 / 去重及 Bash 证据保留；6 项独立 PostgreSQL 测试验证实际 ORM 核对、错误回执拒绝及数据库阻止意外写入。**本地工具测试不替代服务器回执或真实模型的 20 条评审结果**。复验命令：

```sh
python -m unittest discover -s deploy/aliyun -p test_work_acceptance.py -v
# 使用隔离 PostgreSQL 与项目 Test 配置，PYTHONPATH 包含 src/backend：
python -m pytest deploy/aliyun/test_work_acceptance_db.py --reuse-db
```

### 材料部署历史与模型依据

2026-09-24 桌面补验：从固定提交 `6507434dc` 构建并安装 `0.2.0-d0.9`，真实 PKCE 登录、上传 / 生成、Markdown 下载、刷新和重启恢复同任务、退出登录通过，模型 `qwen3.8-flash`，344 / 455 输入 / 输出 token，约 15.2 秒。修复了初始加载被新导航取消时误报安装损坏的问题。此前 `d0.8` 生成的验收材料和本次材料均已删除，成果均拒读；账本保留。固定 worktree + 隔离 PostgreSQL 复验 54 项 Work 后端测试通过，覆盖 C09、C13–C15 的既有故障 / 边界场景；这些仍是隔离模型测试。安装包哈希、截图、原生交互边界和命令统一见 [桌面 README](../../desktop/README.md)。以下 Web 历史段落中的“桌面未验收”由本记录更新，不代表已满足 D0 全部发布门槛。

2026-09-24 沟通准备生产回执（覆盖前述“新增工具尚待运行”状态）：服务器拉取脚本 `7a619f2ca`，复用 backend 镜像 `23b302061`；revision 412 配置模型但保持生成关闭，revision 413 开启沟通，最终 `model_configured=true / communication_enabled=true / generation_available=true / work_consumers=1`。私有存储探针及清理通过；Work Worker 的真实模型探针返回 2 条引用、315 输入 / 430 输出 token、8397 ms。该笔为部署探针用量，与下述业务运行分别记录。

随后使用 Playwright 专用窗口、现有生产服务和两个授权 demo 账号完成三组真实业务调用，未 mock 网络或模型：

| 合成样本 | 实际输入 / 输出 token | 提交至成功耗时 | 引用检查 |
|---|---|---|---|
| 中文 MD + TXT 日期冲突、未定预算及材料注入 | 529 / 858 | 17.0 秒 | 6 条；保留双方冲突，未确认背景未冒充事实，注入未被采纳 |
| 文本型 PDF 发布评审材料 | 323 / 315 | 8.8 秒 | 1 条；第 1 页原文对应 |
| DOCX 段落与预算表格 | 337 / 420 | 12.9 秒 | 2 条；段落和表 / 行 / 列对应 |

三次同键重复提交均返回同一个任务且保持单个 Run；成功后刷新恢复同稿，事件游标无重复。中文样本人工编辑为 v2、旧版本保留、过期 base_version 返回 409、采纳成功，认证 Markdown 下载与 v2 正文一致；未保存时下载禁用。1440 / 1024 / 390 px 无横向溢出，页面错误 0；已查看桌面宽度与窄屏截图。第二账号访问三个任务、成果和下载共 9 个接口全部 404。界面删除来源后草稿不再渲染；四份合成材料全部删除，详情 404，三个关联成果均返回 409 拒读。任务 / 运行历史保留，未删除审计账本。

本地证据：gitignored `src/desktop/test-results/work-communication-production.json`、`work-production-communication-{1440,1024,390}.png` 和 `work-production-communication-v2.md`。只有合成数据，没有登录 Cookie / Token。首次登录回跳等待超时，第二次登录及跨账号登录成功，未改动登录服务。实际 Run 已返回非零用量；AIUsageRecord 一致性与后台清理状态已请求服务器只读核对，当前不将应用层拒读等同于物理清理回执。三组样本通过不等于 20 条固定沟通评测全部完成，更不代表桌面安装包验收；稀疏 PDF 的建议仍出现“评审委员会 / 投票规则”等材料未涉及的扩展问题，需继续校准克制程度及人工核对。

2026-09-23 首次线上启用检查：Work 迁移已通过，但存储探针和清理均失败，开关仍关闭、没有进入 Helm 发布。旧诊断只返回 `storage_probe_failed`，不足以确定根因。现已增加失败阶段、白名单异常类型 / S3 错误码 / HTTP 状态、独立清理结果，以及存储配置完整性和客户端配置差异（不输出凭证、地址或原始异常）。另修复已确认的源码问题：Work 的超时配置曾覆盖部署级 OSS 签名、寻址和 checksum 兼容配置，现在合并保留部署配置。该修复需重新构建并发布 **backend** 镜像；宿主机诊断脚本可在旧镜像上直接运行。更新镜像后先清理原探针，再重试 `materials`；真实存储结果仍以服务器输出为准。

2026-09-23 生产回执更新：backend `c6d61ad7e` 已发布，Helm revision 401；旧探针清理成功，私有读写、匿名访问拒绝及新探针清理均通过。随后 revision 402 启用材料，`work_consumers=1`，Work / 材料开关为 true、沟通生成为 false，客户端配置差异为空。前端仍为 `e82d71f91`。这些结果覆盖了前述“尚未启用”的历史状态。

生产 Web 验收使用授权 demo 账号与合成材料：TXT / Markdown / PDF / DOCX 均返回 201 并由真实 Worker 解析至 `ready`；PDF 返回页码，DOCX 返回段落和表格单元格位置。刷新保留选中材料，1440 / 1024 / 390 px 无横向溢出，材料中的脚本文本未执行；未登录访问返回 401。四份合成材料删除均返回 204，随后详情和预览均返回 404。这验证了应用层删除与拒读；业务文件的后台 OSS 清理未通过服务器查询单独复核，不能与部署探针清理混为一项。

追加第五份合成材料验证两个 demo 账号隔离：其他账号的详情 / 预览均为 404；所有者在界面确认删除后，旧链接提示不可访问，详情 / 预览也均为 404。五份验收材料均已删除。第二账号首次登录受测试脚本未等待验证码发送完成影响，等待“验证码已发送”后成功；未修改线上登录逻辑。证据位于本地 gitignored `src/desktop/test-results/work-production-materials-{1440,1024,390}.png`、`work-production-acceptance.json`（含第一次登录等待失败与四份清理记录）、`work-production-isolation.json`（最终隔离 / 界面删除通过记录），不保存登录 Cookie 或 Token。这是生产 Web 验收，不代表 Electron 安装包验收。

模型复用结论（2026-09-23）：仓库已有 `qwen3.8-flash` 接入，`values.meet.yaml` 的 backend `MEETING_SUMMARY_MODEL` 与 summary `LLM_MODEL` 均使用它，兼容地址为 `https://dashscope.aliyuncs.com/compatible-mode/v1`，凭证引用 `meet-ai-credentials` 的 `DASHSCOPE_API_KEY`。会议总结 / 问答共用 `LLMClient.from_settings()`，且已有[真实短 / 长总结通过记录](../../../docs/plan/meeting-ai-phase0-2026-09-12.md)。因此撤回将 Qwen3.7-Plus 作为首选的建议，Work 直接以现有 Flash 做业务验收，无需新申请 API Key。

`values.work.yaml.dist` 已给出对应的 `WORK_MODEL / WORK_MODEL_BASE_URL / WORK_MODEL_API_KEY` 显式绑定，沟通生成默认仍关闭。复用同一模型服务和 Secret，不让 Work 自动跟随会议配置变更；队列、任务、每日用量上限及开关仍独立。**示例文件更新不会修改服务器已有的 `values.work.yaml`**，最新生产回执中的 Work `model_configured=false` 仍需通过本地 overlay 绑定解决。现有 `LLMClient` 对 `qwen3*` 显式设置 `enable_thinking=false`，首轮继续采用 JSON Object + 本地结构 / 原文引用校验。会议模型接入通过不等于办公提示词、引用语义、耗时和 usage 已验收。

Flash 北京地域公开原价为输入 0.8 元、输出 2.7 元 / 百万 Token；一次 1 万输入 + 2000 输出约 0.0134 元，仅为示例估算，不是业务实测费用。[模型与价格](https://help.aliyun.com/zh/model-studio/qwen3-8-flash) · [结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)。

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

- 部署补充：新增 12 项 Helm / 私有存储探针 / 启用脚本测试，现有 6 项发布脚本测试通过；另通过 Helm lint 和 Bash 语法检查。采用模拟 kubectl / 存储验证失败阻止启用、复用线上镜像和配置持久化，尚未在生产执行启用脚本。当前工作机只有本地 kind 上下文，生产 SSH 连接信息待提供，或由用户在现有发布主机执行上述命令。

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
