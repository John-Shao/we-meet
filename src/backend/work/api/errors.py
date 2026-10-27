"""Public error catalog (D2 r0a-errors-v3) and SQL error mapping."""

import json
from pathlib import Path

CATALOG = json.loads(
    (Path(__file__).with_name("error-codes.json")).read_text(encoding="utf-8")
)
PUBLIC = CATALOG["public"]
DB_EXCEPTION_MAP = CATALOG["db_exception_map"]

SAFE_MESSAGES = {
    "invalid_request": "请求参数不合法。",
    "invalid_json": "请求体不是合法 JSON。",
    "invalid_pagination": "分页参数不合法。",
    "invalid_view": "视图参数不合法。",
    "unauthorized": "登录状态已失效。",
    "csrf_invalid": "CSRF 校验失败，请刷新后重试。",
    "forbidden": "没有执行该操作的权限。",
    "admin_access_denied": "仅组织管理员可执行该操作。",
    "work_seat_required": "当前账号没有 Work 席位。",
    "task_not_found": "任务不存在。",
    "run_not_found": "运行不存在。",
    "artifact_not_found": "成果不存在。",
    "version_not_found": "成果版本不存在。",
    "not_found": "资源不存在。",
    "idempotency_key_conflict": "同一请求键携带了不同参数。",
    "version_conflict": "版本已变化，请刷新后重试。",
    "preview_stale": "预览已过期，请重新预览。",
    "title_invalid": "标题需为 1–80 个字符且不含控制字符。",
    "artifact_read_only": "当前任务状态下成果只读。",
    "run_not_quiescent": "任务仍有活动运行，请稍后重试。",
    "scope_unavailable": "R0a 不支持该能力。",
    "permission_mode_unavailable": "R0a 不支持该权限模式。",
    "quota_exhausted": "token 配额不足。",
    "provider_not_configured": "组织尚未配置大模型接入。",
    "download_token_invalid": "下载凭证无效或已被使用。",
    "download_token_expired": "下载凭证已过期。",
    "audit_export_expired": "审计导出已过期。",
    "audit_export_already_downloaded": "审计导出已下载。",
    "audit_export_not_found": "审计导出不存在。",
    "audit_export_range_invalid": "审计导出时间范围不合法。",
    "input_not_found": "输入不存在或不可见。",
    "service_degraded": "服务暂时不可用，请稍后重试。",
}


class WorkAPIError(Exception):
    def __init__(self, code: str, message: str | None = None, *, current_revision=None):
        self.code = code if code in PUBLIC else "service_degraded"
        entry = PUBLIC[self.code]
        self.status = entry["status"]
        self.retryable = entry["retryable"]
        self.recovery_action = entry.get("recovery_action")
        self.current_revision = current_revision
        self.message = message or SAFE_MESSAGES.get(self.code, self.code)
        super().__init__(self.message)


def error_payload(error: WorkAPIError, correlation_id: str) -> dict:
    return {
        "code": error.code,
        "message": error.message,
        "retryable": error.retryable,
        "correlation_id": correlation_id,
        "current_revision": error.current_revision,
        "recovery_action": error.recovery_action,
    }


def sql_code(error: Exception) -> str:
    cause = error.__cause__ or error
    diag = getattr(cause, "diag", None)
    primary = getattr(diag, "message_primary", None)
    message = (primary or str(error)).strip()
    return message.split(":", 1)[0].strip()


SQLSTATE_MAP = {
    "22P02": "invalid_request",
    "22001": "invalid_request",
    "22023": "invalid_request",
    "23514": "invalid_request",
}


def public_code_for_sql(error: Exception) -> str:
    raw = sql_code(error)
    mapped = DB_EXCEPTION_MAP.get(raw, raw)
    if mapped in PUBLIC:
        return mapped
    cause = error.__cause__ or error
    diag = getattr(cause, "diag", None)
    return SQLSTATE_MAP.get(getattr(diag, "sqlstate", None), "service_degraded")
