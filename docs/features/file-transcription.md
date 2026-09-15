# 录音文件转写

所有非实时音频转写使用阿里云百炼 `qwen-audio-3.0-asr-flash-filetrans`：

| 路径 | 执行方式 |
| --- | --- |
| 会议记录 → 上传录音转文字 | Django 接收文件，Celery Beat 调度异步提交、查询和原文发布 |
| 独立录音结束后转写 | `capture_transcriber.py` 将验证过的 WAV 分片按连续区间写入临时文件，分别提交 Filetrans |
| 旧版会议录音 / summary 转写任务 | summary 服务通过 Filetrans 转写，转换为原有 webhook 的句子、词语和时间戳格式 |

实时字幕、录音中的实时转写继续使用 `qwen-audio-3.0-asr-flash-streaming`。文件模型不读取 `QWEN_ASR_MODEL`，也不使用 WhisperX 回退。

## 用户操作

在 `/meeting/notes` 展开“上传录音转文字”，选择音频或视频文件，按需填写上下文（400 字以内）和行业热词（每行一个，最多 100 个、每个最多 40 字），点击“上传并转写”。默认上传上限为 100 MiB，API 可配置，模型音频时长上限为 12 小时。

上传过程中保持页面打开。上传成功后进入对应记录，转写在后台继续，结果带句子时间戳。当前每个用户最多一个活跃上传转写任务。失败后可明确点击“重新转写”；提交响应丢失时会提示可能产生额外费用。

原文件保存于私有存储。文件名不作为对象路径；客户端不能提交任意 URL 或读取 provider task ID、存储路径和签名 URL。所有原文沿用会议记录权限。上传文件和录后转写保持独立的任务状态，不会影响正在录音的实时转写。

## 后端部署

1. 执行数据库迁移 `python manage.py migrate`（新增 `0179_uploaded_recording_filetrans`）。
2. 后端与 Celery backend worker 配置相同的私有 S3/OSS 存储及区域对应的 `DASHSCOPE_API_KEY`。
3. 设置以下环境变量：

```dotenv
MEETING_RECORDS_ENABLED=true
MEETING_FILE_ASR_ENABLED=true
MEETING_FILE_ASR_MAX_BYTES=104857600
QWEN_FILE_ASR_MODEL=qwen-audio-3.0-asr-flash-filetrans
QWEN_FILE_ASR_REGION=cn-beijing
# 可选：业务空间专属域名，必须包含 /api/v1
QWEN_FILE_ASR_BASE_URL=https://<workspace-id>.cn-beijing.maas.aliyuncs.com/api/v1
# 当默认存储 endpoint 仅集群内可用时，设置可公网访问的同一存储 endpoint。
QWEN_FILE_ASR_STORAGE_ENDPOINT_URL=https://<public-storage-endpoint>
```

4. 启用现有 `CELERY_ENABLED`，运行 Celery backend worker 和 Beat。Beat 每 10 秒调度到期任务，单个任务约每 15–20 秒查询一次，最多等待 24 小时。
5. 网关的请求体上限应大于文件上限（例如 110 MiB），上传超时应覆盖预期文件上传时长。Django 使用磁盘临时文件和分块存储，不将整段音频读入内存；为临时目录预留磁盘空间。

`MEETING_FILE_ASR_ENABLED` 默认关闭；缺少 API Key、私有 S3 存储或 Celery 时不显示上传入口。已有上传原文在关闭新任务开关后仍可读取。

北京默认 API 域名为 `dashscope.aliyuncs.com`，新加坡设置 `QWEN_FILE_ASR_REGION=ap-southeast-1`，默认域名为 `dashscope-intl.aliyuncs.com`。使用专属域名时相应替换 BASE_URL。区域、API Key、存储公网地址必须匹配；内网 MinIO 地址无法供百炼下载。

## 独立录音 worker

同步部署后端和 `capture-asr` worker。后端新建的录后任务标记为 Filetrans；实时任务仍标记为 streaming，worker 按模型和区域领取对应任务。切换前让旧的录后任务完成，或等待其过期后由用户重试。

`capture-asr` 需要以下私有存储配置（支持 Kubernetes Secret 引用）：

```dotenv
QWEN_FILE_ASR_MODEL=qwen-audio-3.0-asr-flash-filetrans
QWEN_FILE_ASR_REGION=cn-beijing
AWS_S3_ENDPOINT_URL=<internal-host:port>
AWS_S3_PUBLIC_ENDPOINT_URL=<public-host>
AWS_S3_SECURE_ACCESS=true
AWS_STORAGE_BUCKET_NAME=<private-bucket>
AWS_S3_ACCESS_KEY_ID=<secret>
AWS_S3_SECRET_ACCESS_KEY=<secret>
```

Agent 的 MinIO endpoint 使用 `host[:port]` 格式，两端均使用 `AWS_S3_SECURE_ACCESS` 指定协议。临时对象写入 `filetrans-temporary/`，任务结束或取消时删除；为该前缀配置 2 天生命周期作为进程强制终止后的清理兜底。签名下载 URL 有效期 24 小时。文本保留模式也会临时使用此存储，需采用无版本私有桶，避免删除后保留历史音频。

## 旧版 summary 服务

为 summary/transcribe worker 配置 `DASHSCOPE_API_KEY` 和相同的 `QWEN_FILE_ASR_*` 模型、区域和 API 地址。可通过 `AWS_S3_PUBLIC_ENDPOINT_URL` 为其现有私有录音生成公网签名 URL。该服务使用 Redis Celery result backend 保存 Filetrans 任务 ID，在 Celery 重试时查询原任务。未知提交不会自动再次提交。

原有 `WHISPERX_*` 配置中语言相关字段保留以兼容旧调用方；模型、API key 和 base URL 已不再用于转写。句子、词语时间戳从毫秒转为原接口要求的秒；无 provider speaker ID 的文本保持未知说话人。默认转写第 0 音轨，不额外开启多音轨计费或说话人分离。

## 验证与接口依据

自动化测试覆盖上传权限/限制/幂等、异步任务防重、失败重试、原文原子发布、录后和实时 worker 分离、时间戳/词语格式以及前端上传/重试。测试使用模拟 provider 响应，不产生模型调用费用。上线前用合成录音验证配置区域、对象存储公网可达性和真实模型权限。

协议依据：[百炼 Filetrans HTTP API](https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api)。提交使用 `input.file_urls` 和 `X-DashScope-Async: enable`；上下文使用 `input.context`，即时热词使用 `parameters.vocabulary`。
