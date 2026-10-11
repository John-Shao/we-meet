# 声纹独立日志提交、恢复门禁与麦克风声明走查

后续[容量与提交耗时走查](voiceprint-journal-capacity-review-2026-10-11.md)已减少重复读取／合并并完成真实大状态测量；全量封装和串行发布的生产容量仍未验收。

后续[强制日志门禁下的完整 RTC 走查](voiceprint-journal-rtc-review-2026-10-11.md)已补齐完整合成 RTC 回归；生产拓扑、实际设备、容量／HA 与真人效果仍待验收。

日期：2026-10-11（Asia/Shanghai）。分支：`feature/speaker-identity-voiceprint`。接续[独立日志库基础](voiceprint-journal-authority-review-2026-10-11.md)，本阶段接通业务提交、主库检查点及恢复门禁。功能继续默认关闭；Qwen 优先、效果不满足再考虑私有化 CAM++ 的选型不变。

## 修复的问题

独立日志只有离线导出能力时，主库整库恢复可能同时恢复旧授权、旧密钥和旧删除记录。现在主库保存部署绑定的 sequence／digest 检查点，采样、候选、质检、模板及身份授权入口每次检查独立库的最新头。缺少配置、检查点、连接失败或头不一致时关闭处理入口，不缓存以前成功的结果。

撤销、档案删除、样本拒绝、来源删除和账号／组织／成员停用，在主库事务提交之前，通过独立 PostgreSQL 的 CAS 追加发布签名加密元数据，再于同一主库事务写入检查点。全局事务锁先于业务所有者锁取得，嵌套调用合并；普通展示字段更新不进入日志。发布失败回滚主库；外部追加成功但响应丢失或主库随后回滚，外部头保留，主库门禁关闭，必须离线重放后恢复。不会盲目重试覆盖较新头。

`Model.save/delete` 和 ORM 的 update、bulk_update、bulk_create、delete 共用保护。PostgreSQL 触发器拒绝绕过事务标记的敏感 DML；不可变删除／贡献证明的载荷及终态样本不能重新激活。已经留下删除证明的物理擦除可在日志故障期间继续。管理员 DDL、TRUNCATE 和整个主库备份恢复属于可信运维操作，必须使用离线恢复流程，这些触发器不构成对数据库管理员的防御。

通话“本次暂停”与麦克风／共享设备声明不属于永久授权表。仅比较五类元数据会漏掉这类变更。本次增加独立数据库触发器和事务内变更标记：声明变化即使元数据内容相同，也必须推进独立日志头。恢复会递增声明版本、暂停采样、清空设备声明、要求重新确认是否共享麦克风，并取消尚未使用的采样许可。其他合法声纹密钥、确认模板和永久授权不会因此被删除。

## 部署与恢复顺序

生产及开发配置要求独立日志门禁；仅隔离测试配置默认豁免。开启业务之前须准备独立 PostgreSQL 16、安装已有角色／schema、提供私有配置并完成初始化。不能用过时或来源不明的备份执行首次初始化；首次初始化只接受可信、冻结的当前主库及独立库零头。已有外部头禁止重新初始化。

所有 API、AI API、Beat 和三个处理消费者必须冻结；关闭总开关、采样开关和匹配开关。停用进程及其他写入者是运维责任，命令检查功能开关不能替代冻结。安装迁移 0218—0221 后，在可信初始主库运行：

```text
python manage.py initialize_voiceprint_journal --config /private/writer.json
```

主库故障后，由只读配置生成本次请求，持有签名私钥的独立导出进程读取日志，再于已恢复、仍冻结的主库重放：

```text
python manage.py request_voiceprint_journal_recovery --config /private/reader.json --output /private/request.json
python manage.py export_voiceprint_journal_recovery --config /private/writer.json --request /private/request.json --output /private/bundle.json
python manage.py restore_voiceprint_journal_recovery --config /private/reader.json --request /private/request.json --bundle /private/bundle.json --receipt /private/receipt.json
```

