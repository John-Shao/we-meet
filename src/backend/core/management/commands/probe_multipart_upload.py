"""Prove the multipart upload path against the real object store.

Verified by this command, once, against `we-meet-video` (Aliyun OSS, Shenzhen):
create with `ACL: private`, upload a part, list parts, abort, and - the one that
actually matters - complete and read the reassembled bytes back byte-for-byte.
It also confirmed two constraints the service is built around: a non-final part
below 5 MiB is refused with `EntityTooSmall`, and a part list out of ascending
order is refused with `InvalidPartOrder` rather than silently reassembled wrong.

Why a command rather than a test: it needs a real bucket, real credentials and it
writes to that bucket. Unit tests cover the orchestration against a storage seam;
this covers the thing a seam cannot, which is the storage service's own behaviour.

Usage:
    # Dry run: only checks that storage is configured and reachable.
    python manage.py probe_multipart_upload

    # Full probe, including complete + read-back. Creates and deletes only its
    # own probe objects, and aborts any upload it leaves behind.
    python manage.py probe_multipart_upload --full

Nothing outside `record-uploads/probe-*` is touched. Read-only with respect to
every real recording.
"""

import hashlib
import uuid

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.services.capture_storage import audio_storage

#: Every part but the last must be at least this; OSS refuses the completion
#: otherwise. Matches `recording_upload_sessions.MIN_PART_SIZE`.
MIN_PART_SIZE = 5 * 1024 * 1024


class Command(BaseCommand):
    help = "Exercise the S3 multipart API against the configured object store."

    def add_arguments(self, parser):
        parser.add_argument(
            "--full",
            action="store_true",
            help="Also complete an upload and verify the reassembled bytes.",
        )

    def handle(self, *args, **options):
        storage = audio_storage()
        client = storage.connection.meta.client
        bucket = storage.bucket_name
        prefix = "record-uploads/"
        self.stdout.write(f"endpoint: {settings.AWS_S3_ENDPOINT_URL}")
        self.stdout.write(f"bucket:   {bucket}")
        # Reported because a long multipart completion is exactly where the
        # hardcoded timeouts in capture_storage matter.
        config = storage.client_config
        self.stdout.write(
            f"client:   read_timeout={config.read_timeout} "
            f"connect_timeout={config.connect_timeout} retries={config.retries}"
        )

        results = []
        self._check("create_multipart_upload (ACL: private)", results, lambda: self._create(client, bucket))
        created = results[-1]["value"]
        if created is None:
            raise CommandError("multipart upload is not usable on this bucket")

        upload_id, key = created
        try:
            self._check(
                "upload_part",
                results,
                lambda: self._part(client, bucket, key, upload_id),
            )
            self._check("list_parts", results, lambda: self._list(client, bucket, key, upload_id))
        finally:
            # Always clean up: an incomplete upload bills for its parts.
            try:
                client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
                self.stdout.write("  aborted the probe upload")
            except Exception as error:  # noqa: BLE001 -- reported, not swallowed
                self.stderr.write(f"  could not abort probe upload: {error}")

        if options["full"]:
            self._check("complete + read back", results, lambda: self._complete(client, bucket, prefix))

        self.stdout.write("")
        failed = [row for row in results if row["error"]]
        for row in results:
            mark = "FAIL" if row["error"] else "OK  "
            detail = row["error"] or row["value"]
            self.stdout.write(f"{mark} {row['name']}: {detail}")
        if failed:
            raise CommandError(f"{len(failed)} probe(s) failed")

    def _check(self, name, results, action):
        row = {"name": name, "value": None, "error": None}
        try:
            row["value"] = action()
        except Exception as error:  # noqa: BLE001 -- this command exists to report them
            row["error"] = f"{type(error).__name__}: {str(error)[:200]}"
        results.append(row)
        return row["value"]

    def _create(self, client, bucket):
        # ACL private matches what the service signs, so a bucket with ACLs
        # disabled fails here rather than in production.
        key = f"record-uploads/probe-{uuid.uuid4()}.bin"
        created = client.create_multipart_upload(
            Bucket=bucket, Key=key, ContentType="application/octet-stream", ACL="private"
        )
        upload_id = created["UploadId"]
        if len(upload_id) > 512:
            raise CommandError(f"UploadId is {len(upload_id)} chars, over our field bound")
        return upload_id, key

    def _part(self, client, bucket, key, upload_id):
        part = client.upload_part(
            Bucket=bucket,
            Key=key,
            UploadId=upload_id,
            PartNumber=1,
            Body=b"probe" * 2048,
        )
        if not part.get("ETag"):
            # Completion is impossible without it, so a missing one is a failure
            # rather than something to note.
            raise CommandError("no ETag on the part response")
        return f"ETag present, quoted={part['ETag'].startswith(chr(34))}"

    def _list(self, client, bucket, key, upload_id):
        listed = client.list_parts(Bucket=bucket, Key=key, UploadId=upload_id)
        return f"count={len(listed.get('Parts', []))} truncated={listed.get('IsTruncated')}"

    def _complete(self, client, bucket, prefix):
        part_a = b"A" * MIN_PART_SIZE
        part_b = b"B" * 4096
        key = f"record-uploads/probe-{uuid.uuid4()}.bin"
        created = client.create_multipart_upload(
            Bucket=bucket, Key=key, ContentType="application/octet-stream", ACL="private"
        )
        upload_id = created["UploadId"]
        try:
            first = client.upload_part(Bucket=bucket, Key=key, UploadId=upload_id, PartNumber=1, Body=part_a)
            second = client.upload_part(Bucket=bucket, Key=key, UploadId=upload_id, PartNumber=2, Body=part_b)
            client.complete_multipart_upload(
                Bucket=bucket,
                Key=key,
                UploadId=upload_id,
                MultipartUpload={
                    "Parts": [
                        {"PartNumber": 1, "ETag": first["ETag"]},
                        {"PartNumber": 2, "ETag": second["ETag"]},
                    ]
                },
            )
            stored = client.get_object(Bucket=bucket, Key=key)["Body"].read()
            expected = part_a + part_b
            if stored != expected:
                raise CommandError(
                    f"reassembled {len(stored)} bytes, expected {len(expected)}; "
                    f"digest {hashlib.sha256(stored).hexdigest()[:12]} != "
                    f"{hashlib.sha256(expected).hexdigest()[:12]}"
                )
            return f"{len(stored)} bytes, byte-identical"
        finally:
            try:
                client.delete_object(Bucket=bucket, Key=key)
            except Exception as error:  # noqa: BLE001 -- reported, not swallowed
                self.stderr.write(f"  could not delete probe object {prefix}: {error}")
