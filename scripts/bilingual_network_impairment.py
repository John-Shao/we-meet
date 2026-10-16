"""Apply real packet loss/jitter only in a disposable Docker TCP proxy."""

import json
import subprocess
import time
import uuid


class NetworkProxy:
    """Own one container, never modify host or phone network configuration."""

    def __init__(self, gateway_port):
        """Use a unique name and a loopback-only published port."""
        self.name = f"bilingual-netem-{uuid.uuid4().hex}"
        self.gateway_port = gateway_port
        self.port = None
        self.report = {
            "backend": "docker_tc_netem",
            "delay_ms": 100,
            "jitter_ms": 25,
            "packet_loss_percent": 3,
            "random_seed": 20261016,
            "scope": "TCP proxy egress on both legs; WSS data stays encrypted",
            "applied": False,
            "removed": False,
        }

    @staticmethod
    def command(*arguments):
        """Keep command output private unless it is deliberate safe telemetry."""
        return subprocess.check_output(  # noqa: S603, S607 -- fixed Docker commands
            ["docker", *arguments], text=True, timeout=30, stderr=subprocess.PIPE
        )

    def start(self):
        """Start the proxy, then attach qdisc in its isolated network namespace."""
        self.command(
            "run",
            "-d",
            "--name",
            self.name,
            "--cap-add",
            "NET_ADMIN",
            "--read-only",
            "--tmpfs",
            "/tmp",
            "--security-opt",
            "no-new-privileges",
            "-p",
            "127.0.0.1::9443",
            "-e",
            f"GATEWAY_PORT={self.gateway_port}",
            "bilingual-netem:20261016",
        )
        binding = json.loads(self.command("inspect", self.name))[0]["NetworkSettings"][
            "Ports"
        ]["9443/tcp"]
        if len(binding) != 1 or binding[0]["HostIp"] != "127.0.0.1":
            raise RuntimeError("Proxy must be bound exclusively to loopback")
        self.port = int(binding[0]["HostPort"])
        self.command(
            "exec",
            self.name,
            "tc",
            "qdisc",
            "add",
            "dev",
            "eth0",
            "root",
            "handle",
            "7b10:",
            "netem",
            "limit",
            "1000",
            "delay",
            "100ms",
            "25ms",
            "loss",
            "3%",
            "seed",
            "20261016",
        )
        self.report["applied"] = True
        # Only the new container's readiness is awaited.
        for _ in range(20):
            try:
                self.command(
                    "exec",
                    self.name,
                    "python",
                    "-c",
                    "import socket; socket.create_connection(('127.0.0.1',9443),1).close()",
                )
                return
            except subprocess.CalledProcessError:
                time.sleep(0.1)
        raise RuntimeError("Proxy did not become ready")

    def close(self):
        """Capture actual kernel drop counters, then remove this container only."""
        try:
            if self.report["applied"]:
                self.report["qdisc"] = json.loads(
                    self.command(
                        "exec",
                        self.name,
                        "tc",
                        "-j",
                        "-s",
                        "qdisc",
                        "show",
                        "dev",
                        "eth0",
                    )
                )
        finally:
            self.command("rm", "-f", self.name)
            self.report["removed"] = True
