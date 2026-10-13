# 第四十八批：永久删除存储核验与启用准备

> 后续状态：用户已回传本批生产端预检完整 PASS，三个进程迁移、实例与 live worker/beat 均通过，API/worker 的四个探针全部清理。启用配置进入[第 49 批](miaoji-batch-49-purge-rollout.md)。下文保留本批执行当时的证据与步骤。

## 结论（2026-09-21）

实际媒体桶的存储前提已通过本批核验；永久删除仍未启用。生产集群的迁移、每个后端实例及 live worker/beat 还需在宿主机运行本批脚本确认，不能把本地持有的生产凭据检查等同于 Pod 内检查。

- 用户提供 Helm 381/382 发布日志：backend、celery-backend 为 `d2c791e9d`，frontend 为修复后的 `62fb7904b`；三个 backend 进程 rollout 成功。日志未包含逐 Pod 镜像摘要或迁移查询结果。
- 实际生产演示账号 `13800000009` 的回收站 GET 返回 200，`purge_available=false`。仅读取，未受理任何删除请求。
- Android 修复提交 `5e3c3cbb` 已推送；正式分发另行验收。

## 存储实测

使用本机现有、未输出的生产 values 凭据访问 `we-meet-video`，端点为阿里云深圳 OSS。未修改桶配置、ACL、RAM 权限或保留策略。

| 检查 | 结果 |
|---|---|
| S3 兼容 GetBucketVersioning | HTTP 200，无 Status；从未启用版本控制，非 Suspended |
| GetBucketAcl | HTTP 200，无公共组授权 |
| OSS GetBucketWorm | HTTP 404，明确错误码 `NoSuchWORMConfiguration` |
| `record-uploads/` 新建随机探针 | 写入、存在性检查通过；去掉签名后的匿名 GET 返回 403 |
| `capture-audio/` 新建随机探针 | 写入、存在性检查通过；匿名 GET 返回 403 |
| 两个探针删除 | 通过实际 `audio_storage()` 和 `_delete_verified()` 路径删除，随后 `exists=False`；无遗留 |

两份对象仅含本次验证文字，没有关联 MeetingRecord，没有读取或删除既有媒体。上述凭据和生产 Pod 当前所用凭据的一致性尚未验证；宿主机预检会直接在每个目标 Pod 中重新检查。

判定依据：[OSS GetBucketVersioning](https://www.alibabacloud.com/help/en/oss/developer-reference/getbucketversioning) 规定未启用版本控制时响应不含 Status；Enabled 和 Suspended 均不满足当前删除实现。[OSS GetBucketWorm](https://help.aliyun.com/en/oss/developer-reference/getbucketworm) 描述保留期内的删除限制；本次不是把任意 404 当作无策略，而是确认了 `NoSuchWORMConfiguration`。

## 生产端预检

本机 kubeconfig 仅有 `kind-suite`，未配置生产访问通道。请在现有 `root@jd-sjy:~/we-meet` 执行：

```bash
git pull --ff-only origin aliyun-dev
python3 deploy/aliyun/check_record_purge.py --expected-backend-tag d2c791e9d --storage-canary
```

无需构建镜像。宿主机脚本只依赖 Python 3 和 kubectl；探针通过标准输入进入现有 Pod，使用容器内现有 Django、Celery 和存储库。

预检会检查：

- backend、celery-backend、celery-beat 全部副本 Ready、完整 rollout、没有残留/终止中的旧 Pod，指定镜像 tag 和跨组件实际摘要一致。
- 每个 Pod 所见的 PostgreSQL 已应用 `0186_record_purge`，records/trash/Celery 已开启、永久删除仍关闭，并具备上传重放保护。首次启用前存在旧删除意图则阻止继续。
- 每个 Pod 的真实媒体桶为 `we-meet-video`、未版本化，实际媒体存储使用 private ACL。
- API 和 worker 的每个 Pod 各创建并删除两个随机测试对象，校验匿名拒绝与删除后不存在；不删除任何应用记录。
- live Celery worker 已注册永久删除任务并订阅路由目标队列；beat 配置包含 30 秒调度，最近三分钟日志中实际出现对应派发。

只有完整成功才输出 PASS。失败退出非零，输出固定诊断码；不会输出凭据、对象签名或供应商完整异常。若探针清理失败，会输出本次随机对象键供后续清理。脚本不会修改开关，也不会调用永久删除请求或清理任务。

## 已准备的启用变更

待以上生产预检通过后，单独提交 `src/helm/env.d/aliyun-prod/values.meet.yaml` 中：

```yaml
backend:
  envVars:
    MEETING_RECORD_PURGE_ENABLED: "True"
```

本批用假 Secret 做 Helm 渲染，已确认该变更在 `meet-backend`、`meet-celery-backend`、`meet-celery-beat` 三处均为 True，trash 保持 True；实际文件仍为 False，未修改集群。条件确认后可复用已经部署并包含全部保护的 backend 镜像 `d2c791e9d` 发布配置：

```bash
# 仅在启用配置已提交且生产预检通过之后执行
bash deploy/aliyun/release-meet.sh --tag d2c791e9d backend
python3 deploy/aliyun/check_record_purge.py --expected-backend-tag d2c791e9d --expect-enabled --storage-canary
```

随后创建明确可销毁的新记录，验证所有者确认删除、非所有者拒绝、上传签名等待窗口、状态完成及旧上传凭证不能复建。既有第 30/41/43/45 批样本继续保留。关闭开关只能暂停，不能撤销已受理意图；禁止回滚到缺少上传重放保护的旧镜像。自动保留期、大文件恢复、长原文跨页仍延后。

## 本地验证

- 6 项 rollout 判定测试：完整 rollout、旧/终止 Pod、旧镜像、未观察的新配置、各副本计数、容器未就绪/缺失摘要。
- 7 项存储探针测试：仅清理新对象、版本化阻止写入、碰撞不覆盖/删除、PUT 响应丢失仍清理、公开读取阻止通过、删除失败不报成功、异常信息不泄露。
- 新增脚本 Ruff 格式/检查通过；拟启用 Helm 配置三进程渲染通过。

以上不代替生产 Pod 运行验证，也不代表用户记录的永久删除已验收。
