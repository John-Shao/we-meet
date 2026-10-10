# RTC 空闲退出与首次订阅竞争走查

日期：2026-10-11（Asia/Shanghai）。接续[解除静音与许可终态](voiceprint-rtc-autounmute-review-2026-10-11.md)，保持 Qwen 优先、业务默认关闭及完整验收范围。仍使用合成用户和音频、真实 LiveKit／HTTPS 后端／签名 webhook／Beat／消费者／Qwen encoder，ASR 为本地协议 fixture；未使用真人或生产环境。

## 长时间静音的实际失败

原生发布者在实际采样后静音，等待 sampler 按原有 30 秒空闲期限自然退出，不重启服务。sampler 已空闲、就绪，但同作用域派发仍报告 running job。随后只解除静音，控制版本不变；25 秒和 75 秒观察均无新许可或采样，旧派发在最后检查中已经 108 秒，仍显示 running。

基线运行明确以 `rtc_media_probe_runtime_sampling` 失败退出并清理环境。终点为 5 个会议实例（4 个已结束）、45 次签名 webhook／45 次成功、9 个许可（3 个已消费、6 个已取消）、3 个确认候选／1 个加密模板／3 个支持样本及 0 份原始音频。许可来源一致，没有失败片段入库；这些数据不是一次通过的完整验收。

