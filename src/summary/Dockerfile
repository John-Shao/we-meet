FROM python:3.13-alpine3.23 AS base

# ---- LOCAL-DEV ONLY (China network workaround) — REVERT BEFORE UPSTREAM PR ----
RUN sed -i 's|https://dl-cdn.alpinelinux.org|https://mirrors.aliyun.com|g' /etc/apk/repositories
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV PIP_TRUSTED_HOST=mirrors.aliyun.com
ENV PIP_RETRIES=5
ENV PIP_DEFAULT_TIMEOUT=120
ENV UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/
ENV UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV UV_HTTP_TIMEOUT=120
# ---- END LOCAL-DEV PATCH ----

# Install ffmpeg for audio/video processing (format conversion, extraction, compression)
# See summary/core/file_service.py for usage.
RUN apk add --no-cache "ffmpeg=8.0.1-r1"

FROM base AS builder

WORKDIR /app

COPY pyproject.toml .

RUN pip install --no-cache-dir .

FROM base AS development
WORKDIR /app

COPY . .
RUN pip install --no-cache-dir -e ".[dev]" || pip install --no-cache-dir -e .

CMD ["uvicorn", "summary.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM base AS production

WORKDIR /app

COPY --from=builder /usr/local /usr/local

# Remove pip to reduce attack surface in production
RUN pip uninstall -y pip

# Un-privileged user running the application
ARG DOCKER_USER
USER ${DOCKER_USER}

COPY ./summary /app/summary

CMD ["uvicorn", "summary.main:app", "--proxy-headers", "--host", "0.0.0.0", "--port", "8000"]
