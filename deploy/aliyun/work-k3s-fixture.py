import json
import pathlib
import subprocess
import sys
import time
import uuid
import urllib.request
import io
import tarfile
import gzip
import hashlib
import urllib.parse

import argparse

ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(
    description="Disposable local K3s fixture; never uses production kubeconfig."
)
parser.add_argument("action", choices=("setup", "cleanup"))
parser.add_argument("--state-directory", type=pathlib.Path, required=True)
parser.add_argument(
    "--gateway-image", help="Locally built gateway repository@sha256 digest"
)
parser.add_argument(
    "--worker-image",
    action="append",
    default=[],
    help="pi=repository@sha256 or dsh=repository@sha256",
)
args = parser.parse_args()
OUT = args.state_directory.resolve()
if ROOT not in OUT.parents:
    parser.error("fixture state must be within the ignored workspace")
ignored = subprocess.run(
    ["git", "-C", str(ROOT), "check-ignore", "--quiet", str(OUT / "state.json")],
    capture_output=True,
)
if ignored.returncode:
    parser.error("fixture state must be Git-ignored")
OUT.mkdir(parents=True, exist_ok=True)
LABEL = "we-meet.k3s-fixture"
K3S = "docker.io/rancher/k3s@sha256:006f8594fd764390fb87c207bbb2ba0d5c7e22c04bc8530a607ad19a59e91349"
REGISTRY = (
    "registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
)


def docker(*arguments, data=None, timeout=30):
    result = subprocess.run(
        ["docker", "--context=desktop-linux", *arguments],
        input=data,
        capture_output=True,
        timeout=timeout,
    )
    if result.returncode:
        raise RuntimeError("local_fixture_command_failed")
    return result.stdout


def cleanup(state):
    for name, expected in reversed(list(state["containers"].items())):
        rows = json.loads(docker("container", "inspect", name))
        assert (
            len(rows) == 1
            and rows[0]["Config"]["Labels"].get(LABEL) == state["marker"]
            and rows[0]["Image"] == expected
        )
        docker("container", "rm", "--force", rows[0]["Id"])
    for alias, image_id in state.get("image_aliases", {}).items():
        assert "fixture-" + state["marker"] in alias
        rows = json.loads(docker("image", "inspect", alias))
        assert rows[0]["Id"] == image_id
        docker("image", "rm", alias)
    for volume in state["volumes"]:
        rows = json.loads(docker("volume", "inspect", volume))
        assert rows[0]["Labels"].get(LABEL) == state["marker"]
        docker("volume", "rm", volume)
    rows = json.loads(docker("network", "inspect", state["network"]))
    assert rows[0]["Labels"].get(LABEL) == state["marker"]
    docker("network", "rm", rows[0]["Id"])


def export_image(reference, repository, port, marker, state):
    image = json.loads(docker("image", "inspect", reference))[0]
    alias = f"127.0.0.1:{port}/{repository}:fixture-{marker}"
    docker("image", "tag", image["Id"], alias)
    state.setdefault("image_aliases", {})[alias] = image["Id"]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    saved = docker("image", "save", alias, timeout=120)
    archive = tarfile.open(fileobj=io.BytesIO(saved))
    saved_manifest = json.load(archive.extractfile("manifest.json"))[0]
    base = f"http://127.0.0.1:{port}"

    def upload(blob, media):
        digest = "sha256:" + hashlib.sha256(blob).hexdigest()
        with opener.open(
            urllib.request.Request(
                base + "/v2/" + repository + "/blobs/uploads/", method="POST", data=b""
            ),
            timeout=10,
        ) as response:
            location = response.headers["Location"]
        target = urllib.parse.urlsplit(location)
        url = base + target.path + "?" + target.query + "&digest=" + digest
        with opener.open(
            urllib.request.Request(
                url,
                method="PUT",
                data=blob,
                headers={"Content-Type": "application/octet-stream"},
            ),
            timeout=60,
        ) as response:
            assert response.status == 201
        return {"mediaType": media, "size": len(blob), "digest": digest}

    config = upload(
        archive.extractfile(saved_manifest["Config"]).read(),
        "application/vnd.docker.container.image.v1+json",
    )
    layers = []
    for layer in saved_manifest["Layers"]:
        blob = archive.extractfile(layer).read()
        if not blob.startswith(b"\x1f\x8b"):
            blob = gzip.compress(blob, mtime=0)
        layers.append(upload(blob, "application/vnd.docker.image.rootfs.diff.tar.gzip"))
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
            "config": config,
            "layers": layers,
        },
        separators=(",", ":"),
    ).encode()
    with opener.open(
        urllib.request.Request(
            base + "/v2/" + repository + "/manifests/fixture",
            method="PUT",
            data=manifest,
            headers={
                "Content-Type": "application/vnd.docker.distribution.manifest.v2+json"
            },
        ),
        timeout=10,
    ) as response:
        assert response.status == 201
        manifest_digest = response.headers["Docker-Content-Digest"]
    saved_config = json.load(archive.extractfile(saved_manifest["Config"]))
    assert saved_config["rootfs"]["diff_ids"] == image["RootFS"]["Layers"]
    return manifest_digest, config["digest"]


