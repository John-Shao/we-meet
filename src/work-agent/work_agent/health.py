"""Authenticated TLS readiness probe. Never prints credentials or responses."""

import argparse
import http.client
import json
import os
import socket
import ssl

from . import CONTRACT


def probe(host, port, server_name, ca_file):
    context = ssl.create_default_context(cafile=ca_file)
    with socket.create_connection((host, port), timeout=3) as raw:
        with context.wrap_socket(raw, server_hostname=server_name) as connection:
            request = http.client.HTTPConnection(server_name, port, timeout=3)
            request.sock = connection
            request.request(
                "GET",
                "/v1/capabilities",
                headers={"Authorization": "Bearer " + os.environ["WORK_AGENT_TOKEN"]},
            )
            response = request.getresponse()
            data = response.read(65537)
            if response.status != 200 or len(data) > 65536:
                raise ValueError("gateway_unready")
            if json.loads(data).get("contract") != CONTRACT:
                raise ValueError("gateway_unready")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--server-name", required=True)
    parser.add_argument("--ca-file", required=True)
    args = parser.parse_args()
    try:
        probe(args.host, args.port, args.server_name, args.ca_file)
    except Exception:
        parser.exit(1, "gateway_unready\n")


if __name__ == "__main__":
    main()
