"""Disposable TCP relay: TLS stays end-to-end between local Vite and backend.

The only destination is the backend IP on the owned internal network. This
process has no API credentials, keys, URL routing or HTTP response generation.
"""

# ruff: noqa: S104, T201
import ipaddress
import json
import os
import select
import socket
import socketserver
import time


def main():
    destination = ipaddress.ip_address(os.environ["VOICEPRINT_WEB_BACKEND_IP"])
    if (
        not destination.is_private
        or destination.is_loopback
        or destination.is_unspecified
    ):
        raise ValueError("web_relay_destination_rejected")

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            with socket.create_connection(
                (str(destination), 8000), timeout=10
            ) as upstream:
                # Bound a connection's lifetime and idle time; no destination supplied by clients.
                deadline = time.monotonic() + 300
                sockets = (self.request, upstream)
                while time.monotonic() < deadline:
                    readable, _, _ = select.select(sockets, [], [], 30)
                    if not readable:
                        break
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.request else self.request).sendall(
                            data
                        )

    with socketserver.ThreadingTCPServer(("0.0.0.0", 8000), Handler) as server:
        server.daemon_threads = True
        print(json.dumps({"event": "local_tls_relay_ready"}), flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
