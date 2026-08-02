"""Bulk member import and export (P10 M2).

Import is two explicit requests, not one:

1. ``POST /admin/import-jobs/`` with the CSV → a job in ``previewed``, carrying
   a per-row report of what *would* happen.
2. ``POST /admin/import-jobs/{id}/apply/`` → it happens.

The admin reads the diff in between. That is the whole design: an importer that
tells you what it did after the fact is how a directory gets silently reshaped
by one mis-mapped column.

Export is a streamed CSV. Capped rather than paginated — a partial export is
worse than a refused one, because nothing about the file says it is partial.
"""

import csv

from django.http import StreamingHttpResponse
from django.utils.translation import gettext_lazy as _

from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from core import models
from core.api.admin_roles import HasOrgPermission
from core.api.directory import get_caller_organization
from core.services import member_import
from core.services.audit import record_audit
from core.services.org_permissions import get_admin_context
from core.tasks import member_import as import_tasks

#: Beyond this an export is refused with a "narrow your filters" message.
#: A silently truncated file is the failure mode worth designing against: it
#: looks complete, and whoever receives it has no way to tell.
EXPORT_LIMIT = 5000

#: Refused before parsing. 2 MB of CSV is far past any real headcount and keeps
#: a hostile upload from becoming a memory problem.
MAX_UPLOAD_BYTES = 2 * 1024 * 1024


class ImportJobSerializer(serializers.ModelSerializer):
    class Meta:
        model = models.ImportJob
        fields = [
            "id",
            "filename",
            "status",
            "create_missing_departments",
            "rows",
            "summary",
            "error",
            "applied_at",
            "created_at",
        ]
        read_only_fields = fields


class ImportJobListSerializer(serializers.ModelSerializer):
    """List view — without ``rows``, which is the bulk of a job."""

    class Meta:
        model = models.ImportJob
        fields = [
            "id",
            "filename",
            "status",
            "summary",
            "error",
            "applied_at",
            "created_at",
        ]
        read_only_fields = fields


class ImportJobViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet,
):
    """Upload → preview → apply."""

    permission_classes = [HasOrgPermission]
    required_permission = "org.import.write"
    pagination_class = None
    # The project-wide parsers are JSON + nested-multipart, and neither puts an
    # uploaded file into ``request.FILES`` — this is the repo's first real file
    # upload, so the viewset declares its own (same approach as keycloak_sms).
    # JSONParser stays in the list: `create` is multipart but `apply` is JSON,
    # and dropping it makes the confirm step 415 instead of running.
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_organization(self):
        return get_caller_organization(self.request.user)

    def get_serializer_class(self):
        return (
            ImportJobListSerializer
            if self.action == "list"
            else ImportJobSerializer
        )

    def get_queryset(self):
        organization = self.get_organization()
        if organization is None:
            return models.ImportJob.objects.none()
        queryset = models.ImportJob.objects.filter(organization=organization)
        # Slice only for the list. Slicing here would break every detail route:
        # DRF's get_object_or_404 catches the "cannot filter a sliced queryset"
        # TypeError and turns it into a 404, so `apply/` would silently 404 with
        # nothing in the logs explaining why.
        return queryset[:50] if self.action == "list" else queryset

    def create(self, request, *args, **kwargs):
        """Upload a CSV and run the preflight."""
        organization = self.get_organization()
        upload = request.FILES.get("file")
        if upload is None:
            raise serializers.ValidationError({"file": _("Upload a CSV file.")})
        if upload.size > MAX_UPLOAD_BYTES:
            raise serializers.ValidationError(
                {"file": _("The file is too large (max 2 MB).")}
            )
        try:
            source = upload.read().decode("utf-8-sig")
        except UnicodeDecodeError:
            # Excel on a Chinese Windows saves GBK by default, and the resulting
            # mojibake would otherwise land in the directory as people's names.
            raise serializers.ValidationError(
                {
                    "file": _(
                        "The file is not UTF-8. Re-save it as 'CSV UTF-8' and try again."
                    )
                }
            ) from None

        job = models.ImportJob.objects.create(
            organization=organization,
            created_by=request.user,
            filename=upload.name[:255],
            source=source,
            create_missing_departments=str(
                request.data.get("create_missing_departments", "")
            ).lower()
            in ("true", "1", "yes"),
        )
        import_tasks.preflight_import_job.delay(str(job.id))
        job.refresh_from_db()
        return Response(ImportJobSerializer(job).data, status=201)

    @action(detail=True, methods=["post"])
    def apply(self, request, *args, **kwargs):
        """Confirm a previewed job."""
        job = self.get_object()
        if job.status != models.ImportJobStatusChoices.PREVIEWED:
            raise serializers.ValidationError(
                {"detail": _("Only a checked job awaiting confirmation can be applied.")}
            )
        # The client echoes the row count it saw. If the two disagree the preview
        # on screen is not the file about to be written — refuse rather than
        # apply something the admin never read.
        expected = request.data.get("expected_total")
        if expected is not None and int(expected) != (job.summary or {}).get("total"):
            raise serializers.ValidationError(
                {"detail": _("The preview is out of date. Re-upload the file.")}
            )

        import_tasks.apply_import_job.delay(str(job.id), str(request.user.id))
        job.refresh_from_db()
        # One summary audit row per job, never one per line: a 1000-row import
        # would otherwise bury every other action in the log.
        record_audit(
            actor=request.user,
            organization=self.get_organization(),
            action=models.AuditActionChoices.MEMBER_IMPORT,
            target_type="import_job",
            target_id=job.id,
            target_label=job.filename,
            metadata={"summary": job.summary},
        )
        return Response(ImportJobSerializer(job).data)

    @action(detail=False, methods=["get"])
    def template(self, request, *args, **kwargs):
        """Download the CSV template."""
        response = StreamingHttpResponse(
            iter([member_import.build_template()]), content_type="text/csv; charset=utf-8"
        )
        response["Content-Disposition"] = (
            'attachment; filename="we-meet-members-template.csv"'
        )
        return response


