"""Native OSS selection must not change other storage providers."""

import pytest
from livekit import api

from core.recording.worker.storage import file_upload_options


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://oss-cn-shenzhen.aliyuncs.com",
        "https://oss-cn-shenzhen-internal.aliyuncs.com",
    ],
)
def test_oss_uses_native_uploader_without_s3_path_style(endpoint):
    output = api.EncodedFileOutput(
        **file_upload_options(
            {
                "endpoint": endpoint,
                "access_key": "fixture",
                "secret": "fixture-secret",
                "region": "cn-shenzhen",
                "bucket": "fixture-bucket",
                "force_path_style": True,
            }
        )
    )
    assert output.WhichOneof("output") == "aliOSS"
    assert output.aliOSS.endpoint == endpoint
    assert output.aliOSS.bucket == "fixture-bucket"
    assert output.aliOSS.secret == "fixture-secret"


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://minio:9000",
        "https://s3.us-east-1.amazonaws.com",
        "https://oss-cn-shenzhen.aliyuncs.com.example.org",
        "",
    ],
)
def test_other_providers_keep_s3_configuration(endpoint):
    args = {"endpoint": endpoint, "bucket": "fixture", "force_path_style": True}
    output = api.EncodedFileOutput(**file_upload_options(args))
    assert output.WhichOneof("output") == "s3"
    assert output.s3 == api.S3Upload(**args)
