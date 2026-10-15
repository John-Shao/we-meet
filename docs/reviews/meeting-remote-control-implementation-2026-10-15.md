# 会议远程控制实施记录

日期：2026-10-15。状态：实施中，未完成、未部署。用户已授权从 aliyun-dev 新建分支完成方案实现。

## 基线与范围

- 分支：`feature/meeting-remote-control`，起点 `origin/aliyun-dev` / `d9e81a9eadcf79aef275081273a6e2a0a5fc33e6`，创建时已拉取远端确认一致。
- 独立工作目录：`D:/workspace/jusi-meet/.worktrees/we-meet-remote-control`。
- 原 `we-meet` 工作区的未提交业务改动保留；仅复制[设计方案](../plan/meeting-remote-control-design-2026-10-14.md)与[历史评审](meeting-remote-control-design-review-2026-10-14.md)。原 AI 平台变更不作为本功能隐含依赖。
- 实施范围保留方案首期：PC Web/Windows 桌面控制 Windows 被控设备、本人原生同意、同会议授权、屏幕与输入绑定、键鼠/文本、暂停/撤销、故障释放和审计。P4 平台扩展仍为后续阶段，不宣称已实现。

## 第一批：原生执行与签名基础

已编写并验证：

- Windows C++ 输入 helper 与独立 guardian；受限继承句柄、共享候选台账，guardian 不接收远程命令，只在 helper 退出确认后释放候选键/按钮。
- P-256/SHA-256 输入签名、704 字节定长帧（640 字节被签名）、会话/屏幕/输入代次绑定、连续输入序号、独立 heartbeat 序号、3 秒挑战有效期、15 秒最大原生租约。
- 键鼠白名单、范围检查、组合键限制、输入速率上限、原生本地交互/热键监测；台账先记录 down，确认 up 后清除，Unicode 候选也进入释放台账。
- 主进程内部 `RemoteInputHelper` 适配器：固定资源路径、SHA-256 清单核验、后台启动、消息长度限制、父进程心跳、等待独立 guardian 清理结果；尚未暴露给 preload 或会议页面。
- 浏览器兼容的 TypeScript 二进制编码/签名器，与 Win32 CNG 交叉验证。
- 后端批准证明和短租约签名工具：限制域规范 JSON、P1363 验签、不可覆盖的 audience/到期 claims；尚未接入数据库和 API。

### 已执行验证

| 命令（仓库根目录） | 结果与范围 |
| --- | --- |
| `python src/desktop/scripts/build-remote-input.py` | 通过；本机 Visual Studio 18 C++ x64，C++17、/W4 /WX；生成原生二进制和摘要清单 |
| `node src/desktop/node_modules/typescript/bin/tsc --project src/desktop/tsconfig.json` | 通过；桌面 TypeScript 编译 |
| `python src/desktop/native/remote-input/test_runtime.py --inject -v` | 12 项通过；包括真实 Ctrl-down、鼠标左键 down 后强制终止 helper，实际按键释放并收到 guardian cleanup=1 |
| `node --test src/desktop/tests/remote-control-native.integration.cjs` | 3 项通过；编码拒绝、签名字段篡改、WebCrypto→CNG、输入缺口拒绝和 guardian 退出结果；用例原为 `.test.cjs`，现按集成依赖分开运行 |
| `PYTHONPATH=src/backend python -m unittest core.tests.services.test_remote_control_crypto -v` | 4 项通过；规范编码、绑定/用途签名变更、错误公钥、租约 audience/上限；Windows 可用 PowerShell 设置 PYTHONPATH 后运行 |

原生注入测试只在测试程序创建的前台窗口中验证修饰键和左键释放，不输入业务内容、不发送应用命令。默认不带 `--inject` 时跳过这两项真实注入测试。未将生成的 EXE/OBJ、密钥或用户环境配置提交仓库。

### 尚待完成（不视为已通过）

1. 原生 P0：多显示器/DPI/源映射、受信控制条与确认窗、完整安全桌面竞态、守护/工作线程卡死以及全部台账窗口故障注入；本批只证明列出的路径。
2. 后端后续：真实 LiveKit 房间联调、管理配置与密钥轮换、过期/保留任务验收（包括房间删除时审计保留）、审计分页及完整跨租户/限流验收；本轮已补接口与数据库测试，见下文。
3. 桌面：独立原生同意记录、采集意图/轨道绑定、协调器与续租、控制条/托盘、换号/锁屏/退出集成、preload 最小桥。HTTP/许可校验模块已验证，但尚未由真实原生确认流程调用。
4. 前端：会议 Provider、能力发现、申请/同意状态、专用控制视图、焦点暂停握手、文本隔离、定向 transport、输入 ACK/心跳与后台处理。
5. 联调：两台独立 Windows 设备、Chrome/Edge/Electron、A/B/C 定向消息、弱网、30 分钟/100 次循环、原会议回归。
6. 交付：原生资源打包/签名、固定摘要、安装升级验证、配置/运维说明、完整需求验收；未经证据证明不得标为完成或开启生产功能。

### 本批实现选择与后续约束

