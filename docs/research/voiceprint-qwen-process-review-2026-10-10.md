# Qwen 原生推理进程走查与修复

日期：2026-10-10。范围：feature 分支当前声纹编码服务，以及它与登记 API／worker 的调用边界。仍使用固定 Qwen encoder；未增加 CAM++，未采集真人录音或部署生产。

## 发现与修复

| 问题 | 修复和验证 |
|---|---|
| 原生推理卡死时无法终止线程，预算一直占用；终止后端 RPC 不能回收远端模型 | HTTP 父进程保留许可和预算，单个持久模型子进程预热后复用；预热／推理各 20 秒期限，独立计时器终止并回收子进程 |
| 超时后直接在下次请求中冷启动，会超过客户端的空闲读取期限 | 后台预热，恢复期间 503；恢复至少间隔 10 秒，单独的 live／ready 接口不触发加载 |
| Windows 虚拟环境启动器引入解释器后代，直接父 PID 校验误拒绝且清理可能漏掉后代 | 原子创建加入 Job Object 的进程，关闭 job 终止整树；测试同时检查启动器及实际解释器 |
| 先挂起创建、再加入 job 仍有父进程退出间隙，可能遗留挂起进程 | `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 `CreateProcessW` 创建时建立保护；不依赖后续 assign／resume |
| Linux 先导入 NumPy，再设置父退出保护，原生库初始化可能早于保护 | 在读取模型配置及导入原生库前设置 `PR_SET_PDEATHSIG`，核对父 PID，堵住父进程已经退出的竞态 |
| 清理和超时并发关闭同一 Windows handle，可能误关复用的句柄 | 锁内一次性交出句柄，再调用 CloseHandle；并发关闭回归只关闭一次 |
| 创建管道线程失败时，已经启动的模型进程与管道没有清理 | 构造失败回收 job／子进程／已启动线程，关闭未启动线程对应的管道；覆盖第一、第二个线程启动失败 |
| 进程输出可含畸形 JSON、超限响应、错误请求 ID、非有限向量或 `0 == false` 质量标记 | 有界 JSON／PCM 协议，固定模型元数据和请求 UUID，严格向量与质量类型校验；异常输出回收子进程，不释放结果 |
| 密钥文件先 stat 后 read 存在读取边界间隙 | 单次最多读取 4097 字节，超过 4096 拒绝，再执行凭证校验 |

Windows 创建适配仅支持本服务的固定 Python 模块、标准管道、继承当前环境和默认句柄隔离，保留 Python 3.13 的 Popen 管道／等待所有权。不提供通用 shell、任意运行环境或用户指定可执行文件。生产不记录请求体、音频、向量、密钥或原生错误详情。

## 验证证据

- 独立服务 81 项通过，包含实际固定模型测试，无跳过；故障场景使用真实进程与管道，不依赖假超时结果。
- 后端登记 API、worker、RPC 和实际 Qwen 登记链路 58 项通过；最终进程创建修改后再次通过实际模型完整登记链路。
- 真实模型的重复请求复用一个子进程；被终止后恢复使用新进程，特征空间与输出保持一致。合成音频只验证技术链路。
- Windows 覆盖预热前和运行中的父进程强制退出，检查模型进程及虚拟环境后代均退出；关闭和故障后检查管道线程已结束。
- Linux 在现有 `python:3.13-slim` 离线、只读、无额外 capability 容器中运行标准库探测：错误父 PID 拒绝，父进程强制退出后子进程被 SIGKILL，并由探测进程回收。此项不代表 Linux 完整 Qwen 镜像已验证。
- 修改代码 Ruff／格式检查、diff 空白检查通过；wheel 构建和内容检查通过，保留固定 Qwen 源码与许可，不包含测试、录音、模型权重或凭证。

复现 Windows 测试见[服务 README](../../src/voiceprint/README.md)。Linux 标准库探测入口为 `src/voiceprint/tests/linux_parent_death_probe.py`，挂载源目录只读、设置 `PYTHONPATH` 与 `PYTHONDONTWRITEBYTECODE=1` 后运行，无需模型及第三方依赖。

平台依据：[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[创建时设置 Job List](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)。Windows 10／Server 2016 以下与其他操作系统拒绝启动。Python 版本升级须重新验证创建适配。

## 仍待完成

语音／单人质量门禁、模板生成和实名匹配、导入／通话／录音来源、Web／Android 登记设置、部署调度及镜像仍按[完整开发记录](../plan/speaker-identity-implementation-2026-10-10.md)推进。信号质量样本保持 `quality_pending`，不能生成可用真人模板。尚无获授权真人样本，不能宣称 Qwen 身份识别效果已达标。
