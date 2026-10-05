# 双语互译延迟基线

双语互译的延迟由网关日志给出，不需要额外的探针进程，也不记录音频、文字或凭据。
本目录只把一段时间窗内的固定阶段日志换算成分位数，用来判断一次配置或镜像变更
是否真的降低了响应时间。

## 指标口径

| 阶段 | 日志 | 口径 |
| --- | --- | --- |
| 识别单次请求 | `language_probe` | 一次分类器往返（含建连或复用待用连接） |
| 方向锁定 | `language_selected` | 本地 VAD 起点 → 转发方向确定 |
| 上游首段译音 | `translation_first_audio` | 本句首帧转发 → 收到首个译音事件 |
| 交付门 | `translation_audio_delivered` | 译音已到网关 → 真正发给手机；`gate_ms` 为等待原文转写确认方向的耗时 |
| 整句就绪 | `speech_end->result_ready` | 本地句尾 → 整句译文（含原文关联）交付完成 |
| 本机整句耗时 | `since_speech_ms` | 同一句从本地 VAD 起点到发出的总时长；跨句重叠时失真 |

`translation_first_audio` 的 p50 已经很小（见下文基线），说明模型是边说边译；
**服务端回合窗口主要影响短句**，因此判断 `TRANSLATION_TURN_SILENCE_MS` 要看
`translation_first_audio` 的 p90/p95 与 `speech_end->result_ready`，不能只看 p50。

## 采集

在能访问集群的机器上执行，`-n meet` 是发布用的命名空间：

```bash
kubectl -n meet logs deploy/meet-agent-capture-translation --since=10m \
  | python src/agents/evaluations/bilingual_latency/summarize.py --json \
  | tee baseline-1000ms.json
```

脚本只用标准库，不需要 `PYTHONPATH` 或 agents 依赖。`--json` 便于两次运行直接对比；
不带 `--json` 时输出便于阅读的分位数表。`evaluations/` 已在 `.dockerignore` 中，
这些文件不会进入 agents 镜像。

## A/B 流程

1. 取基线（当前配置、当前镜像），保存 JSON。
2. 只改一个变量，再取同样时长的窗口：
   - 句尾窗口：`kubectl set env deploy/meet-agent-capture-translation TRANSLATION_TURN_SILENCE_MS=600`
     （验证用；长期生效要写进 `src/helm/env.d/aliyun-prod/values.meet.yaml` 的
     `meetingAIWorkers.workers.capture-translation.envVars`）
   - 识别阈值：`TRANSLATION_LID_PROBE_MS`（调小能提前锁定短句，代价是单词级准确率）
3. 对比 `stages` 的同名指标。判定：
   - `speech_end->result_ready` 或 `translation_first_audio` 的 p90/p95 下降约 300–400 ms
     → 变更生效，保留；
   - 只有 p50 微动或完全不动 → 该字段未被上游采纳，回退，改走协议层方案；
   - 出现 `error_codes` → 立即回退（例如该值不被上游接受会中断新建会话）。
4. 每次变更后读一次 `unknown_utterances` 与 `probe_outcomes`：识别准确率不能靠
   降低阈值硬换延迟。

## 已知边界

- 只有带会话标识（`session=`，8 位十六进制）的镜像才能按会话配对；旧镜像没有该字段，
  脚本退回按日志顺序 FIFO 配对，多方并发时 `speech_end->result_ready` 会失真。
  因此基线应取低峰窗口，或明确记录当时只有一个会话。
- 日志不含会话文本、音频或凭据，因此无法从本目录判断译文质量，只看延迟。
- 方向覆盖必须核对 `locked_source` / `directions`：只有单向样本时，另一方向的
  LID 与路由结论没有数据支撑。
- 网关 `replicas: 1` 且没有 drain，任何 env 变更都会重启该 Pod，进行中的会话会断。

## 已记录基线

2026-10-05 15:44–15:54（`aliyun-dev` 镜像 `97ccf7af` 之前，即 `TRANSLATION_TURN_SILENCE_MS`
默认 1000 ms；单个测试者，方向以中文为主；6306 行日志，无错误码）：

| 指标 | n | p50 | p90 | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `language_probe` | 98 | 354 | 600 | 679 | 1926 |
| `language_selected` | 75 | 856 | 954 | 1510 | 3016 |
| `translation_first_audio` | 67 | 578 | 1243 | 1519 | 2045 |

`probe_outcomes`：classified=75、unknown=23；`locked_source`：zh=71、en=4；
`directions`：zh→en=63、en→zh=4。

这批数据没有 `translation_audio_delivered`、`since_speech_ms` 与
`speech_end->result_ready`（当时脚本尚未采集），也没有 App 侧
`translation_playback_started`（需要新 APK）。发布带会话标识的 agents 镜像后，
应按上面的采集命令补一份完整 JSON 基线再开始翻转。