前两个命令不依赖业务主库。恢复校验部署、本次请求、签名、加密和外部最新头；重放之前及之后各读取一次最新头，防止中途出现较新撤销。检查点和主库清理同事务提交。恢复保持业务开关关闭；运维核验后再启动。回执使用新文件路径，在数据库提交之后写入和 fsync；回执写入失败不能推断数据库已回滚，核验主库后使用新的回执路径重试。

日志客户端使用 `verify-full` 和 `target_session_attrs=primary`。必须连接当前权威主节点；禁止配置只读副本或分发到滞后节点的读代理。该参数拒绝普通备库，不能替代 HA 仲裁、同步持久性、故障切换和最新性证明。独立库不得随业务主库一起回滚；外部日志自身丢失或回退不能通过重新初始化规避。

Helm 的 `voiceprintRuntime.configurationSecret` 增加 `journal-writer.json` 和 `journal-ca.crt`，writer 的 `database.ca_file` 填 `/run/voiceprint-journal/ca.crt`。配置路径固定为 `/run/voiceprint-journal/writer.json`。两者通过只读 subPath 文件挂载，满足加载器拒绝叶节点符号链接的要求。沿用 UID／GID 10001 和 0440 文件权限；日志私钥不提供给查询清理 sidecar。subPath 不会自动刷新 Secret，凭证／CA 变更必须递增 `configurationRevision` 并滚动所有使用者。

## 验证与证据边界

专项测试覆盖门禁、CAS 发布前后失败、外层主库回滚、不可变证明、ORM 批量停用、作用域隔离、终态拒绝、恢复期间头变化、暂停声明及恢复重新声明。此前组合回归 146 项通过、1 项 Windows 符号链接用例跳过；扩展来源／擦除／模板／质检组合 198 项通过、1 项跳过。最终日志门禁／声明／采样专项 67 项通过；Helm 私有运行配置 11 项通过，包含各 API／Beat／消费者文件挂载及路径覆盖拒绝。Django 系统检查无问题，迁移漂移检查无变更，新增／修改服务和探针 Ruff 通过。

实际 Linux 探针使用两个独立 PostgreSQL 16 数据目录和真实 TLS：主库先整库备份，随后撤销并发布；停止主库后仍可导出；整库恢复确实找回旧检查点、旧密钥、样本和模板，门禁立即关闭。签名重放擦除 3 个样本、1 个模板及撤销密钥，同时保留另一作用域的加密密钥和可解密模板。另验证日志重启持久性、日志停机关闭门禁以及实际 hot standby 被拒绝。扩展探针同时验证旧麦克风声明复活后必须重新声明。

探针使用合成元数据和合成加密载荷，无真人录音、无模型请求；仅创建和删除带本次随机标签的隔离容器、网络、卷及临时凭证。没有生产部署或镜像仓库上传。

最终验证镜像为 `we-meet-backend:voiceprint-journal-control-20261011`，ID `sha256:5f0125c589003ec10d12e3bc918e27ec3054d0d3ff853a5b6ce169f9124f5705`，UID 10001；实际恢复后最新 sequence 为 3。可用 `deploy/aliyun/run_voiceprint_journal_probe.py --mode recovery --backend-image <本次后端镜像> --diagnostics-dir <私有结果目录>` 复验。合成数据协议测试不替代实际 TLS 和双库探针，两个层次分别验证。

## 尚待完成的完整验收

当前每次发布复制完整元数据，沿用每表 100,000 行、明文 8 MiB、封装 12 MiB 上限；超过上限拒绝，不能截断。全局串行发布及追加历史需要生产容量／延迟／并发基准、保留与压缩策略，不能把本次小数据探针当作容量证明。持续高频麦克风声明也增加写入成本。

仍需验证独立权威库的 HA、同步持久性、自身灾难恢复、可信最新头、密钥轮换和操作流程。现有 RTC／部署探针需配置并初始化新的强制日志门禁后重新验收；完整 RTC、实际设备、真人声纹效果及生产验收仍待完成。没有授权真人资料时继续代码及合成技术验证，不能宣称实名匹配效果已达到上线标准。
