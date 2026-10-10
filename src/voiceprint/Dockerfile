# CPU only, offline model loading. Build context: src/voiceprint.
FROM python:3.13.13-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy

FROM base AS builder
COPY --from=ghcr.io/astral-sh/uv:0.10.9 /uv /bin/uv
WORKDIR /app
RUN uv venv --python /usr/local/bin/python /opt/venv
COPY requirements-linux-py313.lock /app/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip sync --python /opt/venv/bin/python --require-hashes \
    --torch-backend cpu requirements-linux-py313.lock
COPY pyproject.toml /app/
COPY voiceprint /app/voiceprint
RUN uv pip install --python /opt/venv/bin/python --no-deps --no-build-isolation /app

FROM builder AS verification
COPY requirements-test-linux-py313.lock /app/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip sync --python /opt/venv/bin/python --require-hashes \
    --torch-backend cpu requirements-test-linux-py313.lock
# sync removes packages absent from the dependency lock, including the local app.
RUN uv pip install --python /opt/venv/bin/python --no-deps --no-build-isolation /app
COPY tests /app/tests
ENV HOME=/tmp/voiceprint \
    NUMBA_CACHE_DIR=/tmp/voiceprint-numba \
    OPENBLAS_NUM_THREADS=2 \
    OMP_NUM_THREADS=2
USER 10001:10001
ENTRYPOINT ["/opt/venv/bin/python"]
CMD ["-m", "pytest", "-q", "-p", "no:cacheprovider"]

FROM base AS production
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /app/voiceprint /app/voiceprint
ENV PATH="/opt/venv/bin:$PATH" \
    HOME=/tmp/voiceprint \
    NUMBA_CACHE_DIR=/tmp/voiceprint-numba \
    MPLCONFIGDIR=/tmp/voiceprint-matplotlib \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    NUMEXPR_NUM_THREADS=2
USER 10001:10001
EXPOSE 8093
# Non-loopback listener rejects startup without mounted TLS and private credentials.
ENTRYPOINT ["meet-voiceprint"]
CMD ["--host", "0.0.0.0", "--port", "8093"]
