# Work R0a Runtime 与出口设计资产（D4）

本目录是 R0a Runtime/Work Adapter/沙箱/模型出口的**设计契约与策略资产**，不是生产 Runtime 或网关。

## 文件

| 文件 | 用途 |
|---|---|
| `WorkAdapter.contract.ts` | RunContext、ModelCall、模板读取、草稿/检查点、usage、cancel 与错误码 |
| `policy/tool-manifest.json` | R0a 三个工具的白名单、副作用、预算、网络、内容与调用上限 |
| `policy/sandbox-profile.json` | gVisor/非 root/只读/无宿主挂载/egress-only/资源/降级 profile |
| `policy/egress-policy.json` | 供应商、请求绑定、来源标签、秘密模式、响应过滤、usage、日志、回退 |
| `policy/evaluator.mjs` | 设计级策略评估器（不是生产网关） |
| `policy/evaluator.test.mjs` | 10 组策略测试 |

## 校验

```bash
cd docs/plan/assets/work-r0a-runtime-2026-10-25
node --test policy/evaluator.test.mjs

npx --yes -p typescript@5 tsc --noEmit --skipLibCheck \
  --target ES2022 --module ESNext WorkAdapter.contract.ts
```

## 已验证

- 策略测试 **10/10** 通过：工具白名单、来源标签、秘密阻断、请求绑定、回退、响应过滤、沙箱不变量、无内容日志、usage、faux model。
- `WorkAdapter.contract.ts` 通过 `tsc --noEmit`。
- 策略 JSON 可解析；faux model 无网络依赖。
- [降级沙箱 smoke](../work-r0a-hardening-2026-10-25/sandbox-smoke.log)：runc、非 root、只读根、无宿主挂载、无网络、cap-drop；gVisor 不可用，`sandboxProof=false`。
- [本地 KMS envelope](../work-r0a-hardening-2026-10-25/kms-envelope.mjs)：租户隔离/轮换/主密钥轮换/shredding **6/6**；不是生产 KMS。
- 真实 Qwen smoke：[provider-smoke.log](../work-r0a-hardening-2026-10-25/provider-smoke.log)；200、首 token 2567ms、usage 80/110、provider request id 可记录，未输出 Key/正文。

## 未验证

- 真实 gVisor/等效沙箱、逃逸测试、资源/时间压力；`sandbox-profile.json` 的 digest 是占位，生产必须替换。
- 真实 Content Store/云 KMS/HSM/scoped token；本地 envelope 不是生产 KMS。
- 真实网关鉴权、配额、回退、价表、usage 对账；provider smoke 不经过 D4 gateway/Temporal。
- 取消/超时、检查点恢复、无正文日志运行时验证；仅完成一次真实流式 smoke。
- 供应商书面条款/价表；H02 只是真实请求，不是生产承诺。provider id/model/dataResidency/quota 是占位，需商务/安全确认。

## 与其他文档

- D4 设计说明：[../../work-r0a-runtime-egress-design-2026-10-25.md](../../work-r0a-runtime-egress-design-2026-10-25.md)
- D3 编排设计：[../../work-r0a-orchestration-design-2026-10-25.md](../../work-r0a-orchestration-design-2026-10-25.md)
- R0a 详细设计计划：[../../work-r0a-detailed-design-plan-2026-10-25.md](../../work-r0a-detailed-design-plan-2026-10-25.md)
- 威胁模型：[../../work-threat-model-2026-10-25.md](../../work-threat-model-2026-10-25.md)
