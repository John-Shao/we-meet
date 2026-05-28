# Sprint 2.6 — 检索质量优化:缓存 + 混合检索

> 路线见 [ai_strategy.md](ai_strategy.md)；前置 Sprint 2.4 [personal_ai_rag.md](personal_ai_rag.md)（跨会议 RAG，路径 D numpy cosine）+ Sprint 2.5 [streaming_chat.md](streaming_chat.md)（流式 + 多轮）。本轮在 2.4 检索基础上做质量与成本优化。

## 1. 目标

Personal AI 跨会议 RAG 的两点优化：

1. **Redis query-embedding 缓存** — 相同问题不重复调 embedding API（省 ~500ms + token）。跨用户共享会议被重复提问时收益明显。
2. **混合检索** — 向量（语义）+ BM25（词面）双路召回，RRF 融合。解决**纯向量对人名 / 日期 / 术语等精确词召回不稳**的问题（典型："张三说的那个数据"、"OKR 截止日期"）。

## 2. 不做（明确边界）

- ❌ Cross-encoder / Ark 重排（下一轮 2.6.x，先验证火山 Ark 是否有 rerank 接口）
- ❌ pgvector 迁移（仍路径 D numpy，见 [personal_ai_rag.md](personal_ai_rag.md) §11.1）
- ❌ Room AI 改造（Room AI 塞全量字幕、不走 embedding 检索，本轮不碰）
- ❌ chunk embedding 缓存（chunk 向量已落 `TranscriptChunk.embedding`，无需缓存）

## 3. 设计

### 3.1 query-embedding 缓存

- 位置：**查询侧 service 层 helper**，不进 `EmbeddingClient`。索引侧（Celery `embed_meeting_transcripts`）不该走 query 缓存，保持 client 纯净。
- Key：`emb:q:{model}:{sha256(normalized_question)}`。`model` 用 `embed_client.model`（endpoint id）——模型/endpoint 变了 key 自动失效，无需手动清。
- 规范化：`casefold()` + 折叠连续空白。中文无大小写，但提升英文 / 混合查询命中率。
- Value：JSON `list[float]`。TTL：7 天（`60*60*24*7`）。
- 容错：cache 读 / 写异常 → 退回直接 `embed()`，**绝不因缓存故障打挂主流程**（捕获并 `logger.warning`）。
- 后端：`from django.core.cache import cache`（已是 `django_redis.cache.RedisCache`，`redis://redis:6379/1`）。

### 3.2 混合检索（向量 + BM25 + RRF）

新增 `core/services/hybrid_retrieval.py`：

- `vector_rank(q_vec, chunks) -> list[(chunk, score)]` — cosine 逻辑（从 `personal_ai._rank` 迁出）；跳过空 / 维度不符的 embedding。
- `bm25_rank(question, chunks) -> list[(chunk, score)]` — `jieba` 分词 + `rank_bm25.BM25Okapi`。语料就是内存里那批 chunk（与 numpy 同一份，不额外查库）。
- `reciprocal_rank_fusion(vec_ranked, bm25_ranked, k=60, top_k=12) -> list[(chunk, fused_score)]` — 经典 RRF：每个 chunk `score = Σ 1/(k + rank_i)`（rank 从 1 计，仅在该路出现才累加），按 chunk.id 去重，按融合分降序取 top_k。
- 每路先截 `CANDIDATE_N=50` 再融合（聚焦 + 省 RRF 计算）。

`PersonalAIService._prepare` 改动（rooms_map / format_context / system prompt 全不变）：

```python
q_vec = cached_embed(embed_client, question)          # 3.1
vec_ranked  = vector_rank(q_vec, chunks)
bm25_ranked = bm25_rank(question, chunks)
top = reciprocal_rank_fusion(vec_ranked, bm25_ranked, top_k=self.TOP_K)
```

