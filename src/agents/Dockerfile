FROM python:3.13.13-slim AS base

# ---- LOCAL-DEV ONLY (China network workaround) — REVERT BEFORE UPSTREAM PR ----
# debian.sources → aliyun mirror to avoid deb.debian.org timeouts;
# pip → aliyun PyPI to avoid ConnectionReset on pip install livekit-agents etc.
RUN sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g; s|http://security.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources && \
    printf 'Acquire::Retries "5";\nAcquire::http::Timeout "120";\nAcquire::https::Timeout "120";\n' > /etc/apt/apt.conf.d/80-retries
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV PIP_TRUSTED_HOST=mirrors.aliyun.com
ENV PIP_RETRIES=5
ENV PIP_DEFAULT_TIMEOUT=120
# ---- END LOCAL-DEV PATCH ----

# Install system dependencies required by LiveKit
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libgobject-2.0-0 \
    && rm -rf /var/lib/apt/lists/*

FROM base AS builder

WORKDIR /builder

COPY pyproject.toml .

RUN mkdir /install && \
  pip install --prefix=/install .

FROM base AS development

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir ".[dev]"

COPY . .

CMD ["python", "metadata_collector.py", "dev"]

FROM base AS production

WORKDIR /app

COPY --from=builder /install /usr/local

# Remove pip to reduce attack surface in production
RUN pip uninstall -y pip

# Un-privileged user running the application
ARG DOCKER_USER
USER ${DOCKER_USER}

COPY ./*.py /app/

CMD ["python", "multi_user_transcriber.py", "start"]
