# Gunicorn-django settings
import os

bind = ["0.0.0.0:8000"]
name = "meet"
python_path = "/app"

# Run
graceful_timeout = 90
timeout = 90
workers = int(os.environ.get("GUNICORN_WORKERS", "3"))
# Graceful recycling bounds long-lived worker growth; in-flight requests drain.
max_requests = int(os.environ.get("GUNICORN_MAX_REQUESTS", "0"))
max_requests_jitter = int(os.environ.get("GUNICORN_MAX_REQUESTS_JITTER", "0"))

# Logging
# Using '-' for the access log file makes gunicorn log accesses to stdout
accesslog = "-"
# Using '-' for the error log file makes gunicorn log errors to stderr
errorlog = "-"
loglevel = "info"
