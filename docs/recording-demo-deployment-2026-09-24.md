# we-meet 开发与演示录制部署

部署日期：2026-09-24。服务器：`36.151.142.132`，4 vCPU / 16 GB。

本部署用于单路开发与演示。测试负载为一个合成参会者，同时发布摄像头、屏幕共享和音频；不代表多人会议或多场会议并发的容量结论。

## 已部署配置

| 项目 | 配置 |
|---|---|
| Kubernetes namespace | `meet` |
| Egress release / Deployment | `recording-egress` / `meet-livekit-egress` |
| 官方 Helm chart | `egress` 1.8.4 |
| Egress 镜像 | `jusi-cn-guangzhou.cr.volces.com/we-meet/livekit-egress:v1.14.1` |
| 后端镜像 | `jusi-cn-guangzhou.cr.volces.com/we-meet/meet-backend:23b302061-recording-98a45accc0` |
| Egress 实例数 | 1；更新策略为 Recreate |
| 请求资源 | 2 CPU / 4 GiB 内存 / 1 GiB 临时磁盘 |
| 资源上限 | 3 CPU / 6 GiB 内存 / 8 GiB 临时磁盘 |
| 画面 | 1280 × 720，15 fps，H.264，视频目标 900 kbps |
| 音频 | AAC；配置目标 64 kbps，实测文件约 128 kbps 双声道 |
| 录制限制 | 全局最多 1 场；单次 30 分钟；单文件限制 512 MiB |
| 存储 | 私有 OSS 桶 `we-meet-video`，`recordings/` 前缀 |
| 文件访问 | 同域 `/media/recordings/…`，每次请求先校验登录身份和录制权限 |

`MEETING_CLOUD_RECORDING_MAX_CONCURRENT=1` 在数据库事务中通过 PostgreSQL advisory lock 防止跨房间同时占用名额。上传期间保留名额；完成保存后立即释放，普通 stopped 状态的保护期为 5 分钟。Egress 自身的 admission 配置还会拒绝第二个任务。

Egress 临时目录使用有大小限制的 emptyDir；完成文件上传至 OSS。`disallow_local_storage=true` 禁止将服务器本地盘作为最终录制目的地。凭据来自 `meet-livekit-egress-config` Secret，不写入仓库。

## 本次修复

- 阿里云 OSS 采用 LiveKit 原生 `AliOSSUpload`，避免 S3 强制路径风格上传被 OSS 拒绝。
- 由签名验证通过的 LiveKit 完成事件触发落库，并检查会议实例、worker、文件路径和 OSS 对象大小后标记 saved。
- 兼容当前 LiveKit Python SDK 不带分页字段的 ListEgress 接口，保留新版分页支持。
- 启用录制媒体 Ingress：权限校验成功后由 Nginx 使用后端签名访问私有 OSS。匿名请求被拒绝。
- 开启全局单路限制，保留现有命令幂等重放和停止录制能力。

## 使用

1. 在 `https://meet.we-meet.online` 登录并进入有控制权限的会议。
2. 发起视频录制；另一场录制占用资源时等待其结束。
3. 停止录制后等待文件上传完成，状态变为已保存后下载。
4. 单次到达 30 分钟会结束录制。需要继续录制时，待文件保存完成后重新发起。

本次测得上传阶段服务器出口约 4 Mbps，137.5 MB 测试文件保存等待约 5 分钟。录制到时停止采集后，上传期间状态可能暂时仍显示录制中；请等待已保存状态。等待时间随文件大小和可用带宽变化。

## 再次部署 Egress

服务器仓库为 `/root/we-meet`。脚本要求 Python 3、PyYAML、Helm、k3s，以及现有后端和 LiveKit 配置。

```bash
cd /root/we-meet
sudo python3 deploy/aliyun/install-recording-demo.py \
  --chart /root/we-meet-recording-deploy-20260924/egress-1.8.4.tgz
```

