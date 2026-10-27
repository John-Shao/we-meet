"""Base APIView: correlation id, Work context, contract-shaped errors."""

import logging
import os
import uuid

from django.conf import settings
from django.db import DatabaseError

from rest_framework.authentication import SessionAuthentication
from rest_framework.exceptions import (
    AuthenticationFailed,
    NotAuthenticated,
    ParseError,
    PermissionDenied,
    UnsupportedMediaType,
    ValidationError,
)
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from work.api.context import resolve_context
from work.api.errors import (
    WorkAPIError,
    error_payload,
    public_code_for_sql,
    sql_code,
)

logger = logging.getLogger(__name__)


class WorkSessionAuthentication(SessionAuthentication):
    """Session cookie auth with the contract's csrf_invalid code."""

    def enforce_csrf(self, request):
        try:
            super().enforce_csrf(request)
        except PermissionDenied as error:
            raise WorkAPIError("csrf_invalid") from error


def pagination(request, *, default_limit=20):
    raw_limit = request.query_params.get("limit")
    raw_cursor = request.query_params.get("cursor")
    try:
        limit = int(raw_limit) if raw_limit is not None else default_limit
        offset = int(raw_cursor) if raw_cursor else 0
    except (TypeError, ValueError) as error:
        raise WorkAPIError("invalid_pagination") from error
    if limit < 1 or limit > 100 or offset < 0:
        raise WorkAPIError("invalid_pagination")
    return offset, limit


def paginated(items, offset, limit):
    page = items[offset : offset + limit]
    next_cursor = str(offset + limit) if offset + limit < len(items) else None
    return {"items": page, "next_cursor": next_cursor}


class WorkAPIView(APIView):
    authentication_classes = (WorkSessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def initial(self, request, *args, **kwargs):
        request.correlation_id = getattr(request, "correlation_id", uuid.uuid4().hex)
        super().initial(request, *args, **kwargs)
        request.work_context = resolve_context(request)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["X-Correlation-ID"] = request.correlation_id
        return response

    def handle_exception(self, exc):
        error = self._contract_error(exc)
        if error is not None:
            return Response(
                error_payload(error, self.request.correlation_id),
                status=error.status,
            )
        if isinstance(exc, DatabaseError):
            if os.environ.get("WORK_API_RAISE"):
                raise exc
            error = WorkAPIError(public_code_for_sql(exc))
            logger.warning(
                "work api database error correlation_id=%s code=%s sql_code=%s",
                self.request.correlation_id,
                error.code,
                sql_code(exc),
            )
            return Response(
                error_payload(error, self.request.correlation_id),
                status=error.status,
            )
        if os.environ.get("WORK_API_RAISE") or settings.DEBUG:
            raise exc
        logger.exception(
            "work api unexpected error correlation_id=%s", self.request.correlation_id
        )
        error = WorkAPIError("service_degraded")
        return Response(
            error_payload(error, self.request.correlation_id),
            status=error.status,
        )

    def _contract_error(self, exc):
        if isinstance(exc, WorkAPIError):
            return exc
        if isinstance(exc, ParseError):
            return WorkAPIError("invalid_json")
        if isinstance(exc, (UnsupportedMediaType, ValidationError)):
            return WorkAPIError("invalid_request")
        if isinstance(exc, (NotAuthenticated, AuthenticationFailed)):
            return WorkAPIError("unauthorized")
        if isinstance(exc, PermissionDenied):
            return WorkAPIError("forbidden")
        return None
