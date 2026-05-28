#!/usr/bin/env bash
set -euo pipefail

# Runs fine-tune pipeline with a lock so overlapping executions are prevented.
# Usage:
#   bash scripts/run_finetune_cron.sh
# Optional env overrides:
#   PYTHON_BIN, BACKEND_ENV, MONGO_URI, MONGO_DB, COLLECTION, MODEL_NAME, ADAPTER_OUTPUT, EPOCHS, TRAIN_PRECISION, EXTRA_ARGS

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="${LOCK_FILE:-/tmp/hissechat-finetune.lock}"
LOG_FILE="${LOG_FILE:-$ROOT_DIR/logs/hissechat-finetune.log}"
if [[ -z "${PYTHON_BIN:-}" ]]; then
  if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
    PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
  else
    PYTHON_BIN="python3"
  fi
fi

BACKEND_ENV="${BACKEND_ENV:-backend/.env}"
MONGO_URI="${MONGO_URI:-}"
MONGO_DB="${MONGO_DB:-}"
COLLECTION="${COLLECTION:-ai_training_logs}"
MODEL_NAME="${MODEL_NAME:-Qwen/Qwen2.5-7B-Instruct}"
ADAPTER_OUTPUT="${ADAPTER_OUTPUT:-outputs/hissechat-lora}"
EPOCHS="${EPOCHS:-2}"
TRAIN_PRECISION="${TRAIN_PRECISION:-none}"  # none|bf16|fp16
EXTRA_ARGS="${EXTRA_ARGS:-}"

mkdir -p "$(dirname "$LOG_FILE")"
cd "$ROOT_DIR"

# Fallback: if MONGO_URI is not provided, try reading from local .env
if [[ -z "$MONGO_URI" && -f "$ROOT_DIR/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "${key:-}" ]] && continue
    [[ "${key:0:1}" == "#" ]] && continue
    case "$key" in
      MONGODB_URI|MONGODB_URL)
        val="${value:-}"
        val="${val%\"}"
        val="${val#\"}"
        if [[ -n "$val" ]]; then
          MONGO_URI="$val"
          break
        fi
        ;;
    esac
  done < "$ROOT_DIR/.env"
fi

# Infer DB from URI when possible
if [[ -z "$MONGO_DB" && -n "$MONGO_URI" ]]; then
  uri_no_query="${MONGO_URI%%\?*}"
  MONGO_DB="${uri_no_query##*/}"
fi

if [[ -z "$MONGO_URI" || -z "$MONGO_DB" ]]; then
  {
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] finetune cron run started"
    echo "[error] MONGO_URI/MONGO_DB could not be resolved. Set env vars or .env MONGODB_URI/MONGODB_URL."
  } >>"$LOG_FILE" 2>&1
  exit 1
fi

PRECISION_ARG=""
if [[ "$TRAIN_PRECISION" == "bf16" ]]; then
  PRECISION_ARG="--bf16"
elif [[ "$TRAIN_PRECISION" == "fp16" ]]; then
  PRECISION_ARG="--fp16"
fi

{
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] finetune cron run started"
  /usr/bin/flock -n "$LOCK_FILE" \
    "$PYTHON_BIN" scripts/run_finetune_pipeline.py \
      --backend-env "$BACKEND_ENV" \
      --mongo-uri "$MONGO_URI" \
      --db "$MONGO_DB" \
      --collection "$COLLECTION" \
      --mode qa \
      --user-field question \
      --assistant-field answer \
      --context-field context \
      --raw-output data/raw/chat_qa.jsonl \
      --prepared-dir data/finetune \
      --model-name "$MODEL_NAME" \
      --adapter-output "$ADAPTER_OUTPUT" \
      --epochs "$EPOCHS" \
      $PRECISION_ARG \
      $EXTRA_ARGS
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] finetune cron run finished"
} >>"$LOG_FILE" 2>&1
