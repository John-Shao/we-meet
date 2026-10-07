# Work Agent 松耦合集成 PoC

**当前状态（本日第二阶段）：选用 dsh 作为试点执行器，Pi 保留为独立可替换对照；完成本地
Work API/Outbox/Web 集成及真实 DeepSeek 验证。业务仍只依赖自有 HTTP v1 契约，Agent
可独立换镜像和更新 SDK。新开关默认关闭，尚未发布线上。下文原 PoC 记录为第一阶段历史证据，
其“尚未接入业务”和“dsh 用量未知”已由第二阶段实现更新。**

第二阶段新增服务端 ModelBroker：实际 DeepSeek key 不进入任务容器，容器仅持有可撤销的任务
token；每次模型调用前原子预占总 token 和调用次数，返回供应商用量聚合。两套引擎通过相同代理：

| CSV 对照 | 端到端耗时 | 模型调用 | 非缓存输入 | 缓存读取 | 输出 |
| --- | ---: | ---: | ---: | ---: | ---: |
| dsh | 26.061 秒 | 2 | 759 | 1408 | 642 |
| Pi | 17.955 秒 | 5 | 1844 | 11264 | 1218 |

两者去重/paid 筛选后的金额均正确。这仍是单次样例，缓存和执行路径不同，不能作稳定性能或费用排名。
按用户选定顺序和本轮能力验证采用 dsh，Pi 对照证明自有边界不绑定上游实现。

业务集成增加 `WorkTask.kind=office_agent`、冻结选材快照、独立短 HTTP tick、数据库锁和代次
防护、取消先于提交的 Gateway 墓碑、材料权限复核、不可变文件及已有草稿编辑/采纳功能。
响应丢失继续查询相同 UUID，不重复新建付费任务；取消和权限撤销不交付成果，但保留晚到用量。
用量未知继续保留预算；完整用量确认后每日预占改为实际 token。

真实端到端样例通过 Work 上传 CSV、解析选材和创建任务，经过独立 HTTP Gateway、Docker dsh、
DeepSeek 后回到 Work 账本和授权文件下载，耗时 30.630 秒，模型调用 2 次；非缓存输入 723、
缓存读取 1792、输出 627 token。`totals.json` 为 east=100、south=200，并生成 `report.md`。
该样例是合成材料，不是生产用户数据；机器检查通过不代表完整办公语义验收。

第二阶段验证：Work 后端 65 项离线测试通过（真实模型测试另行显式执行并通过）；Agent 27 项
测试通过，包括 3 项真实 Docker 生命周期测试；Web 17 项测试、TypeScript、局部 ESLint 和
Python Ruff 通过。原沟通准备和材料流程未出现测试回归。数据库迁移可由 Django 正常生成并应用。

当前范围是本地合成材料的选型和集成，不包含线上发布、敏感材料出站策略、Skills/MCP、外部
业务写入、GUI、二进制产物或多副本调度。模型 token 预占为保守上界，现有价格账本不精确反映
缓存折扣，金额需要供应商对账。启用/升级/回滚步骤见
[集成说明](../../src/work-agent/README.md)。结构化增量证据保存在同名 JSON 的
`integration_stage` 字段；原始本地回执位于 Git 忽略的 `.work-acceptance`。

---

以下为第一阶段原始 PoC 记录。

日期：2026-10-07（Asia/Shanghai）。范围：独立 dsh 执行服务、Pi 对照和合成办公样例。
结论：自有 HTTP Job 契约与一次性执行镜像已跑通；dsh 与 Pi 均能交付本轮周报和
CSV 成果。按用户选择继续优先验证 dsh，当前证据不支持框架性能/成本排名，也不代表
企业办公产品放行。

## 业务与 Agent 的边界

业务侧新增 [AgentClient](../../src/backend/work/agent_client.py)，只依赖 Python
标准库和自有 `work-agent/v1` 协议；Agent 服务位于
[src/work-agent](../../src/work-agent/README.md)，可以独立安装、启动和构建镜像。
上游 SDK、RPC、插件配置、持久会话以及模型凭证全部留在 Agent 部署单元。
现有线上沟通准备与业务用量账本尚未切换。

业务负责权限、选材、审批、预算和采纳。Gateway 负责认证、受理、幂等、独立 Inbox
与事件/成果返回。运行镜像负责会话内模型与工具执行，不连接业务数据库，不挂载
业务源码和 Gateway 状态目录。每个任务拥有独立 workspace/runtime-home。

升级契约：响应可增加可选字段；已有字段和语义保持稳定。破坏性变更发布 v2，
业务迁移前保留 v1。任务受理时记录不可变 image ID、模型和 policy 哈希；执行前
配置不匹配则 `deployment_changed`，不把已排队任务静默转交新版本。重启时清理
所属遗留容器，正在执行的任务标为 `execution_unknown`，不重放付费模型与工具。
旧 dsh 会话格式目前不进入业务兼容面，也不承诺自动恢复。

