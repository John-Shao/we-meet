# AI 录音上传中断：后端 OOM 修复（2026-09-14）

## 现场证据

- 后端 Pod `meet-backend-7b7759f945-wl59q` 已重启 2 次，最近终止原因为 `OOMKilled`。
- 上一容器日志显示音频上传连续返回 200，随后日志中断；因此只查当前容器会看不到此前上传记录。
- 受影响录音处于 `stopping`、revision 3。数据库有 224 个分片记录，其中 223 个 `stored=True`，第 224 个 `stored=False`，尚无最终 manifest。
- 第 223 片回读及哈希校验成功（160044 字节）；第 224 片回读为 `FileNotFoundError`。桶中已有音频与 App 显示未完成保存并不矛盾，剩余分片仍需要补传。
- Android 恢复日志只显示前两页回执查询返回 200。该现象不能单独证明分页代码错误，也不能证明本地回执处理成功；若修复后仍停在第二页，继续定位客户端恢复过程。

## 修复

1. `capture_storage.audio_storage()` 原来每次调用都构建新的 S3Storage；首次 I/O 又创建 boto3 Session、S3 Resource 和服务模型。连续上传、回读与能力查询会反复分配较大的客户端对象图。
2. 改为每个进程的每个工作线程复用一个专用音频 Storage。Django 默认存储对象替换或进程 fork 后重建；不缓存用户权限、桶版本控制检查或音频保留期限。
3. 保留音频专用的私有 ACL、禁用 gzip、3 秒连接/10 秒读取超时及原重试限制，全局默认 Storage 配置不受影响。
4. Gunicorn 支持通过环境变量控制进程数和优雅回收。生产配置由 3 个进程改为 2 个，每个进程处理 500 个请求后回收，增加 0–50 个请求的随机偏移；继续使用原 1 GiB 内存限制。并发处理能力相应降低，部署后需观察接口延迟及内存。
5. Android 补充 302 分片、多页回执解析回归测试；本批没有 App 运行时代码变化，不需要因本修复重新安装 APK。

## 验证

- 后端音频上传、回读、文本模式、清理及存储复用测试：47 项通过。
- Helm 渲染与 Gunicorn 生产配置加载测试：12 项通过。
- Android CaptureRepository 测试：14 项通过，包含游标 `0 → 100 → 200 → 300` 的 302 分片恢复数据。
- Ruff、`git diff --check` 通过。

在隔离测试容器内，以真实 MinIO 连续上传并回读校验 302 个 5 秒 PCM WAV 分片（每片 160044 字节），逐片删除本次测试对象，完成后删除专用临时桶。测试使用显式本地测试凭证，未调用生产 OSS 或 AI 服务。两个模式在独立进程运行，未在循环中强制 GC，旧模式按此前逻辑逐片新建客户端，新模式复用客户端。

| 本地单进程测试 | 起始 RSS | 最终 RSS | 峰值 RSS | 302 片耗时 |
| --- | ---: | ---: | ---: | ---: |
| 逐片新建客户端 | 181.8 MiB | 458.7 MiB | 480.6 MiB | 35.75 秒 |
| 复用客户端 | 181.0 MiB | 186.2 MiB | 186.3 MiB | 7.40 秒 |

所有分片均完成字节数及 SHA-256 校验。这证实旧实现会显著增加内存占用，与生产 3 个工作进程共享 1 GiB 限制下出现的 OOM 一致。数值是本地单进程存储链路结果，不代表生产并发负载或公网 OSS 延迟；完整用户录音的恢复仍需部署后验证。

## 发布与恢复

本批需要重新构建后端镜像，并应用更新后的 Helm 生产 values。只调整旧镜像的环境变量不会读取新增 Gunicorn 配置。

在构建环境执行：

```bash
git checkout aliyun-dev
git pull --ff-only origin aliyun-dev
export IMAGE_TAG="$(git rev-parse --short HEAD)"
bash deploy/aliyun/build-and-push.sh backend
```

服务器拉取同一版本，使用刚构建的镜像标签：

```bash
bash deploy/aliyun/release-meet.sh --branch aliyun-dev --tag <刚构建的标签> backend
kubectl -n meet rollout status deployment/meet-backend --timeout=10m
kubectl -n meet exec deploy/meet-backend -- python -c 'import runpy; c=runpy.run_path("/usr/local/etc/gunicorn/meet.py"); print({k:c[k] for k in ("workers","max_requests","max_requests_jitter")})'
kubectl -n meet top pods
```

运行时配置应显示 `workers=2`、`max_requests=500`、`max_requests_jitter=50`。后端镜像同时供使用同一镜像的 Celery 服务使用，由发布脚本/Helm 更新。Web 和 agents 没有本批代码变化。

在原 App、原账号中打开这份未完成录音，点击“重试上传”，待上传量归零后点击“完成保存”。恢复协议先核对服务端回执，只补传未确认的原分片。第 224 片继续使用已登记的原序号与对象路径，不需要新建录音。

观察后端内存及 Pod 重启次数不再增长、后续分片上传成功、最终 manifest 创建且会话到达 `stopped`。保留 App 本地数据，直到完整保存得到确认；不要手工将 `stored` 字段改为 true，也不要提前封存缺片的录音。
