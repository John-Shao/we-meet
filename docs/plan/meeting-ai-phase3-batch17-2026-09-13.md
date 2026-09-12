# 阶段 3 第十七批（累计第 37 批）：Docs 幂等创建与结果查询

在同级 `we-meet-docs` 仓库完成上游依赖，已提交并推送 `docs-dev`：`c4a3089a`。新增迁移 `core.0037_server_document_creation`，部署时先迁移 Docs，再开放 Meet 纪要交付客户端。

- `create-for-owner` 带 UUID `Idempotency-Key` 时启用严格幂等路径：相同所有者和请求重放返回原文档；内容冲突返回 409，删除或失去所有权后返回 410，不重新创建。
- 新增只读 `create-for-owner-result`；区分 `processing`、`not_found`、`ready`、`unavailable`。新版客户端必须检查明确状态，不能把旧服务的通用 404 当作未创建。
- PostgreSQL 事务锁、唯一约束、不可变回执保证同一请求只产生一个已提交文档。所有权与回执同事务落库；对象存储不具备数据库事务语义，失败遗留的无引用私有对象仍依赖存储生命周期清理。
- 带键路径不发送创建邮件，后续由纪要助手链路统一通知；不带键的旧调用保持原有契约。

验证：独立 Docs 测试容器和独立数据库，新建 8 项及旧验证回归 7 项通过。转换、对象存储和邮件使用测试替身，未连接生产。Django 检查、迁移状态检查、Ruff 通过。详见 `../we-meet-docs/docs/server-document-creation-idempotency.md`。

下一批实现 Meet 的严格状态客户端、冻结导出请求与恢复工作流；当前还没有将新版纪要推送到外部 Docs，也未完成纪要助手通知或 M3 整体验收。
