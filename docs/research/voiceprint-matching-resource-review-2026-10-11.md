# 候选与设备模板规模的匹配核心资源基准

日期：2026-10-11（Asia/Shanghai）。补充[方案第 6.4 节](../plan/speaker-identity-voiceprint-plan-2026-10-09.md#64-配置依据与-p0-容量验证)的模板规模维度。使用已构建的 Linux 后端生产镜像与确定性合成向量，不读取声纹库、业务数据库或媒体，不调用模型 RPC／ASR。

## 执行与边界

- 镜像 `we-meet-backend:voiceprint-integration-20261011`，本地 ID `sha256:a070f009869de175f9d8f8b8ad8f4a313ea644c81215f980fdf7788f48280c84`；Docker Desktop Linux 容器，不是 ECS 测量。
- Docker 命令限制 2 CPU／2 GiB、128 PID、64 MiB 内存临时卷；UID 10001、只读根和探针挂载、全部 capability 丢弃、no-new-privileges、断网。使用直接 Python entrypoint；断网时为配置读取的容器 hostname 添加本地 hosts 映射，不打开外网。
- Django Production 设置加载后，三项声纹开关均检查为关闭。测量直接调用内部 `matching.match`，不会开启业务接口或绕过生产任务的授权门禁。
- 固定种子生成稠密 1024 维单位向量，候选、设备组和查询均为内存 fixture。调用使用显式 `synthetic-resource-only-v1` 策略及虚构校准摘要，未写出门限配置；其中质量与校准布尔值只用于合成算法路径，不能认证真实音频或真实校准。
- 测量范围包含策略／输入校验、查询一致性、模板余弦均值、逐段排序和最终结果；不含 fixture 生成、Django 启动、授权查询、模板解密、模型提取、数据库事务、独立日志、队列或 HTTP。每次结果均核对为预期合成候选，未打印向量、候选标识或相似度。
- 镜像内匹配源码的规范化 SHA-256 为 `320f03fb034fa5e1c0a000e1cd24e17d8c7a282d6e61e1757587a1b64dc4c808`，向量源码为 `a20df55c3fe15e7a27e476100d160bebba767b099ac347128dcbf39b171c1c76`；与当前工作树逐一核对一致。实际 Python 为 3.13.5，与独立 encoder 镜像的 3.13.13 分别记录。

## 实际结果

候选人数 1／10／50、每人设备组 1／5、查询片段 3／12 的笛卡尔积，共 12 个组合。每个组合首次加 30 次预热，共 372 次匹配全部通过。P95 为 nearest-rank（30 次排序后的第 29 项），是短期重复 fixture 的经验值，不提供业务 SLA 或置信上界。

| 候选人数 | 每人设备组 | 查询片段 | 首次 | 预热中位 | 预热 P95 | 预热最大 |
|---|---|---|---|---|---|---|
| 1 | 1 | 3 | 3.84 ms | 3.32 ms | 3.83 ms | 4.81 ms |
| 1 | 1 | 12 | 36.09 ms | 34.82 ms | 37.97 ms | 38.34 ms |
| 1 | 5 | 3 | 8.79 ms | 9.04 ms | 11.41 ms | 11.91 ms |
| 1 | 5 | 12 | 55.10 ms | 54.49 ms | 58.62 ms | 60.11 ms |
| 10 | 1 | 3 | 16.78 ms | 15.88 ms | 16.98 ms | 20.33 ms |
| 10 | 1 | 12 | 79.29 ms | 79.23 ms | 83.79 ms | 83.81 ms |
| 10 | 5 | 3 | 70.22 ms | 72.00 ms | 80.59 ms | 86.08 ms |
| 10 | 5 | 12 | 281.32 ms | 280.78 ms | 294.59 ms | 299.75 ms |
| 50 | 1 | 3 | 70.35 ms | 71.87 ms | 76.26 ms | 79.50 ms |
| 50 | 1 | 12 | 276.63 ms | 276.64 ms | 294.53 ms | 294.75 ms |
| 50 | 5 | 3 | 345.10 ms | 362.01 ms | 411.80 ms | 420.16 ms |
| 50 | 5 | 12 | 1,268.38 ms | 1,265.51 ms | 1,322.56 ms | 1,437.88 ms |

进程峰值 RSS 约 181.14 MiB，包含 Django 和已导入后端模块，不是模板自身大小或 cgroup 内存峰值。上限组合有 3,000 次查询／模板比较，另有查询片段两两一致性检查；当前逐次余弦还执行有限值校验和归一化。数据支持继续保留有界直接比较方案，未修改评分策略、门限或人工确认行为。

本轮仅补齐匹配核心的规模成本。多个 speaker、并发 worker、候选授权／解密／日志开销和持续排队仍需完整资源预算与链路压测；不能与不同机器的 encoder 数值直接相加作为端到端 P95。暂无授权真人样本，身份效果准入仍未通过。

## 复验与产物

探针：[voiceprint_matching_resource_probe.py](../../deploy/aliyun/voiceprint_matching_resource_probe.py)。在上述隔离约束下将探针挂为 `/probe.py`，使用生产后端 Python 执行：

```text
DJANGO_SETTINGS_MODULE=meet.settings DJANGO_CONFIGURATION=Production /app/.venv/bin/python /probe.py
```

该命令还需环境初始化所需的非敏感 fixture 设置（Django secret、S3 配置与 OIDC 地址），均使用测试占位值；无需真实凭据。每组完成仅输出计数，最终输出聚合 JSON。禁止在已启用声纹功能的业务进程内运行。

私有原始日志和解析结果：`work/voiceprint-matching-resource-baseline-2026-10-11.{log,json}`。容器以 `--rm` 退出，未创建数据库、模板文件或模型制品；原生产镜像保留。首次启动因断网 hostname 解析失败而终止，修正本地 hosts／entrypoint 后完整执行成功，启动失败不计入 372 次结果。