if args.action == "cleanup":
    cleanup(json.loads((OUT / "state.json").read_text()))
    (OUT / "state.json").unlink()
    print("Owned K3s cluster, registry, volumes and network cleaned.")
    sys.exit(0)

if not args.gateway_image or "@sha256:" not in args.gateway_image:
    parser.error("immutable local gateway image required")
marker = uuid.uuid4().hex
state = {
    "marker": marker,
    "network": "work-k3s-net-" + marker,
    "containers": {},
    "volumes": [],
}
info = json.loads(docker("info", "--format", "{{json .}}"))
assert info["Name"] == "docker-desktop" and info["OperatingSystem"] == "Docker Desktop"
assert not (OUT / "state.json").exists()
docker("network", "create", "--label", LABEL + "=" + marker, state["network"])
try:
    registry = "work-k3s-registry-" + marker
    server = "work-k3s-server-" + marker
    for name, reference, kind in (
        (registry, REGISTRY, "registry"),
        (server, K3S, "server"),
    ):
        image_id = json.loads(docker("image", "inspect", reference))[0]["Id"]
        volume = "work-k3s-" + kind + "-state-" + marker
        docker("volume", "create", "--label", LABEL + "=" + marker, volume)
        state["volumes"].append(volume)
        options = [
            "--pull=never",
            "--name",
            name,
            "--hostname",
            name,
            "--label",
            LABEL + "=" + marker,
            "--network",
            state["network"],
        ]
        if kind == "registry":
            options += [
                "--publish",
                "127.0.0.1::5000",
                "--mount",
                f"type=volume,source={volume},target=/var/lib/registry",
            ]
            docker("container", "create", *options, image_id)
            state["containers"][name] = image_id
            docker("container", "start", name)
            port = json.loads(docker("container", "inspect", name))[0][
                "NetworkSettings"
            ]["Ports"]["5000/tcp"][0]["HostPort"]
            gateway = json.loads(docker("image", "inspect", args.gateway_image))[0]
            alias = f"127.0.0.1:{port}/gateway:fixture-{marker}"
            docker("image", "tag", gateway["Id"], alias)
            state["image_aliases"] = {alias: gateway["Id"]}
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for attempt in range(60):
                try:
                    with opener.open(
                        f"http://127.0.0.1:{port}/v2/", timeout=2
                    ) as response:
                        assert response.status == 200
                    break
                except Exception:
                    time.sleep(0.5)
            else:
                raise RuntimeError("fixture_registry_not_ready")
            state["gateway_digest"], state["gateway_config"] = export_image(
                args.gateway_image, "gateway", port, marker, state
            )
            state["gateway_repository"] = registry + ":5000/gateway"
            state["worker_images"] = {}
            for worker in args.worker_image:
                engine, reference = worker.split("=", 1)
                assert engine in {"pi", "dsh"} and "@sha256:" in reference
                worker_digest, worker_config = export_image(
                    reference, engine, port, marker, state
                )
                state["worker_images"][engine] = {
                    "image": registry + ":5000/" + engine + "@" + worker_digest,
                    "config": worker_config,
                    "source": reference,
                }
            mirror = OUT / ("registries-" + marker + ".yaml")
            mirror.write_text(
                'mirrors:\n  "'
                + registry
                + ':5000":\n    endpoint:\n      - "http://'
                + registry
                + ':5000"\n',
                encoding="utf-8",
                newline="\n",
            )
        else:
            options += [
                "--privileged",
                "--memory=4g",
                "--cpus=3",
                "--mount",
                f"type=volume,source={volume},target=/var/lib/rancher/k3s",
                "--mount",
                f"type=bind,source={mirror},target=/etc/rancher/k3s/registries.yaml,readonly",
            ]
            docker(
                "container",
                "create",
                *options,
                image_id,
                "server",
                "--disable",
                "traefik,servicelb,metrics-server",
                "--private-registry",
                "/etc/rancher/k3s/registries.yaml",
            )
            state["containers"][name] = image_id
            docker("container", "start", name)
            state["server"] = name
            state["server_ip"] = json.loads(docker("container", "inspect", name))[0][
                "NetworkSettings"
            ]["Networks"][state["network"]]["IPAddress"]
    (OUT / "state.json").write_text(
        json.dumps(state, indent=2), encoding="utf-8", newline="\n"
    )
    for attempt in range(90):
        try:
            result = json.loads(
                docker("exec", server, "kubectl", "get", "nodes", "-o", "json")
            )
            if any(
                condition["type"] == "Ready" and condition["status"] == "True"
                for node in result["items"]
                for condition in node["status"]["conditions"]
            ):
                print(
                    "Fresh local K3s node Ready; existing contexts untouched.",
                    flush=True,
                )
                break
        except RuntimeError:
            pass
        if attempt % 10 == 0:
            print("Waiting for private K3s API/node readiness.", flush=True)
        time.sleep(1)
    else:
        (OUT / "server-startup.log").write_bytes(docker("container", "logs", server))
        raise RuntimeError("local_k3s_not_ready")
except BaseException:
    cleanup(state)
    (OUT / "state.json").unlink(missing_ok=True)
    raise
