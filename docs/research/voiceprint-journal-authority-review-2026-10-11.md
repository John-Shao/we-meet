# 声纹独立日志库基础与主库故障导出走查

日期：2026-10-11（Asia/Shanghai）。分支：`feature/speaker-identity-voiceprint`。接续[完整备份恢复与当前来源交接](voiceprint-backup-recovery-review-2026-10-11.md)。本阶段实现独立日志库的存储协议、权限安装脚本和离线导出命令，验证主库完全不可用时仍可取得已发布的撤销元数据。业务事务尚未自动发布这些元数据，主库检查点及自动恢复门禁仍待接入；本报告不作为启用识别的生产验收结论。

## 选型依据

现有对象存储不能直接承担“比较旧头后原子更新最新头”的职责。阿里云官方说明 OSS `PutObject` 不支持 `If-Match`／`If-None-Match` 等条件请求，会返回 `NotImplemented`；不能因客户端 SDK 暴露这些参数而假设服务端支持。[OSS 条件请求说明](https://www.alibabacloud.com/help/en/oss/user-guide/0017-00000245)。

本阶段使用独立 PostgreSQL 16 数据库：在同一事务中锁住当前头、比较调用者期望的 sequence／digest、追加记录，再推进最新头。行锁等待与释放遵循 PostgreSQL 的事务规则。[PostgreSQL 行锁说明](https://www.postgresql.org/docs/16/explicit-locking.html)。该库必须独立于业务主库及其备份恢复流程；恢复业务数据库时不能同时回滚此库。实际生产拓扑、可用性和备份策略仍需验收，隔离容器验证不代表已经部署。

连接固定采用 `sslmode=verify-full`，验证 CA 和服务端主机名，配置不能降级到仅加密或明文连接。[PostgreSQL TLS 校验说明](https://www.postgresql.org/docs/16/libpq-ssl.html)。模型选型继续保持 Qwen 优先，本阶段不涉及模型替换。

## 实现与不变量

- `core/services/voiceprint_journal.py`：严格配置、元数据合并、AES-256-GCM 加密、Ed25519 签名、当前头读取、带预期版本的追加及恢复包验证。复用已有恢复协议的字段、文件和容量校验。
- `deploy/aliyun/voiceprint_journal_schema.sql`：运维在独立空库安装；一个数据库只允许一个 deployment。应用不能创建库、角色、schema 或缺失的初始头，也不会自动重建丢失的日志。
- `export_voiceprint_journal_recovery`：从独立库导出，不执行主库系统检查或查询。外层签名绑定当前头与已有请求绑定的恢复包。
- 两个 disposable PostgreSQL／backend 探针：真实 TLS、角色权限、竞争写入、数据库重启和主库不可用导出；只使用随机合成元数据，不采集声音或请求模型。

每次成功发布保存完整的有界当前元数据状态，并保留之前的加密记录。generation／version 下限只能提高；来源和贡献失效证明不能被覆盖或删除；授权和组织策略的版本不得回退，同一版本不得改变内容。当前授权的正值可以被记录，但不能抹除历史撤销证明，恢复协议也不会自动授予权限。

每类最多 100,000 行，明文最多 8 MiB，封装最多 12 MiB。超过上限拒绝，不能截断后报告成功。全状态复制意味着每次写入的加密、网络和磁盘成本随当前状态增长，历史记录持续占用空间；需要生产规模的容量、延迟、保留和压缩方案，目前未依据小规模 fixture 推断吞吐量。

追加函数使用 `SECURITY DEFINER`、固定 `pg_catalog` 搜索路径和完整 schema 限定表名。读账号只有读取函数权限；写账号额外拥有追加函数权限；均无直接表读取、修改或删除权限。安装脚本拒绝具有超级用户、建库、建角色、复制、绕过 RLS 权限或角色成员关系的应用账号。预期 sequence／digest 为 NULL、旧版本或错误版本不能绕过比较。追加记录和推进头要么一起提交，要么一起失败；客户端不会刷新过时的预期版本后自动覆盖竞争者结果。

当前头由独立库经认证连接提供；签名用于验证记录内容，不能单凭旧记录的有效签名证明它仍是最新状态。历史状态不按一小时过期，新恢复请求仍受原协议的一小时窗口约束。导出再次读取头并拒绝已发生的竞争更新；后续恢复消费端还必须核对在线最新头，不能把这一检查替换成信任离线旧包。

## 配置和使用边界

配置是私有 JSON 文件。writer 字段为 `v:1`、`deployment_id`、`signing_key`、`encryption_key`、`database`；reader 用 `verification_key` 替代 `signing_key`。密钥是 base64 编码的原始 32 字节值。`database` 严格包含 `host`、`port`、`name`、`user`、`password`、`ca_file`；账号必须分别是 `voiceprint_journal_writer`／`voiceprint_journal_reader`，CA 必须是有界普通文件的绝对路径。配置不接受 URI、任意连接选项、TLS 降级或管理员账号。Linux 配置使用 0600 权限，Windows 另由运行账号和 ACL 保护。密钥和密码不能进入 Git、命令行或诊断日志。

运维先建立独立空数据库及不拥有数据库／业务对象的两个受限 LOGIN 账号，使用单独的 owner 安装 SQL，再为唯一部署初始化 sequence 0／全零 digest 的头。安装脚本故意不是重复执行的“修复／重置”脚本。基线必须从当前可信且已冻结相关写入的状态建立；业务发布尚未接入，不能宣称运行导出命令就已经涵盖后续所有撤销。

关闭总开关、采样开关和匹配开关之后，用已有 `prepare_voiceprint_recovery` 生成请求，再在持有私钥的离线来源运行：

```sh
python manage.py export_voiceprint_journal_recovery \
  --config /private/journal-writer.json \
  --request /private/request.json --output /private/journal-bundle.json
```

导出文件新建、不覆盖，并执行文件／目录 fsync。失败只输出固定错误，不带凭证、配置路径、SQL 或包内容。新文件外层含 `head`、`bundle`、`signature`；已有 `restore_voiceprint_recovery` 只识别旧的内层包，因此目前不能直接导入新外层文件。后续需要接入 `verify_export`、在线头复核、撤销重放和主库检查点的原子提交；不应手工剥离外层绕过头绑定来重新启用生产识别。

## 验证证据

协议单元测试 28 项通过、1 项 Windows 符号链接权限相关用例跳过（0.40 秒）。覆盖加密和签名篡改、部署／协议域隔离、不可变证明、版本回退、权限分离、过时写入、TLS 参数、固定错误、配置预算和长期状态／短期请求。测试禁止建立主库连接。Linux 探针另实际覆盖 FIFO CA 文件拒绝。

非 root Linux 后端镜像 `we-meet-backend:voiceprint-journal-20261011`，镜像 ID：`sha256:7c8d77c5bd19d4a5cb70b24bbb3b539d93a171656280339bb3e864f03c6c7bef`。最终实际 PostgreSQL 探针通过（9.23 秒）：

| 验证                 | 实际结果                                                       |
| -------------------- | -------------------------------------------------------------- |
| 错误角色安装         | reader 暂设超级用户后安装拒绝；事务回滚，schema 未创建         |
| TLS                  | 正确 CA／主机名连接成功；同一服务的错误主机名拒绝              |
| 并发发布             | 同一旧头的两个竞争写入：1 次提交、1 次冲突；最终 sequence 2    |
| 表与函数权限         | 6 次越权操作全部拒绝，包括 reader 追加及 writer 直接更新／删除 |
| NULL／旧版本前置条件 | 拒绝，最新头不改变                                             |
| 持久性               | 使用独立 named volume，重启 PostgreSQL 后头和状态保持          |
| 主库完全不可用       | 不存在主库服务，仍由真实管理命令成功导出；恢复包绑定最新头     |
| 密钥分离             | reader 仅有验签公钥，无签名私钥                                |
| 清理                 | 本轮 2 个容器、internal 网络、named volume 和临时凭证均移除    |
| 音频／模型           | 真人音频 0、模型请求 0                                         |

主机诊断位于 Git 外 `D:/workspace/jusi-meet/work/backend-voiceprint-journal-final-2026-10-11.log` 和 `D:/workspace/jusi-meet/work/voiceprint-journal-runtime-final-2026-10-11/result.json`，仅包含聚合结果。没有生产部署或镜像仓库上传。

## 后续必须完成

下一步为业务主库建立部署／sequence／digest 检查点，并把本人授权、组织策略、账号／成员失效、来源删除、样本拒绝及 bulk 路径绑定到独立日志提交。撤销应在主库提交之前持久发布；主库提交失败导致外部头领先时，后续声纹操作必须关闭，等待恢复。不能以异步队列最终成功替代撤销的持久提交。

运行门禁须在主库检查点缺失、落后、摘要不符或独立库不可用时关闭声纹采样／匹配／模型发布，同时保持普通转写、人工标记和清理控制可用。恢复端验证新外层包、复核当前头、重放撤销并推进主库检查点之后，才能恢复声纹功能。此处是待实现要求，本阶段尚未自动执行。

还需验证独立库自己的灾难恢复及最新性信任、HA／证书与密钥轮换、历史保留／擦除、8 MiB 上限下的容量、事务失败与超时、完整集群切换及生产备份策略。真人效果校准和真实设备验收也仍待完成；本阶段不缩减原方案范围。
