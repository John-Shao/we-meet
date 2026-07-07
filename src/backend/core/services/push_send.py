"""P0 离线推送发送侧 (docs/features/foundation_p0_p3.md §P0).

jusi-light-im 的 p14 webhook 打到 ``/api/agent/push-hook/`` 后,这里负责:
jusi uid → we-meet User(``User.im_uid`` 缓存映射)→ DevicePushToken → 个推。

个推(Getui)REST v2 客户端保持最小面:auth token(进程内缓存)+ 单 cid 透传
推送。``PUSH_CONFIGURATION`` 未配置 getui 凭证时整体降级为 no-op(只记日志),
webhook 仍回 200 —— 推送是 courtesy nudge,永远不把失败传染给 IM 主链路。
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from typing import Any, Optional

import requests
from django.conf import settings

from core.models import DevicePushToken, User

logger = logging.getLogger(__name__)

_GETUI_BASE = "https://restapi.getui.com/v2"


class GetuiClient:
    """Minimal Getui REST v2 client: auth + per-cid transmission push."""

    def __init__(
        self,
        app_id: str,
        app_key: str,
        master_secret: str,
        timeout_seconds: float = 5.0,
    ) -> None:
        self._app_id = app_id
        self._app_key = app_key
        self._master_secret = master_secret
        self._timeout = timeout_seconds
        self._token: Optional[str] = None
        self._token_expires_at: float = 0.0

    def _auth_token(self) -> str:
        """Fetch (or reuse) the API auth token. Getui tokens live 24h; we
        refresh 60s early."""
        now = time.time()
        if self._token and now < self._token_expires_at - 60:
            return self._token
        ts = str(int(now * 1000))
        sign = hashlib.sha256(
            (self._app_key + ts + self._master_secret).encode("utf-8")
        ).hexdigest()
        resp = requests.post(
            f"{_GETUI_BASE}/{self._app_id}/auth",
            json={"sign": sign, "timestamp": ts, "appkey": self._app_key},
            timeout=self._timeout,
        )
        resp.raise_for_status()
        data = resp.json().get("data") or {}
        token = data.get("token")
        if not token:
            raise RuntimeError(f"getui auth: unexpected response {resp.text[:200]}")
        self._token = token
        self._token_expires_at = float(data.get("expire_time") or 0) / 1000 or (
            now + 23 * 3600
        )
        return token

    def push_to_cid(self, cid: str, title: str, body: str, payload: dict[str, Any]) -> bool:
        """Notification push to one device cid. Returns delivered-ish success.

        走**通知(notification)**而非透传:通知消息由个推 SDK / 厂商通道直接展示,
        能投达已被杀死的 App(透传只回调到 onReceiveMessageData,需 App 进程存活,
        冷杀后收不到——这是最初上线时 A 机型收不到的根因)。

        点击动作用 ``click_type=intent`` 拉起应用内深链
        ``wemeet://im?cid=<会话id>``(见 App AndroidManifest / MainActivity.handleDeepLink)。
        ⚠️ 深链用的是**会话 cid**(``payload["cid"]``),不是入参的设备 cid。
        """
        conv_cid = str(payload.get("cid") or "")
        notification: dict[str, Any] = {"title": title, "body": body}
        if conv_cid:
            # Android intent-URI: 主机 im + query cid,scheme wemeet,限定本包。
            notification["click_type"] = "intent"
            notification["intent"] = (
                f"intent://im?cid={conv_cid}"
                "#Intent;scheme=wemeet;package=com.we.meet;end"
            )
        else:
            notification["click_type"] = "startapp"

        message = {
            "request_id": uuid.uuid4().hex,
            "settings": {"ttl": 3600000},  # 离线保留 1h,过期不再补投
            "audience": {"cid": [cid]},
            "push_message": {"notification": notification},
        }
        resp = requests.post(
            f"{_GETUI_BASE}/{self._app_id}/push/single/cid",
            json=message,
            headers={"token": self._auth_token()},
            timeout=self._timeout,
        )
        if resp.status_code >= 400:
            logger.warning(
                "getui push to %s failed: %s %s", cid[:12], resp.status_code, resp.text[:200]
            )
            return False
        # Getui v2 returns HTTP 200 even for logical errors; code==0 == accepted.
        try:
            code = resp.json().get("code")
        except ValueError:
            code = None
        if code not in (0, None):
            logger.warning(
                "getui push to %s rejected: code=%s %s", cid[:12], code, resp.text[:200]
            )
            return False
        return True


def _client_from_settings() -> Optional[GetuiClient]:
    cfg = getattr(settings, "PUSH_CONFIGURATION", None) or {}
    app_id = cfg.get("getui_app_id") or ""
    app_key = cfg.get("getui_app_key") or ""
    master = cfg.get("getui_master_secret") or ""
    if not (app_id and app_key and master):
        return None
    return GetuiClient(
        app_id=str(app_id),
        app_key=str(app_key),
        master_secret=str(master),
        timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
    )


def notify_offline(payload: dict[str, Any], client: Optional[GetuiClient] = None) -> int:
    """Handle one p14 webhook payload: resolve offline uids → tokens → push.

    Returns the number of push attempts made (0 when Getui is unconfigured or
    nobody has a registered device). Never raises — every failure is logged.
    """
    offline_uids = [str(u) for u in (payload.get("offline_uids") or []) if u]
    if not offline_uids:
        return 0

    users = list(User.objects.filter(im_uid__in=offline_uids))
    if not users:
        logger.info("push-hook: no users matched %d offline uids", len(offline_uids))
        return 0
    tokens = list(DevicePushToken.objects.filter(user__in=users))
    if not tokens:
        return 0

    if client is None:
        client = _client_from_settings()
    if client is None:
        logger.info(
            "push-hook: getui unconfigured — skipping %d device(s)", len(tokens)
        )
        return 0

    cfg = getattr(settings, "PUSH_CONFIGURATION", None) or {}
    content_visible = bool(cfg.get("content_visible", True))
    snippet = str(payload.get("body_snippet") or "")
    title = "we-meet"
    body = snippet if (content_visible and snippet) else "你有一条新消息"
    deep = {
        "type": "im",
        "cid": str(payload.get("cid") or ""),
        "mid": payload.get("mid"),
        "seq": payload.get("seq"),
    }

    sent = 0
    for token in tokens:
        try:
            if client.push_to_cid(token.cid, title, body, deep):
                sent += 1
        except requests.RequestException:
            logger.warning(
                "push-hook: getui unreachable for %s", token.cid[:12], exc_info=True
            )
        except Exception:  # noqa: BLE001 — courtesy nudge, never propagate
            logger.exception("push-hook: unexpected push failure")
    return sent
