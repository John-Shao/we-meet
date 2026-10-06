# 阿里云模型接入与连接复用验收

## 1–4 项进度

| 项目 | 状态 | 当前行为 |
| --- | --- | --- |
| Android 个人录音实时 ASR 直连 | 已完成，用户真机测试通过 | 客户端直连 ASR 3.1；保存录音时同步转写文本，音频仍保留归档上传 |
| Filetrans / Embedding 云端连接复用 | 已完成 | 后端和旧 Summary HTTP 复用已保留；本次补齐 Filetrans Agent 的跨任务复用 |
| qwen3.8-flash OpenAI SDK 实例复用 | 已完成 | 后端与未启用追踪的旧 Summary 按配置复用 SDK；追踪开启时，Summary 保持任务私有 SDK 和追踪对象，复用底层 HTTP 连接 |
| 云端实时 ASR / 翻译 WebSocket SDK 迁移 | 暂不迁移，保留现有适配器 | 迁移条件尚未满足；本次不改变独立实时语音会话的连接生命周期 |

## 本次实现

- Filetrans Agent 的封存转写 worker 在一个事件循环内持有 `aiohttp.ClientSession`，跨任务复用。实时转写 worker 不创建此连接池。独立调用仍在调用结束时关闭自己的 session。
- Agent 的连接上限为每 worker 32 条、每主机 16 条，空闲连接保留 60 秒。保留 45 秒请求超时，取消、异常及 worker 退出均释放对应资源。父进程、其他事件循环和已关闭 worker 的连接池不可借用。
- 后端和旧 Summary 的 SDK 缓存以凭证、服务地址、超时、重试策略及 SDK 工厂为键，每进程最多缓存 16 个实例。模型、消息、用量回调、用户与会话信息保留在任务或请求上。
- SDK 通过借用计数管理生命周期。关闭一个任务不关闭其他任务正在使用的 SDK；缓存淘汰或退出后，等待最后一个借用者释放，再关闭 SDK。子进程重建缓存和锁。
- SDK HTTP 连接上限为每进程 64 条，最多保留 32 条空闲连接，保留 60 秒。所有 provider SDK 和 Agent session 拒绝保存 Cookie；鉴权头由对应请求或隔离的 SDK 配置提供。
- 保留 OpenAI SDK 2.28.0、现有重试策略和模型配置，不迁移 DashScope SDK。后端 60 秒默认超时和旧 Summary SDK 原有默认超时均保留。
- Summary 的用户追踪同意、脱敏闭包和 Langfuse 实例继续按任务创建。任务成功或失败时均关闭 SDK 借用/私有 wrapper 并刷新追踪。

生命周期设计参考 [OpenAI Python SDK HTTP 资源管理文档](https://developers.openai.com/api/reference/python#managing-http-resources)，实现和测试以项目安装的 2.28.0 为准，未采用最新文档中的 HTTPX2 接口。

## 验证

- 后端 SDK、HTTP 池、普通补全和流式响应：24 项通过。
- 摘要版本、会议概览、录制问答、上传翻译、Embedding：92 项通过。
- Agent capture 转写：28 项通过；Qwen 适配器和连接池：49 项通过。
- Summary unit/models：生产候选镜像中 55 项通过。本机运行时有 9 项因缺少 `ffprobe` 失败；候选镜像包含该依赖，已补齐验证。
- 修改涉及的 Agent / Summary / 验证脚本 Ruff 检查及 `git diff --check` 通过。

新增测试覆盖：不同配置隔离、任务关闭后的复用、并发请求的凭证/模型/响应隔离、Cookie 不跨任务传播、缓存淘汰时等待正在借用的客户端、垃圾回收、构造失败释放资源、进程隔离、取消单个请求、worker 退出以及追踪脱敏与元数据隔离。

## 服务器隔离模拟负载

使用 `bin/provider-reuse-probe.py`，在生产服务器上的临时容器内验证候选镜像；每个容器限制 1 CPU / 512 MiB，使用 `--network none`，仅连接容器内 loopback 假模型服务。每组 512 个任务、32 并发，SDK 每任务 1 个请求，Filetrans 每任务模拟提交、轮询、结果下载共 3 个请求。使用假凭证，未调用真实模型或读写业务数据。

假服务关闭 TCP Nagle 算法后重新运行，避免将其小包发送延迟误记为连接池性能；下表仅保留修正后的结果。

| 组件 | 模式 | SDK / session 实例 | 新 TCP 连接 | 请求数 | 隔离错误 | P50 / P95 (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 后端 | 原有 HTTP 池，SDK 每任务创建 | 512 | 12 | 512 | 0 | 121.33 / 204.23 |
| 后端 | HTTP 池 + SDK 实例复用 | 2 | 11 | 512 | 0 | 102.51 / 182.40 |
| Summary（追踪关闭） | 原有 SDK 每任务创建，各自持有 HTTP 池 | 512 | 512 | 512 | 0 | 2702.62 / 3593.60 |
| Summary（追踪关闭） | HTTP 池 + SDK 实例复用 | 2 | 13 | 512 | 0 | 116.79 / 228.53 |
| Filetrans Agent | session 每任务创建 | 512 | 512 | 1536 | 0 | 82.54 / 89.94 |
| Filetrans Agent | worker 共享 session | 1 | 16 | 1536 | 0 | 53.95 / 88.23 |

该验证说明复用与连接上限生效。假服务没有 WAN、TLS 握手、真实模型推理、计费或阿里云限流，数字不能代表真实模型吞吐、用户延迟或生产容量。后端此前已经复用 HTTP transport，因此 SDK 实例复用主要减少构造开销；它不会让多个实时会话共用一条 WebSocket。

复现示例（在对应镜像内，脚本放在 `/probe.py`）：

```sh
python /probe.py --service backend --root /app --tasks 512 --concurrency 32
python /probe.py --service summary --root /app --tasks 512 --concurrency 32
python /probe.py --service agent --root /app/src --tasks 512 --concurrency 32
```

## 发布

对后端 API 2 个 deployment、后端 worker 3 个、Summary 4 个、封存 Filetrans Agent 1 个进行滚动更新。实时 ASR、实时翻译及其他 Agent 镜像保持原有版本。发布前运行中转写任务数为 0。

10 个 deployment 均完成滚动更新并达到目标可用副本数。逐个核对容器源码 SHA-256 与本地修改一致；9 个后端 / Summary deployment 的隔离运行时检查确认 SDK 2.28.0 及实例复用，第 10 个 Filetrans Agent 确认共享 session 和退出释放。

发布目录 `/home/johnshao/provider-reuse-20261007T012053` 保存更新前 deployment、原镜像、源码备份、验证数据和发布计划，可据此回退。

| 组 | 镜像 digest |
| --- | --- |
| 后端 API | `sha256:05589638d0cee8c9fe6daa2424dbcf0408d3a183d7820c6c8367ce608d13d8d6` |
| 后端 worker | `sha256:56741fb434bb38893cafaa64842b2ca627e7e4e29e3e482d4fca7a05b92e2c13` |
| Summary | `sha256:64b848dc15daa711a99e3919b9ca168ff49b16c491850a3fad332c9052f516fe` |
| Filetrans Agent | `sha256:9487fe07ef09a57a4636326ec040de77d0bead1ede1a5d8b9feeb1895f70f8c4` |
