#!/usr/bin/env bash
# E8 staging-only onboarding helper. Requires an explicit confirmation flag.
set -euo pipefail
if [[ "${WORK_ONBOARDING_CONFIRM:-}" != "1" ]]; then
  echo "refusing to create an organization; set WORK_ONBOARDING_CONFIRM=1" >&2
  exit 1
fi
: "${ORG_NAME:?set ORG_NAME}"
: "${ORG_SLUG:?set ORG_SLUG}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/src/backend"
python manage.py shell -c "
import os
import sys
from core.models import Organization
from work.jobs.directory_sync import sync_org
name = os.environ['ORG_NAME']
slug = os.environ['ORG_SLUG']
org, created = Organization.objects.get_or_create(slug=slug, defaults={'name': name})
sync_org(org)
sys.stdout.write('org_id=' + str(org.id) + ' created=' + str(created) + '\n')
"
