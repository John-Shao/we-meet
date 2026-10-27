"""Usage reads for the caller and the organization (D-08)."""

from datetime import date

from rest_framework.response import Response

from work.api.base import WorkAPIView
from work.api.constants import USAGE_NOTE
from work.api.context import fetch_all, require_admin, work_cursor
from work.api.errors import WorkAPIError


def parse_range(request):
    raw_from = request.query_params.get("from")
    raw_to = request.query_params.get("to")
    try:
        start = date.fromisoformat(raw_from)
        end = date.fromisoformat(raw_to)
    except (TypeError, ValueError) as error:
        raise WorkAPIError("invalid_request") from error
    if start > end or (end - start).days > 366:
        raise WorkAPIError("invalid_request")
    return start, end


class UserUsageView(WorkAPIView):
    def get(self, request):
        start, end = parse_range(request)
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT * FROM work.get_user_usage(%s, %s, %s, %s)",
                [context.org_id, context.subject_id, start, end],
            )
            rows = fetch_all(cursor)
        return Response(
            {
                "from": start.isoformat(),
                "to": end.isoformat(),
                "note": USAGE_NOTE,
                "items": [
                    {
                        **{
                            key: value
                            for key, value in row.items()
                            if key != "usage_date"
                        },
                        "usage_date": row["usage_date"].isoformat(),
                    }
                    for row in rows
                ],
            }
        )


class OrgUsageView(WorkAPIView):
    def get(self, request):
        require_admin(request.work_context)
        start, end = parse_range(request)
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT * FROM work.get_org_usage_by_model(%s, %s, %s, %s)",
                [context.org_id, context.subject_id, start, end],
            )
            rows = fetch_all(cursor)
        return Response(
            {
                "from": start.isoformat(),
                "to": end.isoformat(),
                "note": USAGE_NOTE,
                "items": [
                    {
                        **row,
                        "run_count": int(row["run_count"]),
                    }
                    for row in rows
                ],
            }
        )
