# Work 契约资产（§22.2-2 草案）

> 目标契约，不是现有实现；未生成/提交生产 SDK，未完成协议评审。
>
> 设计说明：[work-api-contracts-2026-10-25.md](../../work-api-contracts-2026-10-25.md)
>
> 需求基线：[Work 系统架构 v2.9](../../work-system-architecture-2026-10-25.md) §11–§15、§21.2；[DDL 草案](../../work-data-model-ddl-draft-2026-10-25.md)。

## 文件

| 文件 | 用途 |
|---|---|
| `openapi/work-openapi-v1.yaml` | OpenAPI 3.1 用户/管理/operator API |
| `proto/work/common/v1/common.proto` | 共享枚举、OrgContext、Ref、Money、Usage、Error、Quiescence |
| `proto/work/control/v1/control.proto` | 控制面领域命令与内部服务 |
| `proto/work/device/v1/device.proto` | 设备双向连接与 journal/lease/receipt |
| `proto/work/events/v1/events.proto` | TaskEvent、InboxEvent、OutboxEnvelope |
| `proto/work/egress/v1/egress.proto` | 模型/工具出口与 provider 查询 |
| `schema/work-event-envelope-v1.schema.json` | 公开事件信封 JSON Schema |

## 必须遵守的边界

- 租户由服务端会话绑定；用户请求不提交可信 `org_id`。内部 `OrgContext` 由认证层注入。
- 幂等：用户请求体 `client_request_id`；内部命令 `request_id`；预算结算 `settlement_revision`。
- 任务静止：`active_run_id` 只指向非终态 Run；`latest_run_id` 保留最近 Run；阻塞 Operation 为 `prepared/waiting_approval/authorized/dispatching/unknown/unresolved`。
- 派发：Run active、Task open、active_run 匹配、fence 匹配、Operation authorized 且未消费；CAS 胜者才能发送。
- 采纳：Task revision 匹配、active_run 为空、latest Run 终态、无阻塞 Operation、成果已发布且属于该 Task。
- 预算：同一 Operation 最多一个 held/unknown 预留；释放后新 `reservation_seq` 重预留；settle/adjust 使用单调 `settlement_revision`。
- 事件/SSE：只带公开事实与 `content_ref`；不得携带原始 reasoning、目录绝对路径、凭据或完整提示词。
- 协议演进：OpenAPI `/work/v1`；Protobuf package major；设备 `required_features`；未知 schema/字段影响权限或输出时拒绝执行。

## 本地校验

OpenAPI（需要 Python 与 `openapi-spec-validator`、PyYAML）：

```bash
PYTHONPATH="$TEMP/work-openapi-tools" python - <<'PY'
from pathlib import Path
from openapi_spec_validator import validate_spec
import yaml
p = Path("openapi/work-openapi-v1.yaml")
validate_spec(yaml.safe_load(p.read_text(encoding="utf-8")))
print("OPENAPI_VALID")
PY
```

Protobuf（需要 `grpcio-tools`；well-known types 使用包自带的 `_proto`）：

```bash
cd proto
PYTHONPATH="$TEMP/work-protoc-tools" python -m grpc_tools.protoc \
  -I . \
  -I "$TEMP/work-protoc-tools/grpc_tools/_proto" \
  --descriptor_set_out="$TEMP/work-contracts.pb" --include_imports \
  work/common/v1/common.proto \
  work/control/v1/control.proto \
  work/device/v1/device.proto \
  work/events/v1/events.proto \
  work/egress/v1/egress.proto
```

事件 JSON Schema：

```bash
python -c "import json; json.load(open('schema/work-event-envelope-v1.schema.json', encoding='utf-8')); print('SCHEMA_OK')"
```

## 尚未验证

真实鉴权与 SSE/WebSocket 连接、OAuth 回调、供应商协议回归、生成客户端/mock server 编译、schema 兼容性矩阵、性能与安全模糊测试。OpenAPI/Protobuf 通过语法校验不等于端到端协议通过。
