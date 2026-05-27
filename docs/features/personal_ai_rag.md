# Sprint 2.4 — 跨会议 AI（"我所有会议"的 RAG 问答）

> 本文档是 Sprint 2.4 的设计与落地方案。前置：
> - Sprint 2.0 [transcription.md](transcription.md) — 字幕落库
> - Sprint 2.2 [summarization.md](summarization.md) — 纪要 / 行动项
> - Sprint 2.3 [room_ai_sidebar.md](room_ai_sidebar.md) — 单会议 AI 问答（沿用其 LLMClient / system prompt 思路）
> - 顶层路线见 [ai_strategy.md](ai_strategy.md)
>
> 本方案与 2.3 的核心差异：**跨会议**、**向量检索 RAG**、**主页入口**。

---

## 1. 目标

用户离开任何具体房间，在主页打开 AI 抽屉，对**自己参与过的所有已有 Summary 的会议**发问，AI 跨会议检索字幕、引用具体会议 + 时间 + 说话人作答。

典型用例：
- "上周关于考勤的会议结论是什么？"
- "我和张三最近讨论过哪些议题？"
- "我所有跟客户 X 的会议里，他主要的诉求是？"

## 2. 不做的事

- ❌ 跨用户检索（每个用户只看到自己参与过的会议）
- ❌ 实时索引（新字幕等 Summary 成功生成时再批量 embed）
- ❌ 多模态 RAG（视频帧 / 屏幕共享 OCR 留待后续）
- ❌ 多轮对话 / 流式（沿用 2.3 单轮 + 一次性）
- ❌ Re-ranking 模型 / 混合检索（MVP 直接 cosine top-K）

## 3. 关键技术决策（路径 C）

| 抉择 | 选择 | 备注 |
|---|---|---|
| 向量存储 | **pgvector 0.7+ 扩展** | 路径 C：升级现有 `bitnamilegacy/postgresql:16.4.0` → `pgvector/pgvector:pg16`，同库同事务 |
| 切片粒度 | **相邻同说话人合并 → 800 char 滑窗（overlap=80）** | 平衡召回率与 token 成本 |
| Embedding 模型 | **`doubao-embedding-large-text-240915`**（Ark API） | 复用 `ARK_API_KEY` + 现有 `LLMClient` 通道；1024 维 |
| 索引时机 | **Summary 成功后** 由 Celery 链式触发 `embed_meeting_transcripts(room_id)` | 复用既有 `generate_meeting_summary` 任务流 |
| 检索 | **top-K=12 chunks**，跨多个会议 | 给 LLM 留 ~10K bytes 上下文 |
| Index | **HNSW，cosine 距离，m=16 ef_construction=64** | pgvector 推荐参数 |
| Re-rank | 无 | Sprint 2.5+ |
| 失败兜底 | embedding 缺失的会议跳过检索 | 不阻塞其他会议命中 |
| 限频 | 单用户 10/min | 与 2.3 一致，复用 `RoomAIRateThrottle` 模式 |

## 4. 总体架构

```
[索引侧]
Celery worker (meet-celery-backend)
  generate_meeting_summary(room_id)           ← 既有
    └─ on_success → chain → embed_meeting_transcripts(room_id)
         ├─ ChunkBuilder: 合并相邻同 speaker + 滑窗切片
         ├─ doubao_embeddings.batch_embed([chunks])
         └─ TranscriptChunk.objects.bulk_create(...)

[查询侧]
Frontend: 主页右下角浮动按钮 → PersonalAIDrawer
   POST /api/v1.0/users/me/ai/ask/   { question }
        ↓
Backend: PersonalAIService.ask(user, question)
   ├─ embed(question) → q_vec
   ├─ user_room_ids = Room.objects.filter(users=user, summary__status=SUCCESS).ids
   ├─ chunks = TranscriptChunk.objects
   │     .filter(room_id__in=user_room_ids)
   │     .order_by(L2Distance("embedding", q_vec))[:12]
   ├─ format context with [会议名 | speaker | HH:MM:SS] 元数据
   └─ LLMClient.chat(system=ctx, user=question) → answer + sources
```

