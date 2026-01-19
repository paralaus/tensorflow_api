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

# Copy application code
COPY . .

# Expose ports
# 8000: Flask API
# 4000: Media Server (Socket.io)
# 10000-10100: WebRTC Media Ports (UDP/TCP)
EXPOSE 8000 4000 10000-10100

# Run startup script
RUN chmod +x ./start.sh
CMD ["./start.sh"]
