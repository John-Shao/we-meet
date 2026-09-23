"""Private storage: no public URLs or original filenames in object keys."""

from django.conf import settings
from django.core.files.storage import StorageHandler

from botocore.config import Config
from storages.backends.s3 import S3Storage


class PrivateMaterialStorage(S3Storage):
    """Use the deployment's S3 credentials, with explicit private object ACLs."""

    default_acl = "private"
    querystring_auth = True
    custom_domain = None
    location = "work-materials"
    client_config = Config(
        connect_timeout=5, read_timeout=15, retries={"max_attempts": 1}
    )

    def url(self, name, **kwargs):
        raise NotImplementedError(
            "Work materials must be read through authenticated APIs."
        )

    def get_object_parameters(self, name):
        return {
            **super().get_object_parameters(name),
            "ACL": "private",
            "CacheControl": "private, no-store",
        }


def material_storage():
    """A separate configurable backend; never fall back to public MEDIA_ROOT."""
    return StorageHandler(backends={"work": settings.WORK_STORAGE})["work"]
