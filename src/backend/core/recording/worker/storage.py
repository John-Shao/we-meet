"""Select Egress's native OSS uploader for Alibaba storage endpoints."""

from urllib.parse import urlsplit

from livekit import api


def file_upload_options(bucket_args):
    """Keep S3-compatible providers unchanged; OSS uses its native signer."""
    hostname = urlsplit(bucket_args.get("endpoint", "")).hostname or ""
    if hostname.startswith("oss-") and hostname.endswith(".aliyuncs.com"):
        return {
            "aliOSS": api.AliOSSUpload(
                **{
                    key: bucket_args[key]
                    for key in ("endpoint", "access_key", "secret", "region", "bucket")
                    if key in bucket_args
                }
            )
        }
    return {"s3": api.S3Upload(**bucket_args)}
