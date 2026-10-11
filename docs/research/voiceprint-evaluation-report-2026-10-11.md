# 声纹评测结果汇总工具

日期：2026-10-11。分支：`feature/speaker-identity-voiceprint`。

新增 `deploy/aliyun/voiceprint_evaluation_report.py`，为方案第 15 节提供离线、可复现的指标汇总。它读取已经取得的查询结果，不读取数据库、不执行 Qwen 编码、不生成门限、不修改任何生产开关。暂无获授权真人样本；本轮验证全部使用合成结果，不能证明 Qwen 的身份识别效果。

后续[Qwen 离线执行器](voiceprint-evaluation-runner-2026-10-11.md)已实现预处理 PCM 的真实提取、生产核心匹配、校准网格与独立测试。该执行器复用此汇总契约；本文件所述 CLI 仍只汇总外部结果。标准库实现移至 `src/backend/core/services/voiceprint_evaluation_report.py`，原 deploy 路径保留兼容入口。两个工具均不批准生产发布或生成生产门限。

最新[按人／会话区间走查](voiceprint-cluster-uncertainty-review-2026-10-11.md)已补充各指标两种整组 bootstrap 敏感性区间，少组、零分母、无组间变化或超预算返回 null；Windows／Linux 各 15 项报告测试、23 项执行器回归及新镜像 CLI／真实 Qwen 合成联调通过。以下原始阶段的“仅分组描述、尚无分组区间”是历史边界；当前输出、假设与制品以上述走查为准，联合人／会话相关性仍未估计。

## 执行

从 `we-meet` 根目录运行，无第三方依赖：

```powershell
python -m deploy.aliyun.voiceprint_evaluation_report --input D:\private-evaluation\results.json --output D:\private-evaluation\report-new.json
python -m unittest deploy.aliyun.test_voiceprint_evaluation_report -v
```

输入限 8 MiB、1,000 个会话、10,000 个说话人查询，每次最多 50 个候选。输出路径必须不存在；POSIX 新文件权限为 `0600`，Windows 继承目录 ACL，应使用私有目录。成功只输出固定消息；失败不回显姓名、路径或输入内容。

报告包含输入原始字节的 SHA-256、数据集摘要、门限版本及门限文件摘要，可与独立保存的制品核对。输入、授权文件、人工真值和音频留在私有目录，不提交仓库。汇总报告不包含人员／会话／查询标识、音频摘要、候选名单、姓名或向量。

## 输入契约

以下为**合成协议示例**，摘要均为占位值，不能当作真实评测结果或生产门限：

```json
{
  "schema_version": 1,
  "origin": "synthetic",
  "authorization_reference_sha256": null,
  "feature_space": "qwen3tts-speaker:2ce8c66530f607837b8cdb4f95ce4a359bfee604dc2a2731adc46b89866c5df5",
  "threshold_version": "synthetic-only-v1",
  "threshold_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "dataset_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "sessions": [
    {
      "session_id": "session01",
      "split": "enrollment",
      "subjects": ["subject01"],
      "recording_sha256": [
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      ]
    },
    {
      "session_id": "session02",
      "split": "calibration",
      "subjects": ["subject01"],
      "recording_sha256": [
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      ]
    },
    {
      "session_id": "session03",
      "split": "test",
      "subjects": ["subject01", "subject02"],
      "recording_sha256": [
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      ]
    }
  ],
  "queries": [
    {
      "query_id": "query01",
      "subject_id": "subject01",
      "session_id": "session03",
      "recording_sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "audio_sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "start_ms": 0,
      "end_ms": 30000,
      "condition": "near",
      "eligible": true,
      "candidate_subjects": ["subject01"],
      "status": "suggested",
      "predicted_subject_id": "subject01"
    },
    {
      "query_id": "query02",
      "subject_id": "subject02",
      "session_id": "session03",
      "recording_sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "audio_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "start_ms": 30000,
      "end_ms": 60000,
      "condition": "far",
      "eligible": true,
      "candidate_subjects": ["subject01"],
      "status": "unknown",
      "predicted_subject_id": null
    }
  ]
}
```

