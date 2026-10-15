# 会议远程控制运维手册

日期：2026-10-15。适用于本分支的授权服务、管理台和支持 `keyRing` 的 A/B 客户端。实现及隔离回归已完成的范围见[实施记录](../reviews/meeting-remote-control-implementation-2026-10-15.md)；本文不是生产上线或双机验收通过证明。全局和组织开关默认关闭。

## 配置与职责

参会者的本机授权、控制与停止流程见[远程控制使用说明](../features/meeting-remote-control-user-guide.md)。管理员的策略或密钥操作不能代替 B 的本机确认。

远控短许可采用独立的 ES256 / P-256 密钥。它与 LiveKit API secret、A/B 临时会话密钥、Windows Authenticode 代码签名证书分别管理；本手册的换钥命令不能签署 Windows 安装器。

后端使用以下配置：

| 配置 | 用途 |
| --- | --- |
| `DJANGO_REMOTE_CONTROL_ENABLED` | 全局开关，默认 false；还须当前组织策略允许 |
| `DJANGO_REMOTE_CONTROL_SIGNING_KEYS_FILE` | 只读秘密文件路径，内容为 JSON 对象 `{ "唯一-kid": "P-256 私钥 PEM" }`；生产优先使用秘密挂载 |
| `DJANGO_REMOTE_CONTROL_SIGNING_KEYS` | 同格式的环境变量配置；存在 `_FILE` 时由文件配置优先 |
| `DJANGO_REMOTE_CONTROL_SIGNING_KEY_FILE` / `DJANGO_REMOTE_CONTROL_SIGNING_KEY` 与 `DJANGO_REMOTE_CONTROL_SIGNING_KID` | 仅当多密钥配置为空时使用的单密钥兼容配置 |

多密钥配置一次允许 1～8 把密钥，JSON 不允许重复键；`kid` 为 1～64 位 ASCII 字母、数字、下划线或连字符。使用新生成的 P-256 私钥，例如 PKCS#8 PEM。数据库只存公钥、摘要、状态及操作审计，私钥始终保留在秘密配置。不要将 PEM、秘密文件内容、证书密码放进命令参数、工单、聊天或仓库。

秘密文件由 Django 配置在**进程启动时**读取。仅替换挂载文件不能证明运行中的 Gunicorn/其他后端进程已加载；变更后须完整重启或滚动替换全部相关进程，确认没有旧副本。

以下命令在已加载正确 Django 配置、连接目标 PostgreSQL 的后端运行目录执行。`lease-202610-a`、`lease-202611-b` 和变更编号均为示例；所有版本号都须从目标环境的最新输出读取，不可照抄到生产。

## 首次启用

1. 保持全局开关关闭，按部署流程备份数据库、应用迁移至 `0226_remote_control_signing_rotation`。所有可处理远控请求的后端进程都必须升级到带全局签名锁的版本，不能与绕过该锁的旧授权服务混跑。
2. 在秘密配置加入首把密钥，启动新版服务。显式初始化一次：

   ```sh
   python manage.py remote_control_keys initialize --kid lease-202610-a --operator CHANGE-001
   python manage.py remote_control_keys show
   python manage.py remote_control_keys check --kid lease-202610-a
   ```

   初始化建立 `revision=1`、`generation=1` 和首条审计。重复初始化拒绝；接口不会自动生成或初始化密钥。迁移前会话的 `signing_generation=0` 不自动升级，读取时结束，必须重新申请并由 B 同意。
