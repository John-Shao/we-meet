# 声纹完整备份恢复与当前来源交接走查

后续[独立日志库基础走查](voiceprint-journal-authority-review-2026-10-11.md)已实现独立 PostgreSQL 的加密签名状态、最新头原子比较追加及主库不可用导出；实际 TLS、并发、角色权限和重启验证通过。业务持续发布、主库检查点及自动恢复门禁仍待接入，下文记录的旧协议边界保持适用。

日期：2026-10-11（Asia/Shanghai）。分支：`feature/speaker-identity-voiceprint`。本记录接续[账号级清理走查](voiceprint-scope-erasure-review-2026-10-11.md)，补齐独立于旧数据库备份的当前撤销信息交接、离线校验和重放工具。

## 问题与实现

旧行恢复测试保留当前可信数据库墓碑，不能覆盖整个数据库回滚：备份之后发生的档案删除、授权撤销、来源删除或样本拒绝会随数据库一起丢失。恢复后仅扫描旧库，无法判断哪些旧数据已经失效。

新增 `voiceprint_recovery` 服务及三个管理命令。恢复端生成部署绑定的随机请求，当前来源导出经过加密和签名的元数据包，恢复端验证后在一个 PostgreSQL 事务内重放。恢复包、请求和信任配置由运维单独保存与交接，不能从同一份旧数据库备份读取。

导出使用 PostgreSQL repeatable-read、read-only 事务，包含作用域撤销 generation 下限、来源 UUID／轨道摘要、贡献失效证明、三类授权的当前值、组织声纹策略及已拒绝／过期／删除样本的最小删除证明。包保留内部账号／组织／档案 UUID，因此并非匿名数据；没有音频、特征向量、档案密钥、姓名、联系方式、参与者 SDK identity 或原始轨道标识。账号／成员关系失效但信号被 bulk 更新绕过时，导出按当前状态补充撤销下限；组织暂停策略单独处理，不冒充个人授权撤销。

包采用 AES-256-GCM，加密后由 Ed25519 签名；部署 ID 和协议域绑定到认证数据。当前来源 writer 持有签名私钥，恢复端 reader 仅持有验签公钥和解密密钥。reader 配置拒绝混入签名私钥字段。请求含 256 位随机 nonce，窗口最长一小时；校验部署、请求、时刻、签名、密文和完整字段形状后才执行 SQL。允许最多 30 秒的时钟偏差，需维持两端时钟同步。

每类元数据最多 100,000 行，明文最多 8 MiB、外层文件最多 12 MiB。超限直接拒绝，不截断后生成“成功”包。禁止重复 JSON 键、未知字段、重复作用域／样本／模板标识、布尔值冒充整数及格式错误的 UUID／摘要。文件只接受有界普通文件；Linux 拒绝叶子符号链接、公开权限和 FIFO，读取 FIFO 不等待写端。输出采用新建、0600 权限和文件／目录 fsync，不覆盖既有请求、恢复包或回执；Windows 文件权限还需由运行账户和 ACL 管理。

## 重放与失败边界

导出和重放要求总开关、采样开关、匹配开关全部关闭。重放设置五秒锁等待上限，元数据冲突、锁竞争或清理失败会回滚本次全部数据库修改。导入 UUID 作用域证明后，复用已有 generation 清理与来源贡献清理；不会读取模型、解密声音或调用 ASR。

恢复只撤销权限、保持组织暂停、提升旧授权的撤销下限，不将来源的 `true` 自动授予恢复端。目标比来源更新的授权版本／generation 保持，当前可信删除下限仍执行。已删除作用域的旧声音、模板、档案密钥及旧工作清理，其他账号／作用域和合法新 generation 保持。未使用的拒绝样本只删除该样本，不清除合法基准模板。来源贡献影响基准时清空旧向量、暂停档案，后续业务处理按幸存贡献和原授权规则重建。

走查另发现“旧授权已关闭但版本落后”会使恢复后的新授权版本仍低于来源，重复重放可能误撤销后来本人明确授予的权限。现在即使无需再次关闭权限，也推进落后的授权版本并记录失效事件、终结旧工作，单独输出 `consent_versions_advanced`。组织策略同样补齐旧版本并保持后来管理员明确启用的较新版本；这些处理都不自动授予权限或启用策略。

本次还修复已完成贡献回执忽略“只有旧向量、没有旧样本”的恢复情况：按原证明再次检查受影响模板；发现恢复向量才重新清理，重复重放无新数据时不递增模板 revision。恢复命令遍历本次导入证明，因此不依赖周期选择器能否发现这种不完整行恢复。

成功回执只输出聚合数量、包／请求哈希及 `voiceprint_enabled=false`；底层 SQL、私有路径、配置、UUID、声音和向量不进入 CLI 错误。回执文件写入在数据库提交之后；若磁盘写入失败，命令报告失败，但数据库重放可能已经完成。保持业务关闭，使用新的回执路径幂等重放并检查回执；不能因缺少回执就启用识别。

## 操作契约

签名证明来自授权 writer，不能证明 writer 指向“最新主库”。当前主库必须在恢复交接期间可用，writer 私钥仅挂载给经运维核验的当前来源；旧备份及恢复实例不能持有该私钥。reader 信任配置也必须来自独立可信配置，不能从被恢复的备份取出。

先冻结所有声纹消费者及可能改变授权、账号／组织／成员、来源和样本状态的写入者，直到恢复切换完成。单个命令进程的三个开关检查不能代替集群停写或切换门禁。导出事务确保一致快照；导出之后发生的新撤销不自动进入这个包。

