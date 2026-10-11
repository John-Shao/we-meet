# 强制独立日志门禁下的完整 RTC 走查

日期：2026-10-11（Asia/Shanghai）。分支：`feature/speaker-identity-voiceprint`。接续[独立日志提交与恢复门禁](voiceprint-journal-gate-review-2026-10-11.md)，验证真实 RTC、API、Beat、prefork 消费者和 Qwen 编码在新门禁下能够协作。功能继续默认关闭，未发布生产。

## 本次改动

旧完整 RTC 探针使用日志门禁接入前的后端配置，不能证明新运行配置可用。本次让 `run_voiceprint_rtc_probe.py` 在原隔离网络内增加第二个 PostgreSQL 16，安装独立日志 schema 和最小权限 reader／writer 角色，并通过 stdin 传递安装 SQL。日志连接保留 CA、主机名和主节点校验，不使用业务数据库或其管理员角色作为日志客户端。

后端探针要求生产配置的强制门禁。启动时在私有 tmpfs 写入 0600 writer 配置、清除包含私钥的临时进程环境变量，关闭总／采样／匹配开关完成初始检查点，然后恢复本次测试的开关。初始化发生在本人授权、用户声明以及任何采样之前。消费者继承配置文件路径，读取同一配置和主库检查点；没有绕过门禁、手工造许可或直接写模板。

最终状态额外检查门禁仍可用且日志 sequence 已推进，防止链路只是使用初始化零状态。匹配开关保持关闭，本次不验证真人实名匹配效果。

## 实际运行结果

同一隔离运行验证了：本人 HTTPS／SessionAuthentication／CSRF 授权、签名 LiveKit webhook、真实派发、原生 Opus／PCM 采样、逐轨许可、Beat 调度、prefork 编码／质检、Qwen speaker encoder 及本人确认后的加密基准模板。

最终聚合结果：

| 证据                               | 结果                                                |
| ---------------------------------- | --------------------------------------------------- |
| 实际房间实例／已结束会话           | 5／5                                                |
| 签名 webhook 请求／成功            | 52／52                                              |
| 许可／消费／取消                   | 11／3／8                                            |
| 候选／编码成功／质检成功／本人确认 | 3／3／3／3                                          |
| 加密基准模板                       | 1，包含 3 个支持样本                                |
| 原始音频保留／未授权账号候选       | 0／0                                                |
| 日志最终 sequence／门禁            | 12／可用，主库检查点与独立最新头一致                |
| 解除静音后的实际采样恢复           | 本次 2.32 秒，控制版本不变                          |
| 长静音退出后的恢复                 | 本次 17.85 秒，旧回执退出、新派发活跃、控制版本不变 |

已验证未声明及未授权发布者不被订阅；容量占满后真实空派发能恢复；采样中暂停丢弃缓冲且没有第四个候选；原生 mute/unmute、轨道替换、新 participant SID 和房间中断保持许可绑定。重连产生的新连接仍需重新声明麦克风，旧连接查询被拒绝。

driver、backend 和 sampler 正常退出，sampler 无 OOM。运行创建的 8 个容器、唯一 internal 网络、匿名数据库卷和临时凭证由自己的清理流程移除；运行后未发现本次前缀的容器、网络或临时目录。其他既有容器未修改。

探针单元测试 7 项通过，包含日志 schema 安装失败时两个数据库及凭证的清理，以及诊断写入失败／Docker 日志超时仍执行全部清理。四个修改脚本 Ruff 通过。

## 复验与制品

模型包必须是已有校验过的离线 Qwen encoder pack，诊断目录必须在仓库外。只使用本地缓存镜像，无宿主端口：

```text
python deploy/aliyun/run_voiceprint_rtc_probe.py --model-pack <私有模型包目录> --diagnostics-dir <私有结果目录> --backend-image we-meet-backend:voiceprint-journal-control-20261011 --sampler-image we-meet-voiceprint-sampler:idle-20261011 --encoder-image we-meet-voiceprint:feature-20261011 --media-boundaries
```

本次使用的本地制品：

- backend：`sha256:5f0125c589003ec10d12e3bc918e27ec3054d0d3ff853a5b6ce169f9124f5705`。
- sampler：`sha256:6ffc0e48b45a786294e31e749a988c97dfac615bc9cfdb382b610d730f5a0f0c`。
- encoder：`sha256:c68c772feb1a9914bbe1b0f52f89e84051abec61e1a326b98e1782da0ef0063a`。

主库整库恢复、日志故障关闭、备库拒绝及恢复重新声明的独立证据仍见[双库恢复走查](voiceprint-journal-gate-review-2026-10-11.md)，本次健康 RTC 运行不代替这些故障场景。

## 验证边界与剩余工作

Qwen encoder 真实读取模型并编码；语音质检仍使用本地 ASR 协议 fixture，本次 3 次请求，不是云端 Qwen ASR 效果测试。声音和账号均为合成，无真人录音、收费 ASR 或外部模型调用，不计算真人误接受率、覆盖率或污染率。

本次补齐新门禁下的完整合成 RTC 回归，不是生产容量或稳定性统计。实际设备、生产 LiveKit／E2EE／WSS／TURN／CNI、组织部署、独立日志容量／HA／自身恢复、真人授权评测和效果门限仍待验收。自动更新、自动最终姓名及实时识别继续遵守方案中的另行评审条件；Qwen 优先路线保持。