3. 完成客户端升级及真实验收后，在部署配置启用全局开关、重启服务；组织 owner/administrator 在 `/admin/remote-control` 配置组织策略。字段和范围见[设计 §11.1](../plan/meeting-remote-control-design-2026-10-14.md#111-组织策略管理契约2026-10-15-实施补充)。组织默认关闭；房间策略只能进一步收紧。任一组织策略修改都会结束已有申请/会话。

`show` 仅输出公开验证集合和版本；`check` 仅输出当前命令进程的公钥指纹、版本和就绪结果。它不检查另一进程的内存配置，不替代服务滚动更新完成的证据。旧客户端无法保证连续换钥，遇到新 `kid` 会停止；新旧客户端混用不能作为无中断轮换验收。

## 计划轮换

1. 生成全新的密钥与从未用过的 `kid`，将旧、新私钥同时放进秘密配置。完成**所有服务副本和工作进程**的滚动重启；旧密钥暂时保留，当前签发仍使用数据库指定的旧 `kid`。
2. 查看版本并登记候选：

   ```sh
   python manage.py remote_control_keys show
   python manage.py remote_control_keys stage --kid lease-202611-b --expected-revision 1 --operator CHANGE-002
   python manage.py remote_control_keys check --kid lease-202611-b
   ```

   `stage` 只登记公钥，递增版本，不改变当前签发者。它不会把候选私钥分发给其他副本。在每个已完成替换的部署单元运行 `check`，核对相同指纹，并确认承载请求的进程确实在新秘密配置下启动。
3. 再读最新版本后激活：

   ```sh
   python manage.py remote_control_keys show
   python manage.py remote_control_keys activate --kid lease-202611-b --expected-revision 2 --operator CHANGE-003
   ```

   新许可立即使用新 `kid`；旧公钥保留至激活时间加 15 秒，许可到期也不能超过该退役时间。正常轮换不改变 `generation`、不撤销 B 的本次同意。客户端通过固定服务地址的认证 HTTPS 响应更新公钥，JWT 头只选择已信任的 `kid`，不能提供密钥 URL。
4. 确认续租与服务健康，过渡窗口结束后从运行配置移除旧私钥，再完成必要的滚动更新。保留数据库中的旧 `kid` / 公钥摘要记录，不删除、不改名复用、不重用旧私钥。过期公钥可仍出现在带截止时间的集合中，客户端按截止时间拒绝；下一次激活会清理过期项的可见状态。

并存的可验证公钥最多 8 把；过于密集的轮换会返回 `signing_overlap_limit`，等待旧窗口结束后按最新版本重试。版本变化必须对应一致的公钥文档，不依赖各副本自行按墙上时间删除同一版本的条目。

## 密钥泄露或紧急撤销

先使干净的新密钥在全部服务副本可用。撤销当前密钥时，可同事务切换到全新的替代密钥：

```sh
python manage.py remote_control_keys show
python manage.py remote_control_keys revoke --kid lease-202610-a --replacement lease-emergency-c --expected-revision 3 --operator INCIDENT-001
```

替代密钥必须已在秘密配置中，允许先 `stage`；未登记时会在同一撤销事务内登记。没有可用替代密钥时，省略 `--replacement`：当前签发者置空，服务拒绝新授权。此后配好新密钥，再执行 `stage`、`check`、`activate` 恢复。

撤销任一仍可撤销的已登记密钥都会递增全局 `generation`，在同一事务结束**所有组织**的旧代次未结束会话，并写密钥操作审计和会话审计。旧批准回执不能重新发放许可，重新使用必须创建新申请并经 B 同意。撤销已退役但尚未标记 expired 的密钥同样会终止全局会话；expired/revoked 状态不可再次撤销，也不可重新激活。

客户端收到结束状态或撤销代次变化即关闭控制门。已签发许可无法从网络中瞬间收回；未收到更新时，仍由不超过 15 秒的既有租约到期停止。真实传播和停止时延须在双机环境测量。

## 故障处理、审计与恢复

| 结果 | 处理 |
| --- | --- |
| `signing_revision_conflict` | 有其他操作者改动，重新 `show` 并核对变更后再决定下一步；不自动覆盖 |
| `signing_unavailable` | 检查是否初始化、当前密钥是否在本进程加载的配置中、公钥指纹是否一致；检查部署滚动状态，不输出 PEM |
| `signing_key_reuse_forbidden` | `kid` 或密钥材料曾使用过；生成新的密钥与标识，保留历史记录 |
| `signing_overlap_limit` | 验证集合已满；等待退役窗口结束后重试，不扩大客户端信任上限 |
| 未明确取得成功响应 | 先 `show` 核对版本和当前 `kid`，再检查审计；不要反复执行不可逆的撤销 |

没有新私钥的旧工作进程会拒绝签发，而不会自行退回旧 `kid`。密钥操作使用 PostgreSQL 全局排他锁，授权使用共享锁；数据库状态变更、全局撤销和审计原子提交，审计失败整体回滚。`--operator` 是写入审计的操作者/变更标识，不是身份认证机制；命令入口的授权由部署平台与操作系统控制。审计记录版本、代次、动作、目标 `kid` 和结束数量，不记录私钥或输入内容。

保持服务端时钟同步；客户端沿用认证响应时间和单调时钟检查许可。版本回退、同版本内容变化或 `kid` 对应公钥变化会使本次控制失败关闭。不能通过删除状态表或重置版本恢复旧客户端会话。

数据库恢复后先保持全局功能关闭，核对密钥登记与秘密配置；涉及泄露时使用全新密钥和标识、执行撤销、完成所有进程更新后再启用。不要恢复被泄露的私钥或回滚到绕过撤销锁的服务版本。当前实现不提供对可信数据库备份回滚的独立外部防回滚证明。

组织紧急关闭入口只作用于该组织；全局密钥撤销影响全部组织。发布验收需分别验证两条路径，以及正常换钥期间的双端续租、旧公钥截止、新进程缺密钥拒绝、通知丢失后租约停止。当前隔离测试库已验证事务和签名路径，尚未执行真实生产换钥或独立双机验收。
