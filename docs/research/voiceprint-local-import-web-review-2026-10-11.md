# 本地真实存储、上传及 Web 身份复核验收

日期：2026-10-11（Asia/Shanghai）。用户选择“先完成本地存储、上传和 Web 验收，真实 Qwen ASR 配置后补”。本次只使用合成音频、临时测试账号和本地 Docker，不接入生产 ECS 或真实云端 ASR。

## 范围与执行路径

在[上一轮 RTC 与身份队列验收](voiceprint-local-acceptance-review-2026-10-11.md)基础上，新增显式入口 `run_voiceprint_rtc_probe.py --import-web-review`。该模式先执行真实 RTC 登记、Qwen 编码、本人确认及音频清理，再由 Chromium 操作实际 React 上传／身份识别／人工标记组件。

使用真实 MinIO、私有桶、S3 SigV4 和版本控制。浏览器通过实际 multipart API 上传 30 秒、24 kHz、16 bit 双声道 WAV；实际预检生成单声道衍生文件，并由应用持久化固定版本回执。上传任务、原文片段、身份调度、查询和建议均由应用创建，验收 fixture 不预写这些数据。通讯录中的一个已接受外部联系人是合成账号数据，不授予其录音读取权限。

文件转写使用本地 HTTPS 协议 fixture：它实际下载签名 MinIO 对象，校验 WAV 格式及 30 秒时长，返回固定单说话人文本与时间戳。真实异步提交／轮询／结果下载、发布和调度仍由应用运行；这不是真实 Qwen ASR，不能证明转写或多人分人的效果。结果下载不携带 provider Authorization，fixture 拒绝向其他地址重定向。

声纹模型仍是固定 Qwen3-TTS Base speaker encoder，使用实际 RTC 模板和实际查询提取；没有改用 CAM++。测试门限沿用上一轮一次性的 `rtc-synthetic-test-only-v1`，不是获授权真人的校准制品。

Web 使用真实 Cookie 会话、CSRF、所有者标头及 HTTPS 后端，未模拟 API 响应。为了在本地访问内部 Docker 网络，新增仅绑定 `127.0.0.1:5318` 的 TCP 转发容器，唯一目标是自建后端的固定内部 IP；TLS 在 Vite 与后端之间校验，转发容器没有业务凭据或私钥。Vite 只监听 `127.0.0.1:5319`。默认模式仍不发布宿主端口。

页面是实际组件的验收组合页，原文读取使用导入录音的 `original-segments` 契约；没有覆盖完整导航、SSO 登录或媒体试听。会话由隔离后端的测试登录创建。实际人工操作包括确认建议、选择通讯录、自定义标签，以及并发冲突后的关闭／重开。

## 执行结果

最终完整重跑资源前缀为 `vp-full-rtc-42e0af3f5a`，入口退出码 0；原生 driver 和浏览器均返回 `status=passed`，`public_upload_web_chain=true`。运行结束后核验自建资源及测试端口均无残留。

| 检查 | 实际结果 |
|---|---|
| RTC 登记／隔离日志 | 3 个实际 Qwen 编码并由本人确认的样本，1 个加密 baseline；20 次签名 webhook 全成功，2 个房间实例；独立日志当前且 sequence 7 |
| 实际上传／预检 | Web 仅 1 次 POST，返回 202；上传第 1 次尝试成功，预检 ready，1 个固定版本的单声道准备输入 |
| 转写协议／发布 | 1 次异步提交、1 次轮询、1 次无凭据结果下载；实际签名读取 1,440,044 字节 WAV；应用发布 3 个原文片段、1 个说话人 |
| 自动身份调度／Qwen 查询 | dispatch 第 1 次尝试 submitted；1 个身份任务／1 次尝试，完成后生成 suggested；5 个实际查询片段、25,000 ms 语音量，查询临时子项 0 |
| 等待人工确认 | 建议完成后，API 的 attributed_user_id 为 null、manual_label 为空、attribution_kind 为 none；Web 确认后保留 1 个 confirmed 建议 |
| 通讯录／自定义标签 | 实际选择已接受外部联系人，再保存 `Synthetic final label`；3 条原文的 API 和页面均显示人工姓名／标签 |
| 正常人工覆盖语义 | 人工改选后旧任务变为 canceled，原因 `identity_presentation_changed`；confirmed 建议保留，不重新编码或补充模板；支持样本仍为 3 |
| 重放／并发冲突 | 重复确认和冻结旧 revision 的保存均返回 409；页面提示重新打开，禁用旧保存；重开后成功保存最终标签；共 5 条合法决定，未提交的旧标签未落库 |
| 权限／存储 | 被选外部联系人读取记录仍为 404，选择联系人没有扩大读取权限；未签名 MinIO 原对象 HEAD 为 403 |
| 浏览器视口／主题 | 1280 px、390 px，浅色／深色共 4 场景，文档宽度等于视口；无横向溢出，无 pageerror 或外部请求；建议、冲突、最终页面截图已人工核对 |
| 音频／资源回收 | 登记候选音频 0，查询临时子项 0；11 个容器、3 个匿名卷、1 个自建内部网络、临时私有目录、所属 Node 进程及 5318／5319 监听均无残留；原有 4 个容器继续运行 |