`RAG_HYBRID_ENABLED=False` 时跳过 BM25，退回纯 `vector_rank`（= 2.5 行为）。

### 3.3 依赖

`pyproject.toml` 加 `jieba` + `rank-bm25`（均纯 Python、零重依赖），docker 内重生成 `uv.lock`。

## 4. 文件清单

**新增**

| 文件 | 职责 | LoC |
|---|---|---|
| `core/services/embedding_cache.py` | `cached_embed(client, question)` | ~40 |
| `core/services/hybrid_retrieval.py` | vector_rank / bm25_rank / rrf | ~120 |
| `core/tests/services/test_embedding_cache.py` | 命中 / 未命中 / 缓存故障退回 | ~70 |
| `core/tests/services/test_hybrid_retrieval.py` | BM25 精确词召回、RRF 顺序 / 去重、空输入 | ~120 |

**修改**

- `core/services/personal_ai.py` — `_prepare` 接入缓存 + 混合检索；`_rank` 迁出到 hybrid_retrieval
- `pyproject.toml` + `uv.lock`
- `meet/settings.py` — `RAG_QUERY_EMBED_CACHE_TTL` / `RAG_CANDIDATE_N` / `RAG_HYBRID_ENABLED`（默认开）

## 5. 关键决策

| 抉择 | 选择 | 理由 |
|---|---|---|
| 缓存位置 | service helper，不进 client | 索引侧不该走 query 缓存 |
| 缓存 key | `sha256(model + normalized_q)` | 模型 / 问题变了不串；规范化提升命中率 |
| 中文分词 | jieba | 标准、纯 Python、不造轮子 |
| BM25 库 | rank-bm25 | 轻量纯 Python |
| 融合 | RRF（k=60） | 参数少、鲁棒、不需对齐两路分数量纲 |
| 候选数 | 每路 top-50 → 融合 top-12 | 聚焦 + 省算 |
| 开关 | `RAG_HYBRID_ENABLED` | 出问题秒退回 2.5 纯向量行为 |
| 重排 | 不做 | 下一轮；先确认 Ark rerank API |

## 6. 风险与缓解

1. **jieba 首次 import 加载词典 ~1-2s** — 模块级单例，worker 进程内只付一次；冷启动首查略慢，可接受。
2. **BM25 每查询重建语料** — <10K chunk 量级 ok；未来可缓存 per-room tokenized 语料。
3. **RRF 被词面噪声拉低纯语义强相关 chunk** — k=60 较大缓解；`RAG_HYBRID_ENABLED` 可一键退回。
4. **中英混合查询** — jieba 对纯英文退化为空格切分，够用。
5. **缓存陈旧** — key 含 model，embedding 模型升级自动失效。

## 7. 落地节奏（~6h，1 个纯后端 PR）

| Step | 内容 | 预计 |
|---|---|---|
| 1 | jieba + rank-bm25 依赖 + uv.lock | 0.5h |
| 2 | embedding_cache.py + 单测 | 1h |
| 3 | hybrid_retrieval.py（vector / bm25 / rrf）+ 单测 | 2.5h |
| 4 | personal_ai._prepare 接入 + 单测调整 | 1h |
| 5 | 部署 + 端到端冒烟（精确词 vs 语义对比） | 1h |

## 8. 验证清单（部署后）

1. 同一问题问两次 → 第二次后端日志出 cache hit、无 embedding API 调用
2. 含**精确人名 / 术语**的模糊问题 → 命中相关 chunk（纯向量之前漏）
3. **纯语义**换种说法的问题 → 仍命中（向量路保证）
4. 关 `RAG_HYBRID_ENABLED` → 结果与 2.5 一致
5. 跨用户隔离单测仍绿（`PersonalAIService._user_room_ids` 边界不变）

---

**Sprint 2.6.x / 2.7 路标**：cross-encoder 或 Ark rerank（精度）→ 跨会议主题聚类（embedding KMeans）。