LiveKit 同版本实现中，房间派发查询返回房间持有的 job 副本，worker 另行持有并更新 job 状态；agent 离开房间不直接改写该派发快照。修复依据是[房间实现](https://github.com/livekit/livekit/blob/v1.13.1/pkg/rtc/room.go)和[worker 实现](https://github.com/livekit/livekit/blob/v1.13.1/pkg/agent/worker.go)。worker 开始时间为 Unix 纳秒；已核验同版本，不根据数值位数猜测时间单位。

## 修复边界

后端不再无限信任已有 running 快照。只在全部活跃 job 均为 running、参与者身份明确、已知开始时间超过 30 秒启动宽限期时查询真实参与者。只要任一对应身份仍在房间内，继续复用；有 pending、新启动、未知／未来时间或缺少身份的任务保持复用，不因缺少证据取消启动。

确认离线后，重新读取同一派发并重新查询实际参与者；重新上线、新 job、作用域变化或查询失败均阻止删除。删除前再次核验 room SID，创建前也重新核验 room SID，避免回执消失或变化时向复用的业务房间名写入旧实例派发。每个既有 5 秒 RPC 批次最多清理一个空／离线回执；超时取消请求、关闭客户端并进入固定错误和持久重试，日志不包含参与者列表。

sampler 的首次复核移入有效许可的终态清理范围：签发返回后或首次验证等待中发生静音／连接变化、验证异常或取消，即使尚未订阅，也会尝试发送 stopped 回执。此时不订阅、不上传、不延长空闲期限；原有有界 HTTP 请求、后端授权与配额检查仍生效。网络不可用时回执可能失败，不能据此宣称任何故障下均即时取消许可。

## 专项验证与制品

- 111 项后端派发／许可活动组合回归通过（37.41 秒）：62 项派发和 49 项活动恢复。覆盖 29／30 秒边界、实际在线身份、其他参与者、pending／混合任务、未知／未来时间、再次读取时回归在线／新启动、作用域或房间变化、超时取消、每批清理上限及创建前房间复查。
- Windows 31 项 sampler／runtime 测试通过（5.356 秒），Linux verification 镜像同 31 项通过（4.329 秒）。新增竞争测试覆盖签发返回后静音、初次复核时静音／连接替换、验证异常和取消；证据不替代真实麦克风竞争验收。
- 六项探针清理／许可绑定验证测试通过（0.136 秒）；修改源码的 Ruff／格式及差异检查通过。

完整后端制品 `we-meet-backend:voiceprint-idle-20261011`：本地镜像 ID `sha256:a6d8db4abfcdad4bca216e4ea2ca9b96c13f669f57bcee86b19a1ea7573c3d5f`，216,666,862 字节，UID 10001:0。派发文件 SHA-256 `4eb4ab65774c70578fda9596221579c9e994762b0cad792a6a3031c8f50b1df5`，源码与镜像内一致。

生产 sampler 制品 `we-meet-voiceprint-sampler:idle-20261011`：本地镜像 ID `sha256:6ffc0e48b45a786294e31e749a988c97dfac615bc9cfdb382b610d730f5a0f0c`，143,511,075 字节，UID 10001:10001。sampler 文件 SHA-256 `e09366fb8893bf439d552149db4a8fe778d81cb7f19dcbaaf7c57170ef8dda4f`，源码与镜像内一致。未推送镜像或部署生产。

```powershell
docker build --target backend-voiceprint --build-arg DOCKER_USER=10001:0 `
  -t we-meet-backend:voiceprint-idle-20261011 .
docker build -f src/agents/Dockerfile.sampler --build-arg APT_MIRROR=mirrors.aliyun.com `
  -t we-meet-voiceprint-sampler:idle-20261011 src/agents
python deploy/aliyun/run_voiceprint_rtc_probe.py --media-boundaries `
  --model-pack D:/private/encoder-pack-v1 `
  --diagnostics-dir D:/private/voiceprint-rtc-diagnostics
```

## 验收范围

第一次修复后运行已经出现实际采样及第 10 个许可，但停在包含旧回执退出、新派发活跃、控制版本及候选数量的组合检查，尚未完成全部链路；没有分项诊断，不能断言是哪一条件失败。源码允许保留已结束 job 的历史回执，probe 现明确接受缺失、删除或全部 job 为 success／failed 的旧回执；不接受空 job 列表或 pending／running。新增固定聚合诊断记录旧 job 状态，再独立要求不同 ID 的新派发已有活跃 job。先前没有记录旧回执精确状态，不能把那次失败解释为已验证的终态分支。

后续诊断确认旧回执已经不存在，但组合检查仍未通过；另一次运行在初次选取 job 时提前失败，没有进入长时静音。最终探针改为在实际采样证据后立即再次静音，防止等待时产生第四个候选，前后两次 job 查询均设 8 秒上限。日志只输出固定状态、枚举及本探针失败行号，不打印 SDK 错误文本／私有字段。最终实际观测到新派发的第一次查询 `jobs=[]`，随后在期限内出现活跃 job，验证了异步可见性窗口；不把先前未通过的运行计作完整成功。

扩展探针在原五实例链路内增加自然空闲退出后的恢复：要求旧派发已退出、新派发实际取得 job、新许可对应真实采样、控制 revision 不变，且候选仍只有三个。随后继续同账号新连接声明和房间中断；正常退出、原始音频及全部自建环境的实际清理仍是必需检查。

最终完整运行通过。自然空闲退出时旧快照仍为 running；仅解除静音后，新许可带来实际采样，旧回执不存在，不同 ID 的同作用域新回执最终带有活跃 job，控制 revision 不变。恢复与派发证据检查合计 17.95 秒，包含元数据复查等待，不是纯采样启动延迟或性能统计。再次静音只用于停止验证片段，不参与恢复触发。实际观测的旧回执终态为缺失，不能把该结果解释为遍历了保留 success／failed 回执的所有时序。

最终 5 个已结束会议实例、52 次签名 webhook／52 次成功、11 个来源及终态规则一致的许可（3 个已消费、8 个已取消），仍只有 3 个确认候选／3 个编码成功／3 个质检成功、1 个加密 baseline 模板／3 个支持样本、30 秒确认有效语音、0 个未授权用户候选及 0 份原始音频。最终检查时已擦除终态上下文的数量为零，不能据此宣称全部清理时序均已覆盖。driver／backend 正常退出，sampler SIGTERM 正常退出且未 OOM；自建容器、网络和临时凭据已实际清理。不同运行的数据不能合并为容量或稳定性统计。

网络软重连／故障注入、多端同账号、系统／屏幕／翻译音轨、共享设备与回声、真实 Web／Android 设备、获授权真人效果、历史搜索／纪要版本、外部删除墓碑备份恢复及生产 CNI／TLS／容量仍需继续。此次合成信号仅证明边界和技术链路，不证明真人识别准确率。
