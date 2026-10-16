FROM python:3.13.5-alpine3.21
RUN apk add --no-cache iproute2
COPY proxy.py /app/proxy.py
ENTRYPOINT ["python", "/app/proxy.py"]
