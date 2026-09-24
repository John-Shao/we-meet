#!/usr/bin/env python3
"""Add Secret-backed configuration and bounded temp volumes to Egress 1.8.4."""
import sys

import yaml

documents = list(yaml.safe_load_all(sys.stdin))
matched = 0
for document in documents:
    if not document or document.get("kind") != "Deployment":
        continue
    if document["metadata"]["name"] != "meet-livekit-egress":
        continue
    matched += 1
    document["spec"]["strategy"] = {"type": "Recreate", "rollingUpdate": None}
    pod = document["spec"]["template"]["spec"]
    pod["imagePullSecrets"] = [{"name": "meet-dockerconfig"}]
    container = pod["containers"][0]
    for env in container["env"]:
        if env["name"] == "EGRESS_CONFIG_BODY":
            env["valueFrom"] = {
                "secretKeyRef": {
                    "name": "meet-livekit-egress-config",
                    "key": "config.yaml",
                }
            }
    container["volumeMounts"] = [
        {"name": "recording-tmp", "mountPath": "/home/egress/tmp"},
        {"name": "recording-out", "mountPath": "/out"},
        {"name": "shm", "mountPath": "/dev/shm"},
    ]
    pod["volumes"] = [
        {"name": "recording-tmp", "emptyDir": {"sizeLimit": "4Gi"}},
        {"name": "recording-out", "emptyDir": {"sizeLimit": "2Gi"}},
        {"name": "shm", "emptyDir": {"medium": "Memory", "sizeLimit": "512Mi"}},
    ]
    container["startupProbe"] = {
        "httpGet": {"path": "/", "port": "health"},
        "periodSeconds": 5,
        "failureThreshold": 36,
    }
if matched != 1:
    raise SystemExit("Expected exactly one meet-livekit-egress deployment")
yaml.safe_dump_all(documents, sys.stdout, sort_keys=False)
