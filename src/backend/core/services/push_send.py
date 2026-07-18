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
from urllib.parse import quote

import requests
from django.conf import settings
from django.utils import timezone as django_timezone

from core.models import DevicePushToken, PushPreference, User

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

    def push_call_to_cid(self, cid: str, title: str, body: str, payload: dict[str, Any]) -> bool:
        """Dual-channel call-invite push to one device cid (P18/P2 来电).

        与 :meth:`push_to_cid`(纯通知)不同,来电走**双通道一条请求**:

        - ``push_message.transmission``(个推通道,在线/进程存活):App 的
          ``onReceiveMessageData`` 直接收到 payload JSON → 代码接管,全屏
          来电页 + 铃声,不经通知栏;
        - ``push_channel.android.ups.notification``(厂商通道,离线/冷杀):
          来电渠道(``im_calls``)高优通知响铃,点击 intent 深链
          ``wemeet://call?payload=<json>`` 拉起 App 进来电页。

        个推按在线状态互斥投达,不会双响。``ttl=55s``:呼叫 60s 就超时,
        过期的推送宁可不投,杜绝「几分钟后手机才响铃」。
        """
        payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        call_id = str(payload.get("call_id") or "")
        # 同一呼叫的通知互相替换(invite 双通道重试/厂商补投场景)。
        notify_id = int(hashlib.md5(call_id.encode()).hexdigest()[:8], 16) & 0x7FFFFFFF

        # quote(safe="") 编码后作为 intent data 的 query 值;App 端
        # handleDeepLink 用 Uri.getQueryParameter("payload") 取回原文 JSON。
        intent = (
            f"intent://call?payload={quote(payload_json, safe='')}#Intent;"
            "scheme=wemeet;launchFlags=0x10020000;"
            "component=com.we.meet/com.we.meet.MainActivity;end"
        )
        notification: dict[str, Any] = {
            "title": title,
            "body": body,
            "channel_id": "im_calls",
            "channel_name": "来电通知",
            "channel_level": 4,  # 响铃 + 震动 + 横幅(App 侧 im_calls 渠道一致)
            "click_type": "intent",
            "intent": intent,
            "notify_id": notify_id,
        }
        message = {
            "request_id": uuid.uuid4().hex,
            # 55s:比主叫 60s 振铃略短,过期不补投(来电迟到不如不到)。
            "settings": {"ttl": 55000},
            "audience": {"cid": [cid]},
            # 在线(个推通道)走透传,由 App 进程内直接接管。
            "push_message": {"transmission": payload_json},
            # 离线走厂商通道通知(冷杀可达)。
            "push_channel": {
                "android": {"ups": {"notification": notification}},
            },
        }
        resp = requests.post(
            f"{_GETUI_BASE}/{self._app_id}/push/single/cid",
            json=message,
            headers={"token": self._auth_token()},
            timeout=self._timeout,
        )
        if resp.status_code >= 400:
            logger.warning(
                "getui call push to %s failed: %s %s",
                cid[:12],
                resp.status_code,
                resp.text[:200],
            )
            return False
        try:
            code = resp.json().get("code")
        except ValueError:
            code = None
        if code not in (0, None):
            logger.warning(
                "getui call push to %s rejected: code=%s %s",
                cid[:12],
                code,
                resp.text[:200],
            )
            return False
        return True

    def push_to_cid(self, cid: str, title: str, body: str, payload: dict[str, Any]) -> bool:
        """Notification push to one device cid. Returns delivered-ish success.

        走**通知(notification)**而非透传:通知消息由个推 SDK / 厂商通道直接展示,
        能投达已被杀死的 App(透传只回调到 onReceiveMessageData,需 App 进程存活,
        冷杀后收不到——这是最初上线时 A 机型收不到的根因)。

        点击动作用 ``click_type=intent`` 拉起应用内深链
        ``wemeet://im?cid=<会话id>``(见 App AndroidManifest / MainActivity.handleDeepLink)。
        ⚠️ 深链用的是**会话 cid**(``payload["cid"]``),不是入参的设备 cid。

        ⚠️ ``channel_*`` 不可省:Android 8+ 通知必须挂 NotificationChannel,否则
        个推 SDK 建通知时无有效渠道,``successed`` 但端侧静默丢弃、不显示(实测:
        缺此三字段不弹,补上即弹)。
        """
        conv_cid = str(payload.get("cid") or "")
        notification: dict[str, Any] = {
            "title": title,
            "body": body,
            "channel_id": "im_messages",
            "channel_name": "消息通知",
            "channel_level": 4,  # 响铃 + 震动 + 横幅(与 App 侧 im_messages 渠道一致)
        }
        if conv_cid:
            # Android intent-URI:data=wemeet://im?cid=<会话id>,由
            # MainActivity.handleDeepLink 解析跳转。⚠️ 必须显式 component 指向
            # MainActivity——实测隐式 intent(仅 scheme+package)个推 SDK 建
            # PendingIntent 失败会**整条静默丢弃、不显示**;带 component 才正常弹。
            # launchFlags = NEW_TASK|SINGLE_TOP,与 App 透传路径的点击 intent 一致。
            notification["click_type"] = "intent"
            notification["intent"] = (
                f"intent://im?cid={conv_cid}#Intent;"
                "scheme=wemeet;launchFlags=0x10020000;"
                "component=com.we.meet/com.we.meet.MainActivity;end"
            )
            # 每会话一个稳定 notify_id:同会话新消息替换旧通知,不无限堆叠
            # (OPPO 厂商通道也要求 notify_id > 0)。
            notification["notify_id"] = (
                int(hashlib.md5(conv_cid.encode()).hexdigest()[:8], 16) & 0x7FFFFFFF
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


def notify_webhook(payload: dict[str, Any], client: Optional[GetuiClient] = None) -> int:
    """Entry for the jusi webhook: fan by payload type.

    缺省/``"im"`` → 消息离线通知(:func:`notify_offline`);``"call"`` →
    来电唤醒(:func:`notify_call`)。未知类型记日志忽略(向前兼容)。
    """
    kind = str(payload.get("type") or "im")
    if kind == "call":
        return notify_call(payload, client=client)
    if kind == "im":
        return notify_offline(payload, client=client)
    logger.info("push-hook: unknown payload type %r ignored", kind)
    return 0


def notify_call(payload: dict[str, Any], client: Optional[GetuiClient] = None) -> int:
    """Handle one P18/P2 call-invite webhook: callee uid → tokens → 双通道推送.

    Payload(jusi ``CallWebhookPayload``)自带完整呼叫信息;这里补上
    ``from_name``(主叫显示名,Django 侧才有 User 映射)后原样透传给端上。
    Returns the number of push attempts. Never raises.

    P0-M3 有意不查免打扰(:func:`quiet_user_ids`):来电是实时呼叫,错过
    成本高且被叫可手动拒接——免打扰只静默消息通知。
    """
    callee_uid = str(payload.get("to") or "")
    caller_uid = str(payload.get("from") or "")
    call_id = str(payload.get("call_id") or "")
    if not callee_uid or not call_id:
        logger.info("call-push: missing to/call_id, ignoring")
        return 0

    callee = User.objects.filter(im_uid=callee_uid).first()
    if callee is None:
        logger.info("call-push: no user for callee uid %s", callee_uid[:12])
        return 0
    tokens = list(DevicePushToken.objects.filter(user=callee))
    if not tokens:
        return 0

    if client is None:
        client = _client_from_settings()
    if client is None:
        logger.info("call-push: getui unconfigured — skipping %d device(s)", len(tokens))
        return 0

    caller = User.objects.filter(im_uid=caller_uid).first() if caller_uid else None
    from_name = (caller.full_name or "").strip() if caller else ""
    if not from_name:
        from_name = "对方"

    media = str(payload.get("media") or "audio")
    media_label = "视频通话" if media == "video" else "语音通话"
    # P4/P19: kind="meet" = 通话中拉人的入会邀请,通知文案区别于普通来电。
    kind = str(payload.get("kind") or "")
    if kind == "meet":
        title = f"{media_label}邀请"
        body = f"{from_name} 邀请你加入{media_label}"
    else:
        title = f"{media_label}邀请"
        body = f"{from_name} 邀请你进行{media_label}"

    device_payload = {
        "type": "call",
        "call_id": call_id,
        "cid": str(payload.get("cid") or ""),
        "from": caller_uid,
        "from_name": from_name,
        "media": media,
        "room_slug": str(payload.get("room_slug") or ""),
        "kind": kind,
        "ts": payload.get("ts") or int(time.time() * 1000),
    }

    sent = 0
    for token in tokens:
        try:
            if client.push_call_to_cid(token.cid, title, body, device_payload):
                sent += 1
        except requests.RequestException:
            logger.warning(
                "call-push: getui unreachable for %s", token.cid[:12], exc_info=True
            )
        except Exception:  # noqa: BLE001 — courtesy nudge, never propagate
            logger.exception("call-push: unexpected push failure")
    return sent


def quiet_user_ids(user_ids, now=None) -> set:
    """P0-M3 免打扰:返回当前处于静默时段的用户 id 子集。

    按各自 ``User.timezone`` 的墙上钟判断;跨午夜区间(start > end)合法,
    start == end 视为全天静默。仅 ``notify_offline`` 调用——来电
    (:func:`notify_call`)有意穿透,实时呼叫错过成本高且被叫可手动拒接。
    """
    ids = [i for i in user_ids if i]
    if not ids:
        return set()
    now = now or django_timezone.now()
    quiet: set = set()
    prefs = PushPreference.objects.filter(
        user_id__in=ids, quiet_enabled=True
    ).select_related("user")
    for pref in prefs:
        try:
            local_t = now.astimezone(pref.user.timezone).time()
        except Exception:  # noqa: BLE001 — 坏时区数据不该挡推送
            logger.warning("quiet-hours: bad timezone for user %s", pref.user_id)
            continue
        start, end = pref.quiet_start, pref.quiet_end
        if start == end:
            in_quiet = True  # 全天
        elif start < end:
            in_quiet = start <= local_t < end
        else:  # 跨午夜,如 22:00 → 08:00
            in_quiet = local_t >= start or local_t < end
        if in_quiet:
            quiet.add(pref.user_id)
    return quiet


def notify_offline(payload: dict[str, Any], client: Optional[GetuiClient] = None) -> int:
    """Handle one p14 webhook payload: resolve offline uids → tokens → push.

    Returns the number of push attempts made (0 when Getui is unconfigured or
    nobody has a registered device). Never raises — every failure is logged.
    P0-M3: 处于免打扰时段的用户被静默跳过(见 :func:`quiet_user_ids`)。
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

    # P0-M3 免打扰:静默时段内的用户整机跳过(消息通知;来电不在此过滤)。
    quiet = quiet_user_ids({t.user_id for t in tokens})
    if quiet:
        tokens = [t for t in tokens if t.user_id not in quiet]
        logger.info("push-hook: %d user(s) in quiet hours skipped", len(quiet))
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
    # Non-text bodies are JSON/object keys — map them to human labels instead
    # of leaking raw payloads into the notification shade.
    content_type = str(payload.get("content_type") or "")
    type_labels = {
        "image": "[图片]",
        "file": "[文件]",
        "voice": "[语音]",
        "merged": "[聊天记录]",
        "call-log": "[通话]",
        "group-call": "[语音通话]",
    }
    if content_type in type_labels:
        snippet = type_labels[content_type]
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
