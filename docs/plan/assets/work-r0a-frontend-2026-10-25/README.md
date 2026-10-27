# Work R0a 前端设计资产（D5）

本目录是 R0a 前端的**状态/路由/文案/UI 模型契约**，不是 React 页面实现。

## 文件

| 文件 | 用途 |
|---|---|
| `ui-state.contract.ts` | DisplayState、TaskUiModel、动作、路由/文案键类型 |
| `state-matrix.json` | 12 个展示状态 → 动作/主操作/横幅/约束 |
| `routes.json` | R0a 路由、视图枚举、旧路由重定向 |
| `copy.zh-CN.json` | `work.r0a.*` 中文文案 174 条（状态/动作/边界/错误/管理，含导出 5 状态与 8 个管理错误码） |
| `ui-model.mjs` | 状态矩阵校验、动作门控、路由/legacy redirect、权限文案键 |
| `ui-model.test.mjs` | 11 组测试 |

## 校验

```bash
cd docs/plan/assets/work-r0a-frontend-2026-10-25
node --test ui-model.test.mjs

npx --yes -p typescript@5 tsc --noEmit --skipLibCheck \
  --target ES2022 --module ESNext ui-state.contract.ts

python -c "import json; [json.load(open(f, encoding='utf-8')) for f in ['state-matrix.json','routes.json','copy.zh-CN.json']]; print('json-ok')"
```

## 已验证

- 14/14 测试通过（含重命名/删除管理动作、静止门控、completed/failed/run_canceled 只读与 canceled/archived 的 R0b 预留约束）：矩阵/文案完整性、reconciling 无重试/采纳、待验收采纳门控、运行取消只读+重试、失败/配额动作、完成/终止状态、Composer 门控、Inbox 映射、路由/旧链接、权限文案、`artifact_read_only` 文案。
- 管理只读页（2026-10-26 二次修订）：`EXPORT_STATES` 5 个导出状态与 8 个管理/导出错误码都有专属文案（`adminCopyKeys()` 逐个断言存在）；`exportStateLabel('ready')` 文案含“可下载一次”，`work.r0a.admin.exportOneTime` 明确凭证一次性；组织名缺失时回退占位文案（`AdminOverview.name` 可为 null）。
- `ui-state.contract.ts` 通过 `tsc --noEmit`。
- 状态/路由/文案 JSON 可解析。

## 未验证

- 未实现 React 页面、React Query 数据层、SSE fetch 客户端或 Playwright E2E。
- 未做真实浏览器/屏幕阅读器/视觉回归；未做 5–8 名设计合作伙伴可用性测试。
- 配额剩余与标题编辑已进 D2 契约；审计导出作业状态与一次性下载凭证已按方案 B 冻结（D1/D2），页面实现与真实 P1-A 目录字段接入仍依赖实施（E2/E6、C31）。

## 与其他文档

- D5 设计说明：[../../work-r0a-frontend-design-2026-10-25.md](../../work-r0a-frontend-design-2026-10-25.md)
- R0 UX：[../../work-ux-design-r0-2026-10-25.md](../../work-ux-design-r0-2026-10-25.md)
- R0 原型：[../work-ux-r0/prototype.html](../work-ux-r0/prototype.html)
- D2 API：[../../work-r0a-api-design-2026-10-25.md](../../work-r0a-api-design-2026-10-25.md)
- R0a 详细设计计划：[../../work-r0a-detailed-design-plan-2026-10-25.md](../../work-r0a-detailed-design-plan-2026-10-25.md)
