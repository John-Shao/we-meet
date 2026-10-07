FROM python:3.13.5-slim-bookworm@sha256:4c2cf9917bd1cbacc5e9b07320025bdb7cdf2df7b0ceaccb55e9dd7e30987419 AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/job/runtime-home
WORKDIR /opt/gateway

FROM docker:28.5.1-cli@sha256:9190b0613792e658a7783cf14b2d5ace5941bb68ede7276922ea36ee457d76ad AS docker-cli

FROM base AS gateway
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY work_agent ./work_agent
ENTRYPOINT ["python", "-m", "work_agent.server"]

FROM base AS kubernetes-gateway
COPY work_agent ./work_agent
ENTRYPOINT ["python", "-m", "work_agent.server"]

FROM base AS dsh
COPY requirements-dsh.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock
COPY work_agent ./work_agent

FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS pi-packages
WORKDIR /opt/pi
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM base AS pi
COPY --from=pi-packages /usr/local/bin/node /usr/local/bin/node
COPY --from=pi-packages /opt/pi /opt/pi
COPY work_agent ./work_agent
