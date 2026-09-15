FROM python:3.10-slim

WORKDIR /app

# Install system dependencies and Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    python3-pip \
    ffmpeg \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy package.json and install Node.js dependencies
ENV MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true
ENV MESON_ARGS="-Dms_disable_liburing=true"
COPY package.json .
RUN npm install

# The mediasoup worker enables io_uring whenever the running kernel is >= 6,
# but Docker's default seccomp profile blocks the io_uring_setup syscall, so a
# liburing-enabled worker dies at startup with exit code 40
# (`Error: [pid:NN, code:40, signal:null]`). The two env vars above build the
# worker from source without liburing; verify that actually happened so a bad
# image fails here instead of crash-looping on the droplet. The grepped string
# only exists in the binary when DepLibUring.cpp was compiled in.
RUN WORKER_BIN="$(node -e 'console.log(require("mediasoup").workerBin)')" \
    && test -x "$WORKER_BIN" \
    && if grep -qa 'io_uring_queue_init() failed' "$WORKER_BIN"; then \
         echo "ERROR: mediasoup-worker was built with liburing; it will exit(40) under Docker's seccomp profile." >&2; \
         exit 1; \
       fi \
    && echo "mediasoup-worker built without liburing: OK"

# Copy application code
COPY . .

# Expose ports
# 8000: Flask API
# 4000: Media Server (Socket.io)
# 40000-40100: WebRTC Media Ports (UDP/TCP) - must match
#              MEDIASOUP_MIN_PORT / MEDIASOUP_MAX_PORT (see src/ConferenceSocket.js)
EXPOSE 8000 4000 40000-40100

# Run startup script
RUN chmod +x ./start.sh
CMD ["./start.sh"]
