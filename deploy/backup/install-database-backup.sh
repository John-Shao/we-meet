#!/usr/bin/env bash
# Install code and units; initial backup/restore acceptance precedes timer activation.
set -euo pipefail
service=${1:?Usage: install-database-backup.sh docs|im|keycloak}
case "$service" in docs|im|keycloak) ;; *) exit 2 ;; esac
test "$(id -u)" = 0
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
config_dir=/etc/meet-db-backup/$service
for file in config.json storage.json notification.json recipient.txt; do
    test -f "$config_dir/$file"
done
command -v age >/dev/null
python3 -c 'import boto3'
PYTHONPATH="$source_dir" python3 - "$service" <<'PY'
import json,sys
from pathlib import Path
from database_backup import validate
from notify import load_config
service=sys.argv[1]
root=Path('/etc/meet-db-backup')/service
config=json.loads((root/'config.json').read_text())
validate(config,service,json.loads((root/'storage.json').read_text()))
assert config['config_dir']==str(root)
assert config['state_dir']=='/var/lib/meet-db-backup/'+service
assert config['work_dir']=='/run/meet-db-backup-'+service
assert config['recipient_file']==str(root/'recipient.txt')
load_config(root/'notification.json')
PY
chmod 0700 "$config_dir"
chmod 0600 "$config_dir/"*.json "$config_dir/recipient.txt"
install -d -m 0700 /opt/meet-db-backup /var/lib/meet-db-backup /var/lib/meet-db-backup/"$service"
for file in backup.py database_backup.py database_notify.py notify.py; do
    install -m 0700 "$source_dir/$file" /opt/meet-db-backup/
done
install -m 0644 "$source_dir/"meet-db-backup*.service "$source_dir/"meet-db-backup*.timer /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/meet-db-backup@.service \
    /etc/systemd/system/meet-db-backup-check@.service /etc/systemd/system/meet-db-backup-notify@.service \
    /etc/systemd/system/meet-db-backup@.timer /etc/systemd/system/meet-db-backup-check@.timer \
    /etc/systemd/system/meet-db-backup-notify@.timer
systemctl daemon-reload
echo "DATABASE_BACKUP_INSTALLED $service (timers require initial acceptance)"
