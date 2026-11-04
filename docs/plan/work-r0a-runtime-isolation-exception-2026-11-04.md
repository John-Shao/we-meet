# R0a 运行时隔离例外单（C04 / DR2 S1=A）

日期：2026-11-04 ｜ 提出：Qoder agent（DR2 评审发现 1／10）｜ 裁定：**S1=A 接受现实＋书面例外**（John Shao，单选）
关联：[DR2 评审记录](work-r0a-dr2-d4-review-2026-11-04.md)、[D4 设计 §6](work-r0a-runtime-egress-design-2026-10-25.md)、C14 已签降级、C09 集成项

## 1. 本条例外声明的事实

试点 Work ECS（36.151.147.217）2026-11-04 只读测量：

- `runc / runsc / containerd / dockerd / podman / bubblewrap` **全部不存在**；
- 部署副本 `/opt/work/runtime/{bin,src}` 对 `runc、runsc、containerd、seccomp、cgroup、unshare、bwrap`
  命中 **0 文件**；子进程由 `supervisor.mjs:249` 用同一 node 解释器裸 `spawn`；
- `work-runtime.service` 的隔离指令只有 `ProtectSystem=strict / PrivateTmp / ProtectHome / NoNewPrivileges`，
  而 `PrivateUsers=no`、`RestrictNamespaces=no`、`CapabilityBoundingSet=` 全默认集、
  `SystemCallFilter`／`RestrictAddressFamilies` 为空、无 `MemoryMax/CPUQuota/TasksMax`；
- 因此 D4 §6 的强化 profile 与 §6 的「runc 降级」分支**在 R0a 生产里都不成立**；D-05「每 Run 一 Pod」
  是目标形态，不是现状。

## 2. 随签三条

1. **R0a 期间不得把"容器隔离/gVisor/每 Run 一 Pod"写成已实现**：对外与运维文档一律表述为
   *进程级隔离＋凭据作用域*；`policy/sandbox-profile.json` 已改为 `profile=process_only`、
   `sandboxProof=false`，且 `policy/evaluator.test.mjs:126` 的断言改为"声称隔离证明即红"
   （已变异核对：把资产改回 `sandboxProof=true` → 10 条里 1 条红；还原后 10/10、md5 与备份一致）。
2. **实质缓解必须有对手测试，不得只写在注释里**：本轮确认在位的是
   子进程 env 白名单（`supervisor.mjs:22,80-86`）＋哨兵断言（`test/supervisor-handshake.test.mjs:61,72`）、
   无工具面与无 `getApiKey`（`child-pi.mjs:373`）、监听只绑 127.0.0.1、每 run nonce＋短效 scoped capability；
   本轮新增的守卫是 stub 拒启（`bin/work-runtime.mjs` `refuseUnoptedStubWiring`，发现 12／S5=A）。
3. **重开条件（任一出现即把本条例外退回 todo，并在独立取证窗口内补隔离）**：
   真实客户数据进入试点；池并发超过 `maxConcurrent` 且被用于正确性；R0b 本机执行或池化恢复启用；
   出现任何一次子进程越权出网的实测。

## 3. 残余风险（明写，不消解）

被提示操控的子进程可以把**本次 Run 已经取到的内容**发往任意公网地址（它没有网络命名空间边界），
也可以读取该 scoped capability 有效期内已经抓取的其它对象；宿主上没有 mount／syscall／pid／network
任一层的围栏。缓解只收窄"凭据"这一维（拿不到 DB／Temporal／供应商密钥），不收窄"数据外带"这一维。

## 4. 为什么不选另两条

- S1=B（补真容器隔离）：这台机连 runc 都没有，是一块新的开发＋运维工作，11-15 演练窗口前做不到，
  且会把 R0a 收口时间推到不可控；
- S1=C（systemd 级隔离）：能真收窄出网，但**很可能直接让 Pi 起不来**（node 需要被裁掉的部分能力/命名空间），
  必须先在活机验证一次；本轮未验证，因此不作为已生效控制写入任何文档。列为**下一手候选**，
  验证成本高于一句话的文档更正，收益是真实收窄。

## 5. 签收

| 结论 | 签字 | 日期 |
|---|---|---|
| ☐ 接受本条例外（S1=A）　☐ 改选 C 并要求活机验证　☐ 退回 todo（要求补容器隔离） | John Shao（产品＋安全，本项目唯一复核人） | ＿＿＿＿ |

**证据边界**：本单基于 2026-11-04 的一次主机测量与逐行读码；**不证明**子进程无法访问其它 Run 的内容
（库侧与 content-proxy 有租户/执行绑定测试，进程层没有）；**不替代** 11-15/16 演练对故障与资源面的取证。
L 编号遗留见评审记录 §7。