所有 subject／session／query 标识使用匿名稳定 token，格式为 1～64 位 ASCII 字母、数字、下划线或连字符。`sessions` 是实际会话，不能把同一录音的切片重命名成多个会话；每个录音摘要只属于一个会话及一个 split。登记和校准人员允许相同，最终查询必须来自独立 test 会话。未登记访客也列入对应会话的 `subjects`。

一条 `queries` 代表一次说话人查询，包含多个匹配片段时仍只计一次；不能逐向量对填写。`subject_id` 是人工校对的真实说话人；`candidate_subjects` 是当次实际已授权且具备模板的候选，不得用完整通讯录替代。`eligible` 来自独立质量／语音足量检查，不能按匹配成功与否倒推。`start_ms/end_ms` 是查询来源跨度，允许到两小时；同一录音同一真人的查询跨度不能重叠。混合说话人和分人准确性需另行评测，不能编造单人真值。

`audio_sha256` 应由评测生产者对查询所用的规范 PCM 内容／有序片段集合生成。工具拒绝重复摘要，但不读取音频验证摘要，不能检测重新编码、错误摘要或分人切片跨集合等全部泄漏。完整原始录音摘要也必须由独立数据整理过程核验，不能仅凭此工具断言数据隔离已经通过。

`status` 只接受生产匹配器的六种状态：`suggested`、`unknown`、`ambiguous`、`insufficient_audio`、`mixed_speaker`、`unavailable`。只有 `suggested` 可填写候选中的 `predicted_subject_id`，其余必须为 null。`origin=authorized_human` 要求填写私有授权资料摘要；该字段仅为可追溯声明，工具不替代参与者授权核查。`feature_space` 限当前固定 Qwen 空间，后续模型需要另行扩展。

## 统计与解释

- 建议精确率：正确建议／全部建议；错误实名计入分母，没有建议时为 null。
- 未知误接受率：真实人物不在当次候选中却获得建议的查询／所有候选集合外查询。包括已在其他集合登记但不在当次候选的人；拒绝、不可用等状态仍列入该分母。
- 覆盖率：已在当次候选内且 `eligible=true` 的查询中，获得正确建议的比例；近场与远场分别计算，失败／不可用保留在分母。
- 人／会话分组：各组样本量范围、组内率范围、组率等权平均，并同时保留整体查询加权率。人员总量、实际测试人数、登记人数、校准人数和最少会话数分别报告；另列未参加校准的人数与从未登记／校准的未知访客数。

每个比例同时报告分子、分母及 Wilson 双侧 95% 区间，公式依据 [NIST](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)。该区间明确采用独立二项假设，不能直接覆盖同人／同会话相关性；分组范围是描述性统计，**不等于分组置信区间**。300 次零误接受的双侧 Wilson 上界约 1.26%，仍非零风险。方案中的约 1% 是独立假设下单侧上界，两者不能混用。

报告始终 `release_ready=false`。尚须外部验证真人授权和人工真值、实际 Qwen 推理及完整链路、按人／会话分组的不确定性、污染样本量、分人效果、端到端延迟、权限／删除和设备验收。`human_results_declared` 只是输入声明，不能当作真实性认证。此工具也不判断 Qwen 不合格或触发 CAM++ 切换。

## 本轮验证

Windows 和隔离 Linux 容器各 9 项单元／CLI 测试通过，覆盖分母定义、近远场拆分、零分母与零错误区间、候选集合外查询、授权声明、跨集合／重复音频／重叠查询拒绝、分组权重、汇总隐私及禁止覆盖已有报告；Linux 还验证输出文件权限为 `0600`。容器以 UID 10001、只读文件系统、无网络执行并自动移除。Ruff 检查和格式检查通过。文档中的完整 JSON 示例经实际 CLI 成功生成汇总，`origin=synthetic`、`release_ready=false`。测试及 CLI 示例全部是合成协议数据；没有真人准确率结论。
