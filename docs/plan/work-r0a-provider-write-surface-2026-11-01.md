# Provider 接入配置写面（R0a 范围核实与实现缺口）

日期：2026-11-01 ｜ 提出：漂移门禁 `CONTRACT_ONLY` 白名单复核 ｜ 决定人：John（无独立复核人，自决 + 7 日复评）

## 为什么要单列这一条

漂移门禁 `docs/plan/assets/work-r0a-design-2026-10-25/test/go-surface-drift.test.mjs:11-15` 的注释把白名单里 5 条 provider 写操作描述成「与 D-08b 划在范围外的 provider 写面重叠」。**这句话与已签收的设计不符**，如果不纠正，后人会把这 5 条当成"合法不实现"而永久留在白名单里。

按 `docs/plan/work-project.md:282`（D-08a–d 于 2026-11-01 之前的 2026-10-27 全部签收）原文，D-08a 的结论之一就是「**扩大 R0a 范围允许组织 owner 写接入配置**」；`docs/plan/work-project.md:83` 的 D-08b 十条里包含「DeepSeek Key 由平台**静态加密托管（只写不回读、可即时吊销、强审计）**」。也就是说：这 5 条是**范围内的未实现项**，不是范围外。

## 事实（可核）

契约声明、Go 控制面没有路由、但 SQL 领域函数已具备的 5 条：

| 操作 | 契约位置（`r0a-openapi-v1.yaml`） | SQL 已具备（`baseline/0002_initial_r0a_schema.sql`） |
| --- | --- | --- |
| `PUT /work/v1/admin/provider-config`（`setProviderConfig`） | :523-525 | `work.set_provider_config(...)` :4217 |
| `POST /work/v1/admin/provider-config/revoke`（`revokeProviderConfig`） | :549-552 | `work.revoke_provider_config(org,subject,reason)` :4286 — **已于 2026-11-01 落地** |
| `POST /work/v1/admin/provider-credentials`（`createProviderCredential`） | :571-574 | `work.create_provider_credential(...)` :4074 |
| `POST .../provider-credentials/{credentialId}/rotate` | :598-601 | `work.rotate_provider_credential(...)` :4133 |
| `POST .../provider-credentials/{credentialId}/revoke` | :623-626 | `work.revoke_provider_credential(...)` :4184 |

两条 `GET` 白名单项（`/work/v1/inbox`、`/work/v1/runs/{runId}/operations`）不属于本单，见[同一日的 inbox/operations 归属决策单](work-r0a-inbox-operations-decision-2026-11-01.md)——那两条连 SQL 读函数都没有，必须新增迁移。`POST /work/v1/artifacts/{artifactId}/versions` 只有语义相近的 `work.publish_artifact`（:1654，入参是 task/run + content_ref 的运行期发布命令），与契约「按 artifactId 追加版本 + 属主校验」并不同形，需先确认属主写面是否也在 R0a 范围。

## 实现前必须先定的三件事（不是纯 handler 工作）

1. **错误映射**：机制不是「ERRCODE 没映射」——`src/work/contracts/error-codes.json` 的 `db_exception_map` 已经把 `revision_conflict:356` 映射到 `version_conflict`。真正的原因是 `apierr.FromDB` 对 `conflictCodes` 一律要求数字 DETAIL，而 `set_provider_config` 的 `RAISE 'revision_conflict' USING ERRCODE='40001'`（:4265）**不带 DETAIL**，于是会降级成 503。核对时顺着这条线发现同一个缺陷早已存在于已上线的采纳路径（`accept_task` 抛 `run_not_quiescent_or_revision_conflict`、`delete_task_core`/`create_user_artifact_version` 抛 `run_not_quiescent`，都不带 DETAIL → 503 而不是 409），已于 2026-11-01 在共用路径修掉并补测试（见状态源「静止冲突的 503 缺陷」）。因此 `PUT /admin/provider-config` 落地时要么让 SQL 侧补 DETAIL（当前修订号），要么沿用 `run_not_quiescent` 那样"允许无 DETAIL 的 409"——**不能再各自打补丁式特例**。
2. **连通探测**：契约 `setProviderConfig` 描述写明「保存前网关会发一次最小真实请求做连通探测，失败不生效」（yaml:527-529 的 description）。SQL 与 Go 都没有探测实现。要么实现（需要真实供应商网络出口与一次真实调用，属生产动作），要么把它显式记为范围例外并写清触发条件。当前 provider 网络出口策略见 [[meet-backend-network-policy]] 同级的 NetworkPolicy 文档。
3. **密钥入库形态**：`create_provider_credential` / `rotate_provider_credential` 的入参是 `p_secret_ciphertext bytea` + `p_wrapped_dek bytea` + `p_kms_key_ref` + `p_secret_fingerprint`，即**服务端收到的是已经加密的字节**。但 D-08b 的「只写不回读」与管理面表单的实际可用性之间，取决于契约请求体到底让浏览器提交明文（服务端用 D-03 静态主密钥加密后再调函数）还是提交密文（浏览器侧加密）。这不是实现细节，是**安全边界**：浏览器侧加密需要额外的密钥下发通道，服务端加密则要求 API 进程能拿到主密钥。**必须先定，再写 handler。**

## 两种处置

**A：本轮就补齐 5 条写端点。** 前置条件是上面三件事都有结论；工作量含 Go 5 个 handler + CSRF + 定向错误映射 + PG 支撑的服务端测试（含跨组织/非 owner/吊销/并发冲突/明文与密文都不回读）+ 管理面写表单 + 漂移门禁白名单 8→3。注意凭据写面还牵动生产密钥下发，未部署前不能声称可用。

**B：先只补 `PUT /admin/provider-config` 与 `POST /admin/provider-config/revoke`**（配置写面，不含密钥字节，D-08a 明确扩权的那一半），把凭据三件套（create/rotate/revoke）留到连通探测与密钥入库形态有结论之后；白名单 8→5。前提是同步把契约里的「连通探测」改成条件备选或记例外，否则 `PUT` 仍然与契约不完全一致。

**C：整组记为范围例外并重签契约。** 代价是 D-08a「允许组织 owner 写接入配置」的签收结论落空，接入配置只能由运维直接写库——这与 D-08b 的强审计与即时吊销要求相冲突，不建议。

## 建议

**B**，并在做 B 之前先把第 1 件事（`revision_conflict` → 409 的定向映射）作为独立小改动落地：它不依赖任何未定语义，且今天的 `run_not_quiescent` 已经证明这类降级会真实发生。凭据三件套在第 2、3 件事有书面结论前不动。

## 签收栏

- [ ] John 选 A（本轮补齐 5 条写端点，并给出密钥入库形态与连通探测结论）　日期：
- [ ] John 选 B（先补配置写面两条，凭据三件套待第 2/3 项结论）　日期：
- [ ] John 选 C（整组记范围例外并重签 D2'）　日期：
- [ ] 密钥入库形态：浏览器提交密文 / 服务端加密明文 / 其他（写明）
- [ ] 连通探测：实现（需生产出口与一次真实调用）/ 记例外（写明触发重开条件）

**不勾选的后果**：这 5 条继续留在漂移门禁白名单（当前 `CONTRACT_ONLY` 共 8 项），`d2-prime-surface.json` 的 `surfaceFrozen` 保持 `false`，R0a 不得声称「契约=实现」；且白名单注释里「D-08b 划在范围外」的错误表述若不改，会被当成不实现的理由。
