#!/usr/bin/env bash
# Ежедневный бэкап: консистентная копия SQLite → шифрование → выгрузка наружу → хранение 14+ копий.
# Нужны на хосте: docker compose, gpg, rclone (настроенный remote). Cron: 0 4 * * * /opt/planb/scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${BACKUP_PASSPHRASE_FILE:?путь к файлу с паролем шифрования}"
: "${RCLONE_REMOTE:?например myremote:planb-backups}"
KEEP="${KEEP:-14}"
STAMP=$(date +%Y%m%d-%H%M%S)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

docker compose exec -T app node apps/server/dist/backup.js /data/backup.tmp.db
docker compose cp app:/data/backup.tmp.db "$TMP/planb.db"
docker compose exec -T app rm -f /data/backup.tmp.db
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --symmetric --cipher-algo AES256 -o "$TMP/planb-$STAMP.db.gpg" "$TMP/planb.db"
rclone copy "$TMP/planb-$STAMP.db.gpg" "$RCLONE_REMOTE"
# удаляем старые копии, оставляя последние $KEEP
rclone lsf "$RCLONE_REMOTE" --files-only | sort | head -n -"$KEEP" | while read -r f; do rclone deletefile "$RCLONE_REMOTE/$f"; done
echo "backup $STAMP ok"