## 5. 数据模型

新增 `TranscriptChunk`（与 `Transcript` 解耦，避免污染 Sprint 2.0 的 schema）：

```python
class TranscriptChunk(BaseModel):
    room = FK(Room, on_delete=CASCADE, related_name="chunks")
    summary = FK(Summary, on_delete=CASCADE, related_name="chunks")
    chunk_index = PositiveIntegerField()             # 0,1,2,... 同 room 内
    speaker_name = CharField(128, blank=True)
    speaker_identity = CharField(128, blank=True)
    text = TextField()                               # 合并后的多句拼接
    started_at = DateTimeField()                     # 第一句起点
    ended_at = DateTimeField()                       # 最后一句终点
    source_transcript_ids = ArrayField(UUIDField())  # 审计 / 回溯原句
    embedding = VectorField(dimensions=1024)         # pgvector
    embedding_model = CharField(64)                  # 平滑模型迁移

    class Meta:
        ordering = ("room", "chunk_index")
        indexes = [
            HnswIndex(
                fields=["embedding"],
                m=16,
                ef_construction=64,
                opclasses=["vector_cosine_ops"],
                name="chunk_emb_hnsw_idx",
            ),
            models.Index(fields=["room", "chunk_index"]),
        ]
```

Migration 三件套：

1. `0031_enable_pgvector` — `RunSQL("CREATE EXTENSION IF NOT EXISTS vector;")`
2. `0032_transcriptchunk` — 表 + HNSW 索引
3. **可选** `0033_backfill_seed`：仅 schema，不动数据；回填用独立管理命令

## 6. 接口设计

### POST `/api/v1.0/users/me/ai/ask/`

需要登录（`permissions.IsAuthenticated`），从 `request.user` 拿身份，不走 LiveKit token（因为不在房间内）。

**Request**

```json
{ "question": "上周关于考勤的会议结论是什么？" }
```

**Response (200)**

```json
{
  "answer": "上周（2026-05-20）的考勤会议结论是：上班时间从 8 点半改到 9 点，下班时间不变。\n\n相关引用：\n- WeMeet-2026 在《John 的会议》13:13:20 说：上班时间从 8 点半调整到 9 点\n- WeMeet-2026 在《John 的会议》13:14:02 说：下班时间不变",
  "chunks_used": 5,
  "rooms_referenced": [
    {"id": "60eb...", "name": "John 的会议", "started_at": "2026-05-20T13:00:00Z"}
  ],
  "model_used": "ep-doubao-pro-..."
}
```

**错误码**

| Code | 含义 |
|---|---|
| 400 | question 为空 / 超长（>500） |
| 401 | 未登录 |
| 429 | 同用户 10/min |
| 503 | embedding / LLM 不可用 |

## 7. 后端实现（~450 LoC）

新增文件：

| 文件 | 职责 | LoC |
|---|---|---|
| `core/services/embeddings.py` | `EmbeddingClient.batch_embed(texts) -> list[list[float]]` | ~60 |
| `core/services/chunk_builder.py` | 相邻同 speaker 合并 + 800 char 滑窗 | ~80 |
| `core/services/personal_ai.py` | `PersonalAIService.ask(user, question)` | ~120 |
| `core/tasks/embeddings.py` | Celery `embed_meeting_transcripts(room_id)` | ~70 |
| `core/management/commands/backfill_embeddings.py` | 一次性回填历史会议 | ~60 |
| `core/migrations/0031_enable_pgvector.py` | `CREATE EXTENSION vector` | ~10 |
| `core/migrations/0032_transcriptchunk.py` | 模型 + HNSW 索引 | ~30 |

修改文件：