- 固定二进制输入是方案允许的编码选项，替代高频 JSON 的跨语言规范化；批准签名仍为限制域规范 JSON。
- helper 当前保留目标屏幕顶部 64 物理像素作为控制条区域；正式 UI 必须实际占用并与保留区同步，尚不能把该固定区域当作完整受信 UI 防护。
- 本地接管目前使 helper 关闭并释放；协调层应将其映射为业务 PAUSED，只能经 B 本地恢复、更新 epoch/输入代次后重新装载。
- 资源摘要用于包内完整性检查，不等于 Windows 代码签名。正式交付需先签名再生成最终摘要，并验证打包后字节一致。
- 开发阶段 desktop/node_modules 使用已安装依赖的本地 junction，以便验证；最终须以此分支锁文件独立安装/构建，不能把共享依赖目录视作可复现交付证据。

## 第二批：服务端授权与桌面许可校验

已新增数据库迁移 `0223_remote_control_authorization`，持久化连接能力、申请/许可状态、一次性挑战及生命周期审计。申请和授权转换按账号稳定顺序加数据库行锁；数据库约束另限制同连接/同被控设备的未结束关系。原生来源仍不能由临时自签公钥证明，最终本机同意记录尚待 UI/协调器接入。

实现内容：

- `/api/v1.0/rooms/{room_id}/remote-control/` 下的能力声明/查询、申请/查询、prepare/approve/lease/resume 挑战与验签、暂停、取消、拒绝、结束及管理员审计读取。采用现有 OIDC/Session 认证，业务显式拒绝匿名、停用、设备账号；管理员仅可撤销，不可代同意。
- LiveKit 服务端查询房间 SID、当前参会连接、真人类型、数据/共享权限及屏幕轨道归属；客户端提交的 SID 必须与查询结果一致。组织默认关闭，支持控制者/被控者用户范围和最长时长；房间策略只能收紧。
- 30 秒申请、60 秒准备、15 秒签名许可、30 分钟最长会话；挑战绑定用途、版本、epoch、申请摘要和完整绑定，消费后只返回原收据；终态不恢复。暂停续租不会改为 ACTIVE。
- 已验签 webhook 的离会/房间结束/轨道移除回收；既有结束会议、移除参会者和修改权限 API 接入回收。Celery 每 5 秒协调到期状态，保留任务每小时运行；原生执行不依赖定时任务及时触发。
- 桌面 `RemoteControlCloud` 固定路径/动作、8 秒超时、实际响应读取上限、登录 epoch 检查和稳定错误码；不新增任意 URL 桥。
- 桌面批准证明规范编码、不可导出私钥及 P1363 签名；签名许可与本机完整 binding/epoch/state 匹配，单调截止扣除整段 HTTP 耗时和 1 秒时间量化预算，并受本地最大会话截止约束。服务端每次响应提供新顶层 serverTime，不能用旧幂等收据中的时间重置租约。

新增配置为 `DJANGO_REMOTE_CONTROL_ENABLED`（默认 false）、`DJANGO_REMOTE_CONTROL_SIGNING_KEY`、`DJANGO_REMOTE_CONTROL_SIGNING_KID`；签名密钥独立于 LiveKit secret。组织 `settings.remote_control.enabled` 也必须显式为 true。当前端到端功能未接通，尚不能按这些配置开启可用的会议远控。

### 本轮验证证据

| 验证 | 结果及边界 |
| --- | --- |
| 独立 PostgreSQL 16 全量 migrate | 通过，含新迁移；`makemigrations --check --dry-run` 无差异，Django check 无问题 |
| `test_remote_control.py`、`test_remote_control_boundaries.py`、`test_remote_control_crypto.py` | 38 项通过；真实数据库/API/签名/反向申请和同意取消竞态，LiveKit 网络 IO 被替换为协议对象 |
| 上述测试加既有会议结束与参会者管理测试 | 88 项通过，44.40 秒；包含新鲜响应时间与幂等收据的区别 |
| 既有 LiveKit 事件与 webhook API 测试 | 42 项通过，7.79 秒；原本隔离房间 handler 的一项测试补 db fixture，保留真实撤销查询 |
| 桌面 `tsc` + `node --test tests/remote-control-*.integration.cjs` | 10 项通过；包含 WebCrypto→Python 证明、Python→JOSE 许可、有效签名但本机绑定不匹配的拒绝、换号迟到响应与无 Content-Length 超限读取 |
| `npm run test:remote-control`（桌面目录） | 通过，重新编译原生与 TypeScript 后 10 项 Node 集成测试通过；Python 原生测试 10 项通过、2 项真实注入按默认参数跳过；真实注入证据另见第一批 `--inject` 记录 |
| 新增后端模块及迁移 Ruff | 通过；未将原 models.py 的历史样式问题伪称为全仓 lint 通过 |

测试后端使用此 worktree 挂载到 `meet-backend:f12d6c04c` 基线镜像，Python 3.13.5 / Django 5.2.14；独立 PostgreSQL 容器端口 15446、Redis 端口 15447，不使用生产数据。测试依赖 pytest 9.0.3、pytest-django 4.12.0；桌面互验需要 Python cryptography/PyJWT。集成用例单独列入 `npm run test:remote-control`，不让普通桌面单元测试隐式要求原生工具链与后端 Python 环境。

以上不证明两台设备可实际操作、受信同意 UI、采集源映射、安全桌面完整恢复、部署或签名安装包已经完成。剩余首期范围继续按上方清单推进。
