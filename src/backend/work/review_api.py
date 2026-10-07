"""Account-scoped review APIs; no browser-selectable models, endpoints or paths."""

from django.db import transaction
from django.shortcuts import get_object_or_404

from rest_framework import serializers
from rest_framework.response import Response

from core.models import User

from . import review_runs, runs
from .api import MaterialViewSet
from .models import WorkReview
from .task_api import RunViewSet


class FileInput(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    sha256 = serializers.RegexField("^[a-f0-9]{64}$")


class ReviewInput(serializers.Serializer):
    files = FileInput(many=True, min_length=1, max_length=8)

    def validate_files(self, value):
        if len({item["name"] for item in value}) != len(value):
            raise serializers.ValidationError("duplicate_file")
        return sorted(value, key=lambda item: item["name"])


class ReviewView(RunViewSet):
    def reviews(self, request, pk=None):
        if request.method == "GET":
            run = self.get_object()
            runs.sources_for(run.task)
            return Response(
                [review_runs.public_data(item) for item in run.reviews.all()]
            )
        form = ReviewInput(data=request.data)
        form.is_valid(raise_exception=True)
        key = MaterialViewSet.request_key(request)
        with transaction.atomic():
            User.objects.select_for_update().get(pk=request.user.pk)
            run = get_object_or_404(self.get_queryset().select_for_update(), pk=pk)
            runs.sources_for(run.task)
            review, created = review_runs.new_review(
                run, key, form.validated_data["files"]
            )
        return Response(review_runs.public_data(review), status=202 if created else 200)

    def cancel_review(self, request, pk=None, review_id=None):
        with transaction.atomic():
            run = self.get_object()
            review = get_object_or_404(
                WorkReview.objects.select_for_update(), pk=review_id, source_run=run
            )
            if review.status in runs.ACTIVE:
                runs.terminal(review, "canceled")
        return Response(review_runs.public_data(review))
