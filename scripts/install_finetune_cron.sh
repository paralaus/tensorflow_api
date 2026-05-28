#!/usr/bin/env bash
set -euo pipefail

# Installs/updates a daily cron entry for fine-tune automation.
# Defaults to every day at 03:30 server time.
#
# Usage:
#   bash scripts/install_finetune_cron.sh
#   CRON_SCHEDULE="0 4 * * *" bash scripts/install_finetune_cron.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRON_SCHEDULE="${CRON_SCHEDULE:-30 3 * * *}"
CRON_TAG="# hissechat-finetune-job"
CRON_CMD="cd \"$ROOT_DIR\" && /bin/bash scripts/run_finetune_cron.sh $CRON_TAG"

TMP_FILE="$(mktemp)"
crontab -l 2>/dev/null | grep -v "$CRON_TAG" >"$TMP_FILE" || true
echo "$CRON_SCHEDULE $CRON_CMD" >>"$TMP_FILE"
crontab "$TMP_FILE"
rm -f "$TMP_FILE"

echo "Cron installed:"
crontab -l | grep "$CRON_TAG" || true
