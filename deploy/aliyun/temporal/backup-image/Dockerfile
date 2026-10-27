FROM python:3.11-alpine

# Install PostgreSQL client
RUN apk add --no-cache postgresql-client

# Install boto3 using Aliyun mirror for faster downloads in China
RUN pip3 install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com boto3

# Create backup script directory
RUN mkdir -p /scripts
WORKDIR /scripts

# Default command
CMD ["python3", "--version"]
