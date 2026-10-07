"""Task-scoped provider proxy: credentials, cumulative admission and metering."""

import hmac
import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .config import PROVIDERS
from .contract import MAX_RESULT_BYTES, ContractError, canonical
from .review import response_format

MAX_MODEL_REQUEST = 1_000_000
MAX_MODEL_RESPONSE = 4_000_000


def usage_from_provider(usage, provider="deepseek"):
    """Normalized input excludes separately reported cache hits; total is exact."""
    if not isinstance(usage, dict):
        return None
    prompt, output = usage.get("prompt_tokens"), usage.get("completion_tokens")
    if any(type(value) is not int or value < 0 for value in (prompt, output)):
        return None
    if provider == "qwen":
        details = usage.get("prompt_tokens_details", {})
        if not isinstance(details, dict):
            return None
        cached = details.get("cached_tokens", 0)
    elif provider == "deepseek":
        cached = usage.get("prompt_cache_hit_tokens", 0)
    else:
        return None
    if type(cached) is not int or not 0 <= cached <= prompt:
        return None
    total = usage.get("total_tokens", prompt + output)
    if type(total) is not int or total != prompt + output:
        return None
    return {
        "input_tokens": prompt - cached,
        "output_tokens": output,
        "cache_read_tokens": cached,
        "cache_write_tokens": 0,
    }


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ModelBroker:
    def __init__(
        self,
        config,
        store,
        provider=None,
        *,
        bind_host="0.0.0.0",
        approval_gate=None,
        bind_port=0,
        tls_context=None,
        public_base_url=None,
        task_transport=None,
    ):
        self.config = config
        # The local desktop service and older test configs use DeepSeek implicitly.
        self.provider_name = getattr(config, "provider", "deepseek")
        self.store = store
        self.approval_gate = approval_gate
        self.public_base_url = public_base_url
        self.task_transport = task_transport
        self.tokens = {}
        self.lock = threading.Lock()
        self.provider = provider or self.open_provider
        self.server = ThreadingHTTPServer((bind_host, bind_port), self.handler())
        if tls_context:
            self.server.socket = tls_context.wrap_socket(
                self.server.socket, server_side=True, do_handshake_on_connect=False
            )
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def issue(self, run_id):
        token = secrets.token_urlsafe(32)
        with self.lock:
            self.tokens[run_id] = token
        return (
            token,
            (
                self.public_base_url
                or f"http://host.docker.internal:{self.server.server_port}"
            )
            + f"/model/{run_id}",
        )

    def revoke(self, run_id):
        with self.lock:
            self.tokens.pop(run_id, None)

    def authorize(self, run_id, authorization):
        with self.lock:
            expected = self.tokens.get(run_id)
        return bool(expected) and hmac.compare_digest(
            authorization.encode(), ("Bearer " + expected).encode()
        )

    def open_provider(self, body, timeout):
        request = Request(
            self.config.base_url.rstrip("/") + "/chat/completions",
            data=body,
            headers={
                "Authorization": "Bearer "
                + os.environ[PROVIDERS[self.provider_name][0]],
                "Content-Type": "application/json",
            },
        )
        return build_opener(NoRedirect()).open(request, timeout=timeout)

    def handler(self):
        broker = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def failure(self, code, status=400):
                payload = canonical(
                    {
                        "error": {
                            "message": code,
                            "code": code,
                            "type": "agent_model_error",
                        }
                    }
                )
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):
                self.connection.settimeout(5)
                self.close_connection = True
                sequence = None
                run_id = ""
                headers_sent = False
                usage = None
                try:
                    parts = self.path.split("/")
                    if len(parts) == 4 and parts[1] == "task" and broker.task_transport:
                        if self.headers.get("Transfer-Encoding"):
                            raise ContractError("invalid_request")
                        size = int(self.headers.get("Content-Length", "0"))
                        if not 0 < size <= MAX_RESULT_BYTES + 10_000:
                            raise ContractError("task_request_too_large", 413)
                        result = broker.task_transport.exchange(
                            parts[2],
                            parts[3],
                            self.headers.get("Authorization", ""),
                            json.loads(self.rfile.read(size)),
                        )
                        payload = canonical(result)
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                        return
                    if len(parts) < 4 or parts[1] != "model":
                        raise ContractError("not_found", 404)
                    run_id = parts[2]
                    if "/".join(parts[3:]) not in {
                        "chat/completions",
                        "v1/chat/completions",
                    }:
                        raise ContractError("not_found", 404)
                    if not broker.authorize(
                        run_id, self.headers.get("Authorization", "")
                    ):
                        raise ContractError("unauthorized", 401)
                    if self.headers.get("Transfer-Encoding"):
                        raise ContractError("invalid_request")
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 0 < size <= MAX_MODEL_REQUEST:
                        raise ContractError("model_request_too_large", 413)
                    body = json.loads(self.rfile.read(size))
                    if (
                        not isinstance(body, dict)
                        or body.get("model") != broker.config.model
                    ):
                        raise ContractError("model_not_allowed", 403)
                    if (
                        not isinstance(body.get("messages"), list)
                        or not body["messages"]
                    ):
                        raise ContractError("invalid_request")
                    if body.get("n", 1) != 1:
                        raise ContractError("invalid_request")
                    if broker.store.operation(run_id) == "review" and any(
                        body.get(key)
                        for key in (
                            "tools",
                            "functions",
                            "tool_choice",
                            "function_call",
                        )
                    ):
                        raise ContractError("review_tool_forbidden", 403)
                    if broker.store.operation(run_id) == "review":
                        body["response_format"] = response_format(
                            broker.provider_name, broker.config.model
                        )
                    if broker.provider_name == "qwen":
                        # This evaluation uses Qwen's JSON mode without thinking or
                        # provider-side search. Client flags cannot widen the policy.
                        body.pop("reasoning_effort", None)
                        body.pop("thinking", None)
                        body["enable_thinking"] = False
                        body["enable_search"] = False
                    deadline = broker.store.request_deadline(run_id)
                    if broker.approval_gate:
                        deadline += broker.approval_gate.paused_seconds(run_id)
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        raise ContractError("deadline_exceeded", 409)
                    limits = broker.store.limits(run_id)
                    body.pop("max_completion_tokens", None)
                    body["max_tokens"] = limits["max_output_tokens"]
                    streaming = body.get("stream", False) is True
                    if streaming:
                        body["stream_options"] = {"include_usage": True}
                    encoded = canonical(body)
                    sequence = broker.store.reserve_model_call(run_id, encoded)
                    with broker.provider(encoded, min(remaining, 20)) as response:
                        if broker.approval_gate:
                            data = response.read(MAX_MODEL_RESPONSE + 1)
                            if len(data) > MAX_MODEL_RESPONSE:
                                raise ContractError("model_response_too_large", 502)
                            if streaming:
                                for line in data.splitlines():
                                    if (
                                        line.startswith(b"data: ")
                                        and line.strip() != b"data: [DONE]"
                                    ):
                                        reported = usage_from_provider(
                                            json.loads(line[6:]).get("usage"),
                                            broker.provider_name,
                                        )
                                        if reported is not None:
                                            usage = reported
                            else:
                                usage = usage_from_provider(
                                    json.loads(data).get("usage"), broker.provider_name
                                )
                            if usage is not None:
                                broker.store.record_model_usage(run_id, sequence, usage)
                            broker.approval_gate.review(
                                run_id,
                                data,
                                streaming,
                                {
                                    t.get("function", {}).get("name")
                                    for t in body.get("tools", [])
                                },
                            )
                            if broker.store.get(run_id)[
                                "state"
                            ] != "running" or not broker.authorize(
                                run_id, self.headers.get("Authorization", "")
                            ):
                                raise ContractError("approval_cancelled", 409)
                            self.send_response(200)
                            self.send_header(
                                "Content-Type",
                                "text/event-stream"
                                if streaming
                                else "application/json",
                            )
                            self.send_header("Cache-Control", "no-store")
                            self.end_headers()
                            headers_sent = True
                            self.wfile.write(data)
                            return
                        self.send_response(200)
                        self.send_header(
                            "Content-Type",
                            "text/event-stream" if streaming else "application/json",
                        )
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        headers_sent = True
                        if not streaming:
                            data = response.read(MAX_MODEL_RESPONSE + 1)
                            if len(data) > MAX_MODEL_RESPONSE:
                                raise ContractError("model_response_too_large", 502)
                            usage = usage_from_provider(
                                json.loads(data).get("usage"), broker.provider_name
                            )
                            if usage is not None:
                                broker.store.record_model_usage(run_id, sequence, usage)
                            self.wfile.write(data)
                        else:
                            size_read = 0
                            disconnected = False
                            while line := response.readline(200_001):
                                if time.time() >= deadline:
                                    raise ContractError("deadline_exceeded", 409)
                                size_read += len(line)
                                if (
                                    len(line) > 200_000
                                    or size_read > MAX_MODEL_RESPONSE
                                ):
                                    raise ContractError("model_response_too_large", 502)
                                if (
                                    line.startswith(b"data: ")
                                    and line.strip() != b"data: [DONE]"
                                ):
                                    chunk = json.loads(line[6:])
                                    reported = usage_from_provider(
                                        chunk.get("usage"), broker.provider_name
                                    )
                                    if reported is not None:
                                        usage = reported
                                if (
                                    line.strip() == b"data: [DONE]"
                                    and usage is not None
                                ):
                                    broker.store.record_model_usage(
                                        run_id, sequence, usage
                                    )
                                if not disconnected:
                                    try:
                                        self.wfile.write(line)
                                        self.wfile.flush()
                                    except (BrokenPipeError, ConnectionResetError):
                                        disconnected = True
                except ContractError as exc:
                    if not headers_sent:
                        self.failure(exc.code, exc.status)
                except HTTPError as exc:
                    status = exc.code
                    exc.close()
                    if not headers_sent:
                        self.failure("provider_http_error", status)
                except Exception:
                    if not headers_sent:
                        self.failure("provider_execution_unknown", 502)
                finally:
                    if sequence is not None and usage is not None:
                        broker.store.record_model_usage(run_id, sequence, usage)

        return Handler