命令路径相对 `src/backend`，私有目录需预先创建，下面只演示路径，不含真实密钥：

```sh
# 恢复端：reader.json 来自独立可信配置。
python manage.py request_voiceprint_recovery \
  --config /private/reader.json --output /private/request.json

# 已冻结的当前来源：收到本次 request.json，再从当前主库导出。
python manage.py export_voiceprint_recovery \
  --config /private/writer.json --request /private/request.json \
  --output /private/bundle.json

# 旧数据库备份恢复后，业务仍关闭；reader 没有签名私钥。
python manage.py restore_voiceprint_recovery \
  --config /private/reader.json --request /private/request.json \
  --bundle /private/bundle.json --receipt /private/receipt.json
```

writer 配置形状为 `{v:1,deployment_id:<UUID>,signing_key:<base64 原始32字节>,encryption_key:<base64 原始32字节>}`；reader 将 `signing_key` 换成 `verification_key`（对应的 Ed25519 原始32字节公钥），部署 ID 和 AES 密钥一致。这些是私有 JSON 配置，不是命令行参数或环境明文。生产密钥生成、轮换、分发和保存须接入已有私有配置机制，本次没有自动创建生产密钥或部署 Secret。

包过期、主库不可用、缺少可信配置／请求、来源版本不明、元数据超限或重放失败时，保持业务关闭。不能用旧备份内的墓碑代替本次交接。重放结束不会修改开关或自动启动任何消费者；检查失败任务和待重建数量后，才进入独立的恢复切换流程。

## 验证证据

31 项恢复专项与既有来源删除、账号清理、授权组合共 139 项通过（323.43 秒）；最后两项组织策略恢复／明确重新启用测试与既有组织暂停共三项定向通过（30.62 秒），合计 141 项不同测试，恢复专项共 33 项。覆盖真实加密基准模板、个人／组织旧行恢复、签名／密文／部署／请求／过期破坏在 SQL 前拒绝、非授予授权、组织暂停、bulk 账号失效、贡献证明、向量单独恢复、事务回滚、幂等、后来重新授权／新 generation、版本下限和 CLI 回执。最初两处失败来自旧行 fixture 未恢复级联删除的本人确认记录及原创建时刻，补齐完整合法证明后通过；没有降低产品授权校验。

实际 Linux 非 root 探针完成整库 `pg_dump`／`pg_restore`，当前删除／贡献墓碑确实随旧备份回退。独立包随后清理三个旧档案样本、一个旧模板及旧密钥、两个拒绝／来源失效样本，恢复撤权并暂停失去基准的档案；其他合法加密档案仍通过识别授权及密文校验。篡改签名在投影前拒绝，重复重放幂等，reader 没有签名私钥，FIFO 无阻塞拒绝。三个自建容器、internal 网络及临时凭证全部实际清理，结果 `passed`、退出码 0。

修改后的主机入口又完成原 erasure 模式实际 Beat／prefork 回归，三个旧样本／模板及密钥清理，新 generation 的两个制品保持；业务关闭、没有模型私有文件，三个自建容器／网络／凭证全部清理。最终镜像的同模式结果与恢复结果一起留存；Ruff／格式、Django 系统检查、迁移无漂移和差异空白检查均通过，没有模型迁移变更。

最终本地镜像 `we-meet-backend:voiceprint-recovery-20261011`，image ID `sha256:f134f1f5855feed6150d1508d62845b555002675fbe26a28218c9a0e08bf8f58`，没有 registry 推送。组合日志位于工作目录 `backend-voiceprint-recovery-final-2026-10-11.log`，组织策略定向为 `backend-voiceprint-recovery-policy-final-2026-10-11.log`，最终完整恢复结果为 `voiceprint-recovery-runtime-final-2026-10-11/result.json`，最终原模式回归为 `voiceprint-recovery-erasure-final-2026-10-11/result.json`。

仓库可复现完整数据库探针：

```sh
docker build --target backend-voiceprint --build-arg DOCKER_USER=10001:0 \
  -t we-meet-backend:voiceprint-recovery-verification .
python deploy/aliyun/run_voiceprint_erasure_probe.py --mode recovery \
  --backend-image we-meet-backend:voiceprint-recovery-verification \
  --diagnostics-dir <独立工作目录>
```

探针主机只使用已缓存镜像、自建 internal 网络及空 PostgreSQL／Redis。容器以 UID 10001、只读根文件系统、私有 tmpfs 运行；先建立可通过现有识别授权检查的合成加密基准并 `pg_dump`，再删除／撤权／清理来源／拒绝样本、导出独立包，最后用 `pg_restore --clean` 恢复整库。回滚后确认当前墓碑确实消失、旧档案重新通过授权，再由 reader 重放并检查合法其他档案保持。没有真人声音或模型请求，密钥和恢复包仅在隔离 tmpfs，主机诊断只保留聚合结果。退出清理只针对本轮随机标签资源，临时凭证目录限定在指定工作目录内。

## 尚未完成

该协议覆盖“当前可信主库可用且全部相关写入被冻结”的离线交接。持续发布外部撤销日志／快照、外部最新头指针、主库完全丢失时的恢复、自动检测数据库回退并阻止集群重新启用、生产完整切换、备份介质保留／擦除及容量验收尚未实现或实地验证。手动运行命令不等于已经接通生产自动恢复门禁。

真实设备、完整 Application、生产 CNI／TLS／容量及获授权真人的准确率和门限校准继续验收。Qwen 优先，不满足要求后才考虑 CAM++；本次没有模型选型变更、付费 ASR、registry 推送、Helm 安装或生产部署，完整开发目标仍继续。
