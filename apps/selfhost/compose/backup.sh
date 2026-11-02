#!/bin/sh
# Maple in-CT logical backup (BRIEF-v4 step 8): pg_dump + ClickHouse schema DDL + alert_checks into
# /srv/maple/backups/<UTC stamp>/, keep 14 days. Runs from /etc/cron.d/maple-backup at 18:15 UTC (01:15 WIB),
# before the Proxmox vzdump of CT130 (01:45 WIB) so each vzdump archive carries a fresh dump too.
set -eu
cd /opt/maple
DIR=/srv/maple/backups/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$DIR"; chmod 700 /srv/maple/backups "$DIR"
docker compose exec -T postgres pg_dump -U maple -d maple -Fc > "$DIR/maple.pgdump"
ch() { docker compose exec -T clickhouse sh -c 'clickhouse-client --user maple_admin --password "$CH_ADMIN_PASSWORD" --query "$0"' "$1"; }
ch "SELECT create_table_query || ';' FROM system.tables WHERE database = 'maple' ORDER BY name FORMAT TSVRaw" | gzip > "$DIR/clickhouse-schema.sql.gz"
ch "SELECT * FROM maple.alert_checks FORMAT TSVWithNames" | gzip > "$DIR/alert_checks.tsv.gz"
# fail loud: an empty dump is worse than no dump
[ "$(stat -c %s "$DIR/maple.pgdump")" -gt 10000 ] || { echo "pg dump too small" >&2; exit 1; }
[ "$(zcat "$DIR/clickhouse-schema.sql.gz" | grep -c 'CREATE')" -gt 10 ] || { echo "ch schema empty" >&2; exit 1; }
find /srv/maple/backups -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -r {} +
echo "$(date -u +%FT%TZ) ok $DIR $(du -sh "$DIR" | cut -f1)"
