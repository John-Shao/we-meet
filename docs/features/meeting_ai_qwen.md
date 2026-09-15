# 会议 AI：统一入口与 Qwen

## 用户入口

- 实时字幕继续保留；房间侧栏改为「问本场会议」，点击后展开，可一键提问讨论总结、结论和待办。
- 单份实录／纪要保留原有问答及来源引用。
- 移除 Web「我的会议 AI」悬浮窗；会议首页、实录与智能纪要提供 AI 搜索入口。
- Web 与 Android 的全局 AI 搜索支持「会议与录音」范围及开始／结束日期。只有点击提问才调用模型，修改范围会取消请求并清除旧答案。
- 搜索覆盖在线会议、独立录音和上传录音的已发布原文及最新纪要。人工修订优先于 AI 稿；来源链接打开对应实录、AI 版本或人工纪要。权限撤销会终止回答并清除客户端内容。

## 模型配置

| 用途 | 模型／配置 |
| --- | --- |
| 实时字幕 | `qwen-audio-3.0-asr-flash-streaming` |
| 非实时整段转写（包括上传文件） | `qwen-audio-3.0-asr-flash-filetrans` |
| 纪要、本场问答、实录问答、全局 AI 搜索 | `MEETING_SUMMARY_MODEL=qwen3.8-flash` |
| 字幕向量 | `QWEN_EMBEDDING_MODEL=text-embedding-v4`，1024 维 |
| 入会语音／视频 AI 助手 | Qwen-Omni；会议目录和启动接口均拒绝旧 Doubao 配置 |

文本及向量调用使用 `DASHSCOPE_API_KEY` 和 `MEETING_SUMMARY_BASE_URL`（默认百炼北京 OpenAI 兼容接口）。旧 `ARK_*`、`DOUBAO_*`、`GLOBAL_ASK_LLM_ENDPOINT` 不再决定这些会议调用。普通问答和 JSON 纪要关闭 Qwen 思考模式。

旧 summary 服务使用 `LLM_MODEL=qwen3.8-flash`、百炼 `LLM_BASE_URL` 及独立 `DASHSCOPE_API_KEY`。即使旧 secrets 文件仍有 `LLM_API_KEY`，Qwen 路径也不会读取这把旧钥匙。Helm 为 summary 和各 summary worker 复用 `meet-ai-credentials`。

## 旧索引和上线

- 仅同一 `embedding_model` 的向量参与相似度比较；模型名也隔离查询向量缓存。
- Doubao 旧向量仍保留在数据库，旧字幕通过关键词检索继续可用。新实录／上传原文及纪要按实时权限做关键词召回，无需向量重建即可搜索。
- 历史字幕向量重建是显式、计费操作，不在迁移或发布过程中自动执行。先在目标环境查看范围：

  ```sh
  python manage.py backfill_embeddings --all --dry-run
  python manage.py backfill_embeddings <session-uuid> --dry-run
  ```

  确认范围和费用后去掉 `--dry-run`。该命令只处理已有 session 字幕索引，不创建录音原文或重新转写文件。
- 旧个人问答 API 暂留供旧客户端兼容，默认模型同样为 Qwen；新界面统一使用 `search/ask-stream/`，请求增加 `scope`（`all`／`meetings`）和可选 ISO 日期 `date_from`／`date_to`。
- 部署需要发布 backend、summary、frontend 镜像及 Android 客户端，并使用本次 Helm values。验证环境不发起真实模型调用，也不重建线上索引。

接口参考：[百炼兼容接口](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)、[文本向量 API](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api/)。
