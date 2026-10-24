# 第四十九批：手动永久删除启用配置

> 后续状态：用户确认 Helm 383 已发布，启用后预检完整 PASS，三个进程均 `purge_enabled=true`。生产专用记录验收进入[第 50 批](miaoji-batch-50-purge-production-acceptance.md)；下文保留启用批次记录。

## 生产前置已通过

2026-09-21 用户在 `jd-sjy` 执行第 48 批预检并回传完整 PASS：

- `meet-backend-5b6fc8778-8c8jh`、`meet-celery-backend-78f4d9f8fb-plb97`、`meet-celery-beat-74fc975cdc-nwmm2` 均通过指定 tag `d2c791e9d`、完整 rollout、旧 Pod 清场、Ready 和跨组件镜像摘要检查。
- 三者均确认 `0186_record_purge` 已应用、永久删除仍关闭、既有删除意图数为 0，媒体桶 `we-meet-video` 未版本化。
- API 和 worker 各两个随机探针均确认私有且已删除；live worker 已注册删除任务并消费 `meet-backend` 队列，beat 最近实际派发通过。
- 实际直传 TTL 为 **3600 秒**。上传记录受理删除后至少等待这一窗口，不能在几分钟内以尚未完成判定失败，也不为验收缩短 TTL。

存储版本/WORM 及其他实测范围见[第 48 批](miaoji-batch-48-purge-storage-preflight.md)。以上不是用户记录永久删除的生产验收结果。

## 本批变更与验证

生产 values 的 `backend.envVars.MEETING_RECORD_PURGE_ENABLED` 改为 `"True"`。Helm 使用假 Secret 渲染，确认 backend、celery-backend、celery-beat 均继承 True，records/trash/Celery 均保持 True；显式覆盖关闭时三者均为 False。没有应用代码、数据库迁移或 Android 变更。

本批只提交配置，尚未发布到集群。启用仅允许所有者明确确认的永久删除，不自动按日期清空回收站。

## 发布及下一步

复用已经核验的现有 backend 镜像，无需等待本批 SHA 的新镜像：

```bash
bash deploy/aliyun/release-meet.sh --tag d2c791e9d backend
python3 deploy/aliyun/check_record_purge.py --expected-backend-tag d2c791e9d --expect-enabled --storage-canary
```

发布脚本会拉取最新配置，保留 frontend `62fb7904b` 和未选择的 summary/agents 镜像。后一个命令确认三个进程实际打开开关及 worker/存储条件持续满足。

随后以新建、明确可销毁的专用记录验收：所有者确认、跨账号拒绝、取消无写入、受理后不可恢复、上传等待窗口、最终完成、旧访问/上传幂等键不能复建。既有第 30/41/43/45 批回归样本继续保留。关闭开关只能暂停新受理和清理，无法撤销已经受理的意图；不得回滚到缺少上传重放保护的旧后端镜像。自动保留期、大文件恢复、长原文跨页继续延后。
