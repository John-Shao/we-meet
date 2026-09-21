# ASR 持久阶段诊断（2026-09-21）

独立专项，不占共享批次号。前置生产版本为 Helm 391：backend `0ccbd5e85`、agents `696a7768f`。本文件记录新增实现，发布前不标记生产验收通过。

## 行为与存储

新增 `CaptureTranscriptionJob.diagnostics` JSON 字段（迁移 `0188_capture_diagnostics`），与不可变 finish 回执分开。已接收的记录不依赖 Pod 日志；新进程/新 Pod 可通过数据库和既有转写状态 API 查询。只存 stage、code、elapsed_ms，不存原文、对象键、签名、供应商响应或异常消息。

- 每个 job 最多 20 条不同 stage/code 的首次观测；重复报告保留原耗时，不增加条目。超过容量不继续增长，不宣称记录全部重复错误。
- 15 个已知阶段覆盖 manifest、control、读取/校验、对象存储准备/上传/签名、转写提交/轮询、结果获取/解析、文字回传、清理、finish 与 execution 兜底；代码仅 failed/timeout/no_speech。
- 创建时间起 30 天保留，重复回报不能续期；过期立即从读取投影隐藏并拒绝新写，既有 ASR tick 每批最多清理 100 个历史字段。部分索引 `capture_diag_retention` 支持扫描非空旧记录。数据库物理清理依赖 tick 运行，并非整点删除承诺；删除任务随原有级联策略删除历史。
- 任务 owner 读取继续经过原录音所有权/成员及当前可见性校验；知道 job UUID 或持有普通登录态不能写。内部 agent 凭据还必须匹配该任务不可变 worker_id。拒绝未领取任务和错误 worker。
- 允许已领取任务在取消/终态后报告故障，以保留回传错误；不更改状态、租约、原文、计费、finish_hash、report 或 updated_at，不让迟到诊断使取消任务复活。
- 两级严格 serializer 拒绝额外字段及未知阶段/代码；读取再投影白名单，过滤异常数据及未来未知字段。

## Worker 协议与故障边界

新 backend 在 claim 返回 supports_diagnostics=true。新 agents 只在该能力被明确声明时写入独立 `/diagnostics/` 端点；旧 backend 不会收到新增端点请求，finish 回执格式不变。

根因和清理故障在 finish 前尝试持久化；finish 失败再尝试上报 finish 阶段，随后仍向上抛出并停止 worker，不领取下一任务，也不重放供应商音频。每次诊断写单次请求、最多等待 4 秒；记录失败只发固定文本日志并带 job UUID，不覆盖原始根因。取消继续抛出 CancelledError，不编造为供应商故障。

**这是有界、尽力送达的持久历史，不是保证送达的消息队列。** 后端不可达、数据库不可写或进程在上报前被强杀，可能没有历史；没有历史不能推断成功。未引入无限重试或本地保存会议内容。live 共用执行生命周期可持久化已分类故障，但实时供应商内部仍可能归 execution；上传转写不是本次协议覆盖范围。

## 运维读取

原命令保持可用：

```bash
python3 deploy/aliyun/check_capture_transcription.py --job <新任务UUID> --worker-logs
```

回执报告新增 diagnostic_history：retained、empty_or_not_reported、expired、not_supported；只输出白名单阶段。旧版本数据库模型无字段时显示 not_supported；新字段为空不等于任务无故障。当前/上一次 Pod 的有界日志继续作为补充，不反写旧历史。

## 验证与验收

- Backend：50 项通过（含 9 项无语音兼容回归）。真实测试 PostgreSQL 迁移及权限、错误 worker/普通用户拒绝、跨账号读取隔离、重复/限量、30 天过期及 tick 清理、取消后迟到回报、读取未知字段过滤；重载模型/新 APIClient 验证不依赖内存。sealed/live 原有生命周期回归同时运行。
- Agents：47 项 sealed/live、filetrans、故障注入回归，包含根因先于 finish 保存、finish 不确定仍停止、诊断网络失败不覆盖终态、取消不伪造故障及旧 capability 兼容。
- 运维探针：8 项计数/日志/持久历史投影回归。
- makemigrations --check --dry-run 无差异；Ruff 和 whitespace 检查。

部署依赖：先发布 backend，确认迁移 0188 已应用，再发布 agents。无需 frontend/summary 或业务开关变更。回滚保留新增字段即可；旧 agents 不发送诊断，新 agents 对不声明能力的旧 backend 不调用新端点。在途上报遇回滚失败只记固定日志，原 finish 流程继续。

部署后对独立新静音和普通语音各显式转写一次：静音应持久记录 transcription_poll/no_speech，同时仍为 incomplete/no_speech_detected；正常语音成功且无失败历史。以新 worker/后端进程读取验证历史仍在，不对生产业务故意注入存储破坏或杀死任务。其他阶段以本地故障注入为证据，不能伪称生产全阶段验证通过。

## 其他质量事项

Helm 391 纪要预算历史约束已完成定向生产复核，详见[纪要事实报告](miaoji-summary-fact-quality-2026-09-21.md)。Unknown speaker 占位责任人仍出现，条件性语句事实化和否定遗漏仍待改进；ASR 术语/原语言、真实多人标注样本及 App 画面也未关闭。专项整体仍未完成。


## 固定版本交付

代码 `4ee18439e` 已提交并推送；从该 Git archive 构建，隔离其他窗口的未提交改动。backend/agents production 镜像均已推送，统一 tag **4ee18439e**。agents 默认 Debian 软件源出现 HTTP 500/下载停滞后终止该构建，使用项目支持的 `APT_MIRROR=mirrors.aliyun.com` 构建成功。锁定依赖未改动。

| 镜像 | Registry digest |
|---|---|
| meet-backend | `sha256:b06a7507a6b8a53cb26d50a73a32eff2ea5144bf9ed08e38f411c9bb8c3eeae4` |
| meet-agents | `sha256:c1288b2223e3648d6c0d1759aff982b392687d1c1308ed01ce2c53266fa91f64` |

本地共 105 项相关测试通过；生产 agents 镜像在禁网 Linux 容器另复跑同一组 47 项通过，不重复累加。backend 迁移在新的独立 PostgreSQL 测试库完成；makemigrations 检查无未提交模型差异。

生产主机顺序执行，第一步成功后再执行第二步：

```bash
bash deploy/aliyun/release-meet.sh --tag 4ee18439e backend
bash deploy/aliyun/release-meet.sh --tag 4ee18439e agents
```

当前停在部署依赖；生产新静音/正常语音及持久历史读取尚未验收。后续文档提交不需要新镜像，继续使用固定 tag。


## Helm 392 更新

用户提供 2026-09-21 19:04:10 Helm 392 回执，backend/agents 实际 tag 为 `2651b6afa`，与实现提交运行代码一致。新静音已在 owner API 读取到持久 transcription_poll/no_speech 6458ms，普通语音成功；跨账号读取拒绝、独立登录复读不变。详见[本轮验收](miaoji-summary-semantics-2026-09-21.md)及[原始证据](evaluations/miaoji-asr-production-392.json)。本次未强制重启 Pod、未等待实际 30 天，也未注入生产其他阶段故障；不扩大验收范围。