class _Echo:
    """csv.writer sink that returns the line instead of buffering it."""

    def write(self, value):
        return value


class MemberExportView(viewsets.GenericViewSet):
    """``GET /admin/member-export/`` — a streamed CSV of the current directory."""

    permission_classes = [HasOrgPermission]
    required_permission = "org.import.write"

    def list(self, request, *args, **kwargs):
        organization = get_caller_organization(request.user)
        if organization is None:
            return Response({"detail": _("No organization.")}, status=400)

        queryset = (
            models.Membership.objects.filter(organization=organization)
            .exclude(status=models.MembershipStatusChoices.LEFT)
            .select_related(
                "user", "department", "employee_type", "job_level", "job_sequence",
                "manager__user",
            )
            .order_by("user__full_name")
        )
        # Scoped administrators export what they administer, not the whole
        # company — otherwise export is a hole straight through the scope.
        queryset = get_admin_context(request).filter_memberships(queryset)

        department = request.query_params.get("department")
        if department:
            queryset = queryset.filter(department_id=department)

        total = queryset.count()
        if total > EXPORT_LIMIT:
            raise serializers.ValidationError(
                {
                    "detail": _(
                        "Too many rows (%(total)d). Filter by department and try again."
                    )
                    % {"total": total}
                }
            )

        record_audit(
            actor=request.user,
            organization=organization,
            action=models.AuditActionChoices.MEMBER_EXPORT,
            target_type="organization",
            target_id=organization.id,
            target_label=organization.name,
            metadata={"rows": total},
        )

        writer = csv.writer(_Echo())

        def rows():
            # BOM first so a double-click in Excel does not mangle the names.
            yield "﻿"
            yield writer.writerow(member_import.TEMPLATE_COLUMNS)
            for membership in queryset.iterator(chunk_size=200):
                yield writer.writerow(_export_row(membership))

        response = StreamingHttpResponse(
            rows(), content_type="text/csv; charset=utf-8"
        )
        response["Content-Disposition"] = 'attachment; filename="we-meet-members.csv"'
        return response


def _export_row(membership) -> list:
    """One membership as the same columns the import template accepts."""
    user = membership.user
    department = membership.department
    manager = membership.manager
    return [
        user.email or "",
        membership.employee_no,
        user.full_name or user.short_name or "",
        department.name if department else "",
        membership.title,
        membership.org_role,
        membership.employee_type.label if membership.employee_type_id else "",
        membership.job_level.label if membership.job_level_id else "",
        membership.job_sequence.label if membership.job_sequence_id else "",
        membership.hire_date.isoformat() if membership.hire_date else "",
        membership.work_country,
        membership.work_city,
        membership.alias,
        membership.work_station,
        membership.extension,
        manager.user.email if manager and manager.user.email else "",
    ]
