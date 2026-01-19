#!/bin/bash

# Detect Public IP for Mediasoup (Critical for WebRTC on Droplet)
if [ -z "$MEDIASOUP_ANNOUNCED_IP" ]; then
  export MEDIASOUP_ANNOUNCED_IP=$(curl -s ifconfig.me)
  echo "Public IP auto-detected: $MEDIASOUP_ANNOUNCED_IP"
fi

# Start Gunicorn (Flask App) in background
echo "Starting Flask API..."
gunicorn -c gunicorn.conf.py app:app &

# Start Node.js Media Server in foreground
echo "Starting Media Server..."
# Ensure SSL certificates exist
npm run generate-cert
npm start