脚本会在发现当前录制名额被占用时退出，避免重建正在录制的 worker。它核对固定 chart 版本，从 Kubernetes 读取现有凭据，生成 Secret，然后带 post-renderer 安装 Egress。后续更新应用时，应保留本次后端代码修复及 `values.meet.yaml` 中的编码、并发和媒体路由设置。

## 监控与验收

```bash
sudo k3s kubectl -n meet get deployments
sudo k3s kubectl -n meet top pods --sort-by=cpu
df -h /
free -h
sudo helm history meet -n meet
sudo helm history recording-egress -n meet
```

建议演示前检查可用磁盘不少于 15 GiB、可用内存不少于 4 GiB；持续 CPU 超过 80%、出现 throttling 或影响会议质量时，应降低负载或将 Egress 迁至独立主机。上述数字是保守运维阈值，未设置外部告警通知。

测试使用专用受限会议及不可密码登录的测试用户，不使用真实会议内容。验收完成后已删除测试用户、会议及三个测试录制对象（含首次失败任务对应的空对象键），保留检查记录。

### 实测结果

- 41 秒短录制：开始、手动停止、OSS 上传、saved 落库、完整 MP4 解码、画面抽帧均通过。
- 30 分钟测试：北京时间 11:20 左右开始；11:50:33 到达时长限制自动结束，最终 `EGRESS_LIMIT_REACHED` / `saved`。这里的 `Session limit reached` 是预期的时长限制结果，文件正常保存。
- 长文件：137,500,948 字节（约 131.1 MiB），MP4 时长 1799.203 秒，H.264 1280×720 / 15 fps，AAC 48 kHz 双声道；首段、中段和尾段均成功解码。
- 网站读取：有权限用户元数据 200、首尾 Range 请求 206；未登录请求 401；直接匿名访问 OSS 对象返回 403。
- 并发限制：录制期间再次发起请求返回 409 `recording_capacity_reached`；直接向 Egress 发起第二个任务也被拒绝。
- 相关自动化回归共 154 项通过（150 项首次通过，4 项在补齐本地 MinIO 测试环境后重跑通过）；修改的后端文件 Ruff 检查通过。

| 测量 | 结果 |
|---|---|
| 录制 worker 平均 / 峰值 CPU，Egress 进程统计 | 0.55 / 1.55 核 |
| 容器内存工作集采样峰值 | 823 MiB |
| Egress 进程 RSS 统计峰值，与工作集口径不同 | 约 1.46 GiB |
| 录制阶段整机 CPU 采样均值 / 峰值 | 29.5% / 57.52% |
| 可用内存采样最低值 | 8853 MiB |
| 可用磁盘采样最低值 | 59.75 GiB |
| CPU 限流 / 视频输入队列丢帧 | 0 / 0 |

整机数据为北京时间 11:23:43–11:50:07 的 53 个约 30 秒间隔样本；不覆盖所有瞬时峰值。该结果支持当前单路开发演示配置，未验证多人会议、高动态画面或生产并发负载。

服务器验收记录：`/root/we-meet-recording-deploy-20260924/deployment-validation.json`、`soak-metrics.jsonl`。本地短样本位于工作区 `work/recording-validation.mp4`。

## 备份与回退

部署前备份保存在 `/root/we-meet-recording-deploy-20260924`（目录 0700、文件 0600），包含原 Helm values、manifest、工作负载和历史版本信息。备份包含部署凭据，不应公开或加入版本库。

本次部署前 meet revision 为 413。需要回退时先停止录制并确认上传结束，再执行：

```bash
sudo helm rollback meet 413 -n meet --no-hooks --wait --timeout 5m
sudo helm uninstall recording-egress -n meet
```

先用 `helm history` 确认 revision 413 仍存在；历史版本可能在后续发布中被清理。若已清理，应根据备份 values 和对应原 chart 恢复，而不是猜测其他 revision。回退不会删除已经写入 OSS 的录制文件；源代码与生产 values 也需要根据此次变更单单独恢复，避免下次发布再次带入。
