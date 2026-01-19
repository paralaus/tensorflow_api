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

# Start Gunicorn (Flask App) in background
echo "Starting Flask API..."
gunicorn -c gunicorn.conf.py app:app &

# Start Node.js Media Server in foreground
echo "Starting Media Server..."
# Ensure SSL certificates exist
npm run generate-cert
npm start