## 本轮环境和结果

- dsh Python SDK/runtime：`0.1.5rc1`，pip 依赖版本和 wheel 哈希锁定；
  `sdk-minimal` profile、受控 patch、关闭重试。
- Pi：`@earendil-works/pi-coding-agent` `1.0.4`，npm lockfile；RPC 以
  `agent_settled` 判定结束，不把 prompt 受理或 `agent_end` 当作成功。
- 两者均使用 DeepSeek `deepseek-flash`、low reasoning、每次响应上限 4096 token，
  相同用户目标与材料快照，各有自己的系统提示词和工具 schema。
- 当前真实模型每任务总 deadline 为 180 秒，CPU 1、内存 1 GiB、PID 128；
  容器 root filesystem 只读、移除 capabilities、禁止提权。
- 本地 dsh 仓库：`D:/workspace/dsh/deepseek-harness`，参考提交
  `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。未修改该仓库；源码提交与发布
  Python runtime 分开记录，不能视为测试了 master 的全部能力。

| 合成任务 | dsh 端到端耗时 | Pi 端到端耗时 | 检查结果 |
| --- | ---: | ---: | --- |
| 多材料周报 | 27.717 秒 | 5.650 秒 | 均生成 `weekly.md`，保留未验收、待审批、计划与完成的区分，没有编造上线日期 |
| CSV 去重和分组统计 | 27.418 秒 | 6.862 秒 | 均生成说明和 JSON；去重后 paid 订单为 A1/A2，华东 100、华南 200 |

耗时包含网关轮询、容器启动、上游模型和工具调用，只是各一次样例，缓存、工具选择
与提示词不同，不是稳定性能排名。CSV 正式样例的 prompt 没有预期金额；结果在
评测器中独立检查。周报的事实语义由助手查看成果审阅，不是用户业务签收。
Pi 周报额外提出关注审批进度的建议，后续办公评测仍需覆盖无依据推断与建议范围。

本轮 dsh 适配器没有可证明覆盖完整执行的 SDK 用量聚合，所以返回 `usage: null`，
不当作零成本。Pi 周报统计：非缓存输入 2367、缓存读取 4224、输出 596 token；
正式 CSV：非缓存输入 864、缓存读取 8960、输出 945 token。两者尚未做供应商
金额对账，不能比较费用，也没有接入现有 `AIUsageRecord`。

完整的四条选定记录、输入/成果哈希、运行镜像、进度事件及独立审阅结论保存在
[合成评测证据](work-agent-poc-2026-10-07.json)。原始本地回执保留在 Git 忽略的
`.work-acceptance/agent-poc-20261007-r*`。初版带预期数值的 CSV 和 Pi 认证配置
失败不纳入任务质量比较，原记录保留。采集器的 `semantic_review: pending` 不改写，
独立审阅在证据文件的 `independent_review` 字段登记。

## 验证

从 `src/work-agent` 执行：

```powershell
$env:WORK_AGENT_DOCKER_TEST_IMAGE='we-meet-work-agent:dsh-poc'
.venv/Scripts/python.exe -m unittest discover -s tests -v
../backend/.venv/Scripts/ruff.exe check work_agent tests ../backend/work/agent_client.py
```

19 项测试通过，其中 3 项实际启动 Docker 并使用离线 fixture：成果交付、deadline
销毁容器、创建阶段取消与销毁容器；没有付费调用。其余覆盖 HTTP 认证/版本拒绝、
同 ID 幂等与冲突、事件游标、取消终态、进程异常、重启未知状态、排队任务配置变化、
路径/校验和约束、硬链接成果拒绝、业务端拒绝损坏响应，以及上游完成/用量语义。
Ruff 与 `git diff --check` 通过。两套固定镜像构建与 DeepSeek 样例验证通过。

## 后续放行所需工作

PoC 当前支持 UTF-8 文本成果和合成输入，没有接入用户 Work 生成路由。下一批先
落实可核算的累计调用预算和完整用量、受控业务工具、服务端授权/审批、未知外部
写入对账，再做扩大材料与失败场景评测。Skills/MCP、复杂办公二进制成果、GUI、
跨版本迁移、执行恢复、多租户入口和多副本调度均尚未验证。

网关内部凭证与模型 key 分离，模型 key 只在本地 Git 忽略的 `.env` 和任务执行
环境中使用；Docker context 排除 env 文件。当前容器仍有网络访问，尚无模型端点
出口白名单，因此只用于本轮合成材料。保持 ExecutorAdapter 边界，后续即使更换
dsh runtime 或改选 Pi，业务任务、权限与成果对象也不需要改成上游会话对象。