- `core/models.py` — 加 `TranscriptChunk` 模型
- `core/tasks/summary.py` — 成功后 chain 触发 embedding task
- `core/tasks/__init__.py` — 引入 `embeddings` 模块注册 task
- `core/api/viewsets.py` — 新增 `PersonalAIViewSet` 或在 `UserViewSet` 加 `@action`
- `core/api/serializers.py` — `AskPersonalAISerializer`
- `core/api/throttling.py` — 复用 `RoomAIRateThrottle` 模式，新增 `PersonalAIRateThrottle`（key 用 `user.id`）
- `meet/settings.py` — 加 `DOUBAO_EMBEDDING_ENDPOINT` 配置 + `personal_ai` throttle rate
- `pyproject.toml` — 加 `pgvector` Python 包（Django 字段类型 + HNSW Index 类）

## 8. 前端实现（~280 LoC）

新增 `features/personal-ai/`：

| 文件 | LoC | 职责 |
|---|---|---|
| `api/ApiPersonalAI.ts` | ~20 | 类型 |
| `api/personalAI.ts` | ~30 | `useAskPersonalAI` mutation |
| `hooks/usePersonalAI.ts` | ~50 | 本地消息列表 |
| `components/PersonalAIDrawer.tsx` | ~150 | 浮动抽屉（与 RoomAIPanel 同款 UI，可考虑抽公共组件） |
| `components/PersonalAIToggle.tsx` | ~30 | 主页右下角浮动 FAB |

修改：

- `features/home/routes/Home.tsx` — 挂载 `<PersonalAIToggle />`（条件渲染：已登录用户）
- `locales/{zh,en,fr,de,nl}/personal-ai.json` — 5 语言文案

答复中的引用 `《John 的会议》` 渲染为可点击 → 跳到 `/meetings/<id>`。

## 9. 部署改动（路径 C）

### 9.1 PG 镜像切换 SOP

**待确认前置**：现有 `postgresql` StatefulSet 是哪个 chart / release 管理的（用户已在排查）。

```bash
# Step 0 — 全量备份
kubectl -n meet exec postgresql-0 -- pg_dump -U postgres -Fc meet \
  > meet-backup-$(date +%Y%m%d-%H%M%S).dump

# Step 1 — 修改 StatefulSet:
#   image: pgvector/pgvector:pg16
#   env:
#     PGDATA: /bitnami/postgresql/data    # 保留旧路径
#   initContainers:
#     - name: fix-perms
#       image: busybox
#       command: ["chown","-R","999:999","/bitnami/postgresql/data"]
#       volumeMounts: ...

# Step 2 — 触发重建（PVC 保留）
kubectl -n meet rollout restart statefulset postgresql

# Step 3 — 等就绪并启用扩展
kubectl -n meet rollout status statefulset postgresql --timeout=120s
kubectl -n meet exec postgresql-0 -- psql -U postgres -d meet -c \
  "CREATE EXTENSION IF NOT EXISTS vector; SELECT extname,extversion FROM pg_extension WHERE extname='vector';"

# Step 4 — 业务冒烟
kubectl -n meet rollout restart deploy/meet-backend
# 浏览器登录 → 创建会议 → 拉一下首页 → 查看会议详情

# 回滚：改回 image: bitnamilegacy/postgresql:16.4.0-debian-12-r0
# 极端情况：从 dump 恢复 pg_restore -d meet meet-backup-*.dump
```

预计停机窗口 **5-15 min**。建议非工作时段执行。

### 9.2 Helm values 改动

- `src/helm/env.d/aliyun-prod/values.meet.yaml`：
  - 新增 `DOUBAO_EMBEDDING_ENDPOINT` 到 `backend.envVars`
  - 加 `personal_ai` throttle 配置（如必要）
  - postgresql 子图（如确认是子图）改 `image.tag` + 加 `initContainers`

## 10. 回填策略

历史会议（已有 Summary）需要一次性 embedding 回填：

