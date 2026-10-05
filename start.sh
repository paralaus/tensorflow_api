#!/bin/bash

# Detect Public IP for Mediasoup (Critical for WebRTC on Droplet)
# Load .env file if exists and variable is not set
if [ -z "$MEDIASOUP_ANNOUNCED_IP" ] && [ -f .env ]; then
  # Basic parsing of .env file for MEDIASOUP_ANNOUNCED_IP
  IP_FROM_ENV=$(grep "^MEDIASOUP_ANNOUNCED_IP=" .env | cut -d '=' -f2)
  if [ ! -z "$IP_FROM_ENV" ]; then
    export MEDIASOUP_ANNOUNCED_IP=$IP_FROM_ENV
    echo "Public IP loaded from .env: $MEDIASOUP_ANNOUNCED_IP"
  fi
fi

if [ -z "$MEDIASOUP_ANNOUNCED_IP" ]; then
  export MEDIASOUP_ANNOUNCED_IP=$(curl -s ifconfig.me)
  echo "Public IP auto-detected: $MEDIASOUP_ANNOUNCED_IP"
fi

# mediasoup writes the reason a worker failed to the worker process stderr,
# which the library routes through the `debug` module. Without DEBUG the
# container log only shows `Error: [pid:NN, code:40, signal:null]` and the
# actual cause is lost. Errors/warnings only, so this stays quiet in normal
# operation; override with DEBUG=mediasoup* for full tracing.
export DEBUG="${DEBUG:-mediasoup:ERROR*,mediasoup:WARN*}"

# Fail loudly and early if the SFU worker cannot start at all (non-fatal: the
# Flask API and the non-conference endpoints still work without it).
echo "Running mediasoup worker preflight..."
node scripts/check-mediasoup-worker.js \
  || echo "WARNING: mediasoup worker preflight FAILED - conferences will not work (see output above)."

# Start Gunicorn (Flask App) in background
echo "Starting Flask API..."
gunicorn -c gunicorn.conf.py app:app &

# Start Node.js Media Server in foreground
echo "Starting Media Server..."
# Ensure SSL certificates exist
if [ ! -f "ssl/cert.pem" ] || [ ! -f "ssl/key.pem" ]; then
  echo "SSL certificates not found. Generating self-signed certificates..."
  npm run generate-cert
else
  echo "SSL certificates found. Skipping generation."
fi
npm start
