#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/root/paralaus-project"
BASE_URL="${BASE_URL:-https://api.appandcapital.com.tr}"
HLS_TEST_URL="${HLS_TEST_URL:-}"
AUDIO_TEST_URL="${AUDIO_TEST_URL:-}"
CHANNEL_ID="${CHANNEL_ID:-smoke-test}"

extract_job_id() {
  python3 -c 'import json,sys; print((json.load(sys.stdin) or {}).get("jobId",""))'
}

poll_job_status() {
  local status_url="$1"
  local max_attempts="${2:-20}"
  local sleep_sec="${3:-3}"
  local i

  for ((i=1; i<=max_attempts; i++)); do
    echo "== poll ${status_url} (attempt ${i}/${max_attempts}) =="
    local body
    body="$(curl -fsS "${status_url}")"
    echo "${body}"
    local status
    status="$(printf '%s' "${body}" | python3 -c 'import json,sys; print((json.load(sys.stdin) or {}).get("status",""))')"
    if [[ "${status}" == "done" ]]; then
      return 0
    fi
    if [[ "${status}" == "failed" ]]; then
      return 1
    fi
    sleep "${sleep_sec}"
  done

  echo "Job timed out while polling: ${status_url}" >&2
  return 1
}

echo "== cd ${APP_DIR} =="
cd "${APP_DIR}"

echo "== systemd reload =="
sudo systemctl daemon-reload

echo "== restart services =="
sudo systemctl restart media-worker
sudo systemctl restart media-server
sudo systemctl restart tensorflow-api

echo "== service status =="
sudo systemctl status media-worker --no-pager
sudo systemctl status media-server --no-pager
sudo systemctl status tensorflow-api --no-pager

echo "== recent logs =="
sudo journalctl -u media-worker -n 80 --no-pager
sudo journalctl -u media-server -n 80 --no-pager
sudo journalctl -u tensorflow-api -n 80 --no-pager

echo "== worker health =="
curl -fsS "${BASE_URL}/health/worker"
echo

echo "== media health =="
curl -fsS "${BASE_URL}/health"
echo

if [[ -n "${HLS_TEST_URL}" ]]; then
  echo "== async hls smoke test =="
  HLS_RESPONSE="$(curl -fsS -X POST "${BASE_URL}/hls/from-url?async=true" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"${HLS_TEST_URL}\",\"channelId\":\"${CHANNEL_ID}\",\"messageId\":\"hls-smoke\"}")"
  echo "${HLS_RESPONSE}"
  HLS_JOB_ID="$(printf '%s' "${HLS_RESPONSE}" | extract_job_id)"
  if [[ -z "${HLS_JOB_ID}" ]]; then
    echo "HLS smoke test did not return jobId" >&2
    exit 1
  fi
  poll_job_status "${BASE_URL}/hls/status/${HLS_JOB_ID}"
fi

if [[ -n "${AUDIO_TEST_URL}" ]]; then
  echo "== async audio smoke test =="
  AUDIO_RESPONSE="$(curl -fsS -X POST "${BASE_URL}/audio/transcode/from-url?async=true" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"${AUDIO_TEST_URL}\",\"channelId\":\"${CHANNEL_ID}\",\"messageId\":\"audio-smoke\"}")"
  echo "${AUDIO_RESPONSE}"
  AUDIO_JOB_ID="$(printf '%s' "${AUDIO_RESPONSE}" | extract_job_id)"
  if [[ -z "${AUDIO_JOB_ID}" ]]; then
    echo "Audio smoke test did not return jobId" >&2
    exit 1
  fi
  poll_job_status "${BASE_URL}/audio/transcode/status/${AUDIO_JOB_ID}"
fi

echo "== done =="
