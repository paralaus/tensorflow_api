#!/bin/bash

# Detect Public IP for Mediasoup
export MEDIASOUP_ANNOUNCED_IP=$(curl -s ifconfig.me)
echo "Media Server Public IP: $MEDIASOUP_ANNOUNCED_IP"

# Ensure dependencies are installed (optional check)
# npm install

# Start the Media Server
# Using absolute path for node if possible, but environment usually handles it
# We use npm start which runs "node media-server.js"
npm start
