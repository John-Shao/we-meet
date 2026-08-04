"""全局搜索 AI 问答端点(P1-4 M1,docs/features/global_search_ai_qa.md §D3)。

- ``POST /api/v1.0/search/ask/``        — 非流式,一次性返回。
- ``POST /api/v1.0/search/ask-stream/`` — SSE:meta{citations,sources} →
  delta×N → done{citations_used, degraded}。

双端 gate:FeatureFlag ``search_ai``(关闭 404,只藏前端挡不住直接调 API
烧钱)+ 独立 throttle scope ``global_search_ai``(不与 personal_ai 抢额度)。
"""

from __future__ import annotations

import logging

from django.conf import settings

from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from core.api import serializers, throttling
from core.api.feature_flag import FeatureFlag
from core.api.viewsets import ServerSentEventRenderer, _sse_response
from core.services.global_ask import GlobalAskService

logger = logging.getLogger(__name__)


class GlobalAskView(APIView):
    """一次性问答。Body ``{"question": "..."}``(≤500 字,单轮)。"""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [
        throttling.GlobalSearchAIRateThrottle,
        throttling.GlobalSearchAIDailyThrottle,
    ]

    @FeatureFlag.require("search_ai")
    def post(self, request):
        serializer = serializers.AskPersonalAISerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        question = serializer.validated_data["question"]
        try:
            result = GlobalAskService().ask(user=request.user, question=question)
        except Exception as exc:  # pylint: disable=broad-except
            # LLM 失败在服务内已转 degraded;走到这里是检索层面的意外。
            logger.exception("global ask failed for user %s", request.user.pk)
            return Response(
                {"error": f"Global ask failed: {exc}"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response(result, status=status.HTTP_200_OK)


class DocsSearchView(APIView):
    """P1-4 搜索入口统一 M1:按调用者可见范围搜 Docs 文档标题。

    ``GET /api/v1.0/docs/search/?q=&limit=&offset=`` → 代理 Docs fork 的 s2s
    ``search-for-user``(sub 服务端注入,绝不接受参数)。搜索面板的从源:
    Docs 未配置/不可达/无 sub 一律**空列表**而非 5xx——面板不该因从源挂掉
    而报错(与全局搜索「每源独立降级」同哲学)。

    ``limit``/``offset`` 透传给 Docs,返回体带 ``has_more`` 供「加载更多」。
    这是把云文档搜索收敛进全局搜索面板的配套:docs 自带的搜索弹窗是无限滚动的,
    若这边钉死在 Docs 的默认 8 条,收敛就成了能力退化。
    """

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        query = str(request.query_params.get("q") or "").strip()
        if len(query) < 2:
            return Response({"results": [], "has_more": False})

        cfg = getattr(settings, "DOCS_CONFIGURATION", None) or {}
        api_url = cfg.get("api_url") or ""
        token = cfg.get("server_to_server_token") or ""
        sub = str(getattr(request.user, "sub", "") or "")
        if not api_url or not token or not sub:
            return Response({"results": [], "has_more": False})

        from core.services.docs_client import DocsClient, DocsServiceError

        client = DocsClient(
            api_url=str(api_url),
            server_to_server_token=str(token),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 3),
        )
        try:
            page = client.search_for_user(
                sub=sub,
                query=query,
                limit=_optional_int(request.query_params.get("limit")),
                offset=_optional_int(request.query_params.get("offset")),
            )
        except DocsServiceError as exc:
            logger.warning("docs search degraded: %s", exc)
            return Response({"results": [], "has_more": False})
        base = str(api_url).rstrip("/")
        return Response(
            {
                "results": [
                    {
                        "id": hit.id,
                        "title": hit.title,
                        "updated_at": hit.updated_at,
                        "url": f"{base}/docs/{hit.id}/",
                    }
                    for hit in page.hits
                ],
                "has_more": page.has_more,
            }
        )


def _optional_int(raw):
    """解析可选的整数查询参数;缺省或不合法一律返回 None(交给 Docs 用默认值)。

    刻意不在这里夹上下界:Docs 侧已经夹过一次(``_clamped_int``),重复一份
    只会多一个将来两边不一致的地方。
    """
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


class DocsMyDocumentsView(APIView):
    """分享云文档到聊天(入口 A)的"我的文档"列表:按调用者可见范围返回最近文档。

    ``GET /api/v1.0/docs/my-documents/?q=`` → 代理 Docs fork 的 s2s
    ``list-for-user``(sub 服务端注入,绝不接受参数)。``q`` 可选,用于选择器
    内搜索;同 :class:`DocsSearchView`,Docs 未配置/不可达/无 sub 一律**空
    列表**而非 5xx。

    带 per-user throttle:空 q 是常态且每次必发 Docs s2s + DB 排序,不像
    ``DocsSearchView`` 有 ``len(q)<2`` 早返回,故加一道防裸循环轰炸的闸。
    """

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [throttling.DocsMyDocumentsRateThrottle]

    def get(self, request):
        query = str(request.query_params.get("q") or "").strip()

        cfg = getattr(settings, "DOCS_CONFIGURATION", None) or {}
        api_url = cfg.get("api_url") or ""
        token = cfg.get("server_to_server_token") or ""
        sub = str(getattr(request.user, "sub", "") or "")
        if not api_url or not token or not sub:
            return Response({"results": []})

        from core.services.docs_client import DocsClient, DocsServiceError

        client = DocsClient(
            api_url=str(api_url),
            server_to_server_token=str(token),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 3),
        )
        try:
            hits = client.list_for_user(sub=sub, query=query)
        except DocsServiceError as exc:
            logger.warning("docs my-documents degraded: %s", exc)
            return Response({"results": []})
        base = str(api_url).rstrip("/")
        return Response(
            {
                "results": [
                    {
                        "id": hit.id,
                        "title": hit.title,
                        "updated_at": hit.updated_at,
                        "url": f"{base}/docs/{hit.id}/",
                    }
                    for hit in hits
                ]
            }
        )


class GlobalAskStreamView(APIView):
    """流式问答(SSE)。事件契约见 §D2;LLM 失败不 error 而是
    ``done{degraded: true}``——前端转「检索结果模式」(§D7)。"""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [
        throttling.GlobalSearchAIRateThrottle,
        throttling.GlobalSearchAIDailyThrottle,
    ]
    renderer_classes = [ServerSentEventRenderer]

    @FeatureFlag.require("search_ai")
    def post(self, request):
        serializer = serializers.AskPersonalAISerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        question = serializer.validated_data["question"]
        event_iter = GlobalAskService().ask_stream(
            user=request.user, question=question
        )
        return _sse_response(event_iter, error_label="Global ask")
