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
# 10000-19999: WebRTC Media Ports (UDP/TCP). The real range comes from
#              MEDIASOUP_MIN_PORT / MEDIASOUP_MAX_PORT at runtime; these values
#              mirror the defaults used by docker-compose. Note that the
#              deployment runs with `network_mode: host`, where EXPOSE is purely
#              documentation and the firewall (UFW / DO Cloud Firewall) is what
#              actually decides reachability.
EXPOSE 8000 4000 10000-19999

# Run startup script.
# `sed` strips CR from CRLF line endings: a start.sh checked out or copied from
# Windows gets the shebang `#!/bin/bash\r`, whose interpreter does not exist, and
# the container dies at boot with the misleading
# `exec ./start.sh: no such file or directory`. Invoking bash explicitly in CMD
# removes the remaining dependency on the shebang and the +x bit.
RUN sed -i 's/\r$//' ./start.sh && chmod +x ./start.sh
CMD ["/bin/bash", "./start.sh"]