```bash
# 干跑（统计要 embed 多少 chunk）
kubectl -n meet exec deploy/meet-backend -- \
  python manage.py backfill_embeddings --dry-run

# 全量回填（自动分批，速率限制，约 10 req/s）
kubectl -n meet exec deploy/meet-backend -- \
  python manage.py backfill_embeddings --all

# 单个房间
kubectl -n meet exec deploy/meet-backend -- \
  python manage.py backfill_embeddings --room 60eb041c-...
```

按内测期 100 场会议 × 50 chunk × 1024 维：
- Embedding API 调用：5K 个，分批 32 个/批 → 156 批，约 5-10 min
- 存储：5K × 1024 × 4 byte = 20 MB
- HNSW 构建：< 1 min

## 11. 风险与缓解

1. **PG 切换失败** — 备份 + 立即回滚（`image` tag 改回，PVC 没动）。手册见 §9.1。
2. **Doubao embedding 限流** — 与 LLM 共享 `ARK_API_KEY`，可能互相影响。缓解：embedding 任务 Celery 限速 10 req/s + 失败重试。
3. **隐私越界** — `personal_ai.ask` 必须严格 `Room.objects.filter(users=request.user)`，**单测必须覆盖跨用户拒绝**。
4. **跨用户共享会议** — 如果多人同会议都问相同问题，每次都重算 embedding 浪费 token。**MVP 先不缓存**；Sprint 2.5 可加 Redis cache（key = question hash）。
5. **chunk 漂移** — Summary 重新生成时旧 chunks 仍在。`embed_meeting_transcripts` 启动时先 `delete()` 该 room 的旧 chunks。
6. **embedding 模型升级** — `embedding_model` 字段记录用了哪个模型；future 模型不同维度时，新建表 + 灰度迁移。

## 12. 落地节奏

| Step | 内容 | 预计 |
|---|---|---|
| **0** | PG 镜像切换 + `CREATE EXTENSION vector` 验证 | 30 min |
| 1 | EmbeddingClient + ChunkBuilder + 单测 | ~2h |
| 2 | TranscriptChunk model + migrations 0031/0032 | ~1h |
| 3 | Celery embed task + 接入 summary chain + backfill 命令 | ~2h |
| 4 | PersonalAIService + endpoint + 单测（含跨用户拒绝） | ~3h |
| 5 | Frontend Drawer + Toggle + i18n + 引用点击跳转 | ~3h |
| 6 | 部署 + 历史会议回填 + 端到端冒烟 | ~1h |

**合计 ~13h**，可拆 2 个 PR：
- **PR1** = Step 0-3（基础设施 + 索引侧），合并即开始持续 embedding 新会议
- **PR2** = Step 4-5（查询侧 + UI），合并后用户可见

## 13. 验证清单（部署后）

1. `psql ... -c "\dx"` 看到 vector 扩展、`\d core_transcriptchunk` 看到表 + HNSW 索引
2. 开一场新会议、说几句话、离开 → Celery 日志先出 `generate_meeting_summary[...] succeeded`，再出 `embed_meeting_transcripts[...] succeeded`
3. `psql ... -c "SELECT count(*) FROM core_transcriptchunk;"` 数量 > 0
4. 浏览器登录 → 主页右下角 AI 按钮 → 问 "我最近的会议讲了什么" → AI 答复包含具体会议名 + 时间引用
5. 用 User-A 登录、调 endpoint 问 User-B 的会议 → 答复"找不到相关会议"
6. 触发 11 次以上 → 第 11 次 429

---

**后续 Sprint**：
- **2.5**：流式输出（SSE）+ 多轮对话上下文 + Redis 缓存
- **2.6**：Re-ranking 模型（Doubao-ranker 或本地交叉编码）+ 混合检索（vector + BM25）
- **2.7**：跨会议自动归类 / 主题聚类（embedding KMeans）