回执中的 `jobs_succeeded=0` 是人工覆盖后的终态，不表示提取失败：浏览器在确认前检查真实 API 的 job status 为 succeeded，之后选择通讯录／标签按既有业务逻辑取消旧上下文，最终 `jobs_canceled_for_presentation=1`。没有为了保持 succeeded 修改业务逻辑。内存存储 fixture 的旧计数字段不用于本次 MinIO 证据。

本轮未重复 `--media-boundaries` 的换轨／重连等扩展场景，相关证据保留在上一轮报告。本次是单个合成用例，不计算端到端 P95 或生产容量。

## 制品与资源

后端、sampler／driver、Qwen encoder、LiveKit、PostgreSQL 和 Redis 沿用上一轮的固定 image ID；应用源码没有挂载覆盖。本次只读挂载独立验收入口和协议 fixture。新增 MinIO 的本地 image ID 为 `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`；转写 fixture 和 TCP 转发容器使用同一个已固定的后端镜像。

共 11 个自建容器，内部网络及独立主库／日志库／Redis；MinIO 与后端共用网络命名空间。TCP 转发容器另连接 Docker bridge，仅用于本机入口，其转发目标不可由请求指定。MinIO 数据使用自建容器内 tmpfs，结束后连同测试音频一起回收。

| 新增组件 | CPU 上限 | 内存上限 |
|---|---|---|
| MinIO | 0.5 | 768 MiB |
| 文件转写协议 fixture | 0.25 | 256 MiB |
| 本机 TCP 转发 | 0.25 | 128 MiB |

容器上限合计为 8.75 CPU／8,448 MiB，不含宿主 Vite／Chromium；每容器 256 PID，不代表独占资源或生产容量。后端新增消费实际默认队列的 prefork worker，与 control／processing／identity 消费者及真实 Beat 同时运行；没有 eager 执行、任务函数替换或人工调用处理函数。

## 修正与验证

准备过程中修正验收问题：内部网络不实际发布宿主端口，以及虚拟页面 JSX 未转换；单声道用例未触发衍生文件路径，改用双声道覆盖预检和版本固定；组合页误读旧版逐字稿接口，改按实际导入原文接口读取。组合页还需在同一账号／记录的数据重取期间保留编辑组件，才能核验打开时冻结的 revision；人工覆盖姓名会正常取消旧识别上下文，完成检查据此核验取消原因及已确认建议，而不是要求旧任务仍为 succeeded。

前四次未通过的运行分别为 `vp-full-rtc-6a5241bb15`、`vp-full-rtc-694fa80133`、`vp-full-rtc-3edcc6130f`、`vp-full-rtc-8fb7d13718`；不计作整链通过证据，每次均回收其自建资源。没有为适配验收修改应用算法。

19 项探针 unittest 通过，覆盖镜像固定、来源边界、默认关闭匹配、显式 Web 入口、本机端口、失败清理、签名对象 URL 边界／禁止重定向、人工覆盖后的旧任务取消，以及 Windows 浏览器超时后的所属进程树回收。Ruff、格式检查和 Node 语法检查通过。最终浏览器与资源结果以上节回执为准。

私有运行产物位于 `work/voiceprint-local-import-web-2026-10-11/`，不纳入 Git；包括聚合状态、运行日志、资源快照和浏览器截图。一次性配置、Cookie、密钥和合成音频放在独立临时目录，运行结束移除；报告和代码不包含真实访问密钥或签名音频 URL。

## 后续边界

真实 Qwen ASR 的测试配置和云端可读取隔离存储明确后补；真实云端转写、多人分人、真人实名匹配精度、未知人拒识、设备覆盖和门限校准尚未通过。本次单说话人合成工程联通不能替代这些结论。

生产开关保持默认关闭，没有生产部署。ECS 完整链路、物理 Web／Android、TURN／E2EE／CNI、长期容量与端到端 P95 继续按[交付准入](voiceprint-delivery-audit-2026-10-11.md)补验；监控系统仍等待监控 ECS 到位。
