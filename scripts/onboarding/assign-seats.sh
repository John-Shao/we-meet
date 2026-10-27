#!/usr/bin/env bash
# E8 staging-only seat projection helper. Work seats are active memberships.
set -euo pipefail
: "${ORG_SLUG:?set ORG_SLUG}"
: "${SUBJECT_ID:?set SUBJECT_ID}"
ROLE="${ROLE:-member}"
if [[ "${WORK_ONBOARDING_CONFIRM:-}" != "1" ]]; then
  echo "refusing to change seats; set WORK_ONBOARDING_CONFIRM=1" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/src/backend"
python manage.py shell -c "
import os
import sys
from core.models import Membership, Organization
from work.jobs.directory_sync import sync_member
slug = os.environ['ORG_SLUG']
subject = os.environ['SUBJECT_ID']
role = os.environ['ROLE']
org = Organization.objects.get(slug=slug)
membership = Membership.objects.get(organization=org, user__sub=subject)
membership.org_role = role
membership.save(update_fields=['org_role', 'updated_at'])
sync_member(membership)
sys.stdout.write('projected {} {}\n'.format(membership.user.sub, membership.org_role))
"
