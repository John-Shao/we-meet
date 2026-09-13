"""Source-bound acknowledgement for successful idempotent browser commands."""

from uuid import UUID


class MeetingCommandReceiptMixin:
    """Only a successful authenticated view can acknowledge a validated intent.

    Existing services still own authorization, payload matching and durable
    execution. This additive envelope lets clients distinguish their response
    from empty/proxy responses before removing their pending request.
    """

    def finalize_response(self, request, response, *args, **kwargs):
        """Keep errors, reads, unkeyed previews and internal operations unchanged."""
        response = super().finalize_response(request, response, *args, **kwargs)
        if (
            request.method != "POST"
            or not 200 <= response.status_code < 300
            or not isinstance(getattr(response, "data", None), dict)
        ):
            return response
        key = request.data.get("key") or request.headers.get("Idempotency-Key")
        try:
            key = str(UUID(str(key)))
        except (ValueError, TypeError, AttributeError):
            return response
        scope = {
            name: str(self.kwargs[name])
            for name in ("record_id", "capture_id")
            if self.kwargs.get(name) is not None
        }
        if (
            not scope
            and request.data.get("room_id")
            and request.data.get("livekit_room_sid")
        ):
            scope = {
                name: str(request.data[name])
                for name in ("room_id", "livekit_room_sid")
            }
        if scope:
            response.data = {
                **response.data,
                "command_receipt": {"key": key, "scope": scope},
            }
            response["Cache-Control"] = "private, no-store"
        return response
