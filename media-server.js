const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { S3 } = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Configuration
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'thisisasamplesecret';
const MEDIASOUP_MIN_PORT = parseInt(process.env.MEDIASOUP_MIN_PORT) || 10000;
const MEDIASOUP_MAX_PORT = parseInt(process.env.MEDIASOUP_MAX_PORT) || 10100;
const MEDIASOUP_LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
const MEDIASOUP_ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1';

const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT;
const SPACES_KEY = process.env.SPACES_KEY;
const SPACES_SECRET = process.env.SPACES_SECRET;
const SPACES_BUCKET = process.env.SPACES_BUCKET;
const SPACES_REGION = process.env.SPACES_REGION;

let spacesClient;

function getSpacesClient() {
  if (!SPACES_ENDPOINT || !SPACES_KEY || !SPACES_SECRET || !SPACES_BUCKET || !SPACES_REGION) {
    return null;
  }
  if (spacesClient) {
    return spacesClient;
  }
  const endpoint = new URL(`https://${SPACES_ENDPOINT}`);
  spacesClient = new S3({
    endpoint: endpoint.origin,
    region: SPACES_REGION,
    credentials: {
      accessKeyId: SPACES_KEY,
      secretAccessKey: SPACES_SECRET,
    },
  });
  return spacesClient;
}

function getSpacesUrl(key) {
  if (!SPACES_BUCKET || !SPACES_ENDPOINT) {
    return null;
  }
  return `https://${SPACES_BUCKET}.${SPACES_ENDPOINT}/${key}`;
}

// Mediasoup Config
const mediasoupConfig = {
  worker: {
    rtcMinPort: MEDIASOUP_MIN_PORT,
    rtcMaxPort: MEDIASOUP_MAX_PORT,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  },
  router: {
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
      { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 2, 'x-google-start-bitrate': 1000 } },
      { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '4d0032', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 } },
    ],
  },
  webRtcTransport: {
    listenIps: [{ ip: MEDIASOUP_LISTEN_IP, announcedIp: MEDIASOUP_ANNOUNCED_IP }],
    initialAvailableOutgoingBitrate: 1000000,
  },
};

// Global State
let workers = [];
let nextWorkerIndex = 0;
const rooms = new Map(); // roomId -> { router, peers: Map<socketId, { transports, producers, consumers }> }

// Initialize Mediasoup Workers
async function runMediasoupWorkers() {
  //const numWorkers = Math.min(os.cpus().length, 4);
  const numWorkers = 1;
  console.log(`Creating ${numWorkers} mediasoup workers...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: mediasoupConfig.worker.logLevel,
      logTags: mediasoupConfig.worker.logTags,
      rtcMinPort: mediasoupConfig.worker.rtcMinPort,
      rtcMaxPort: mediasoupConfig.worker.rtcMaxPort,
    });

    worker.on('died', () => {
      console.error('Mediasoup worker died, exiting...');
      process.exit(1);
    });

    workers.push(worker);
  }
}

function getNextWorker() {
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

// Conference Namespace
const conferenceNsp = io.of('/conference');

conferenceNsp.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
  if (!token) return next(new Error('Authentication required'));

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.sub;
    // We don't have DB access here, so we trust the token. 
    // Ideally token should contain name/avatar or client sends them in handshake query.
    socket.userName = socket.handshake.query.name || 'User';
    socket.userAvatar = socket.handshake.query.avatar || null;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

conferenceNsp.on('connection', (socket) => {
  console.log(`User connected: ${socket.userId} (${socket.userName})`);

  socket.on('join-room', async ({ roomId }) => {
    socket.join(roomId);
    
    // Create/Get Router
    let router;
    if (rooms.has(roomId)) {
      router = rooms.get(roomId).router;
    } else {
      const worker = getNextWorker();
      router = await worker.createRouter({ mediaCodecs: mediasoupConfig.router.mediaCodecs });
      rooms.set(roomId, { router, peers: new Map() });
      console.log(`Created router for room ${roomId}`);
    }

    const room = rooms.get(roomId);
    room.peers.set(socket.id, { transports: [], producers: [], consumers: [] });

    // Send SFU mode confirmation (Always SFU in this service)
    socket.emit('room-joined', {
      roomId,
      mode: 'sfu',
      participants: [] // Client will get participants via user-joined events or can request them
    });

    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userId: socket.userId,
      userName: socket.userName,
      userAvatar: socket.userAvatar,
    });
  });

  socket.on('disconnect', () => {
    // Cleanup
    rooms.forEach((room, roomId) => {
      if (room.peers.has(socket.id)) {
        const peer = room.peers.get(socket.id);
        peer.transports.forEach(t => t.close());
        room.peers.delete(socket.id);
        
        if (room.peers.size === 0) {
          room.router.close();
          rooms.delete(roomId);
          console.log(`Room ${roomId} closed`);
        }
      }
    });
  });

  // SFU Handlers
  socket.on('sfu:get-rtp-capabilities', (callback) => {
    // Find room for this socket
    let room;
    for (const r of rooms.values()) {
      if (r.peers.has(socket.id)) {
        room = r;
        break;
      }
    }
    
    if (!room) return callback({ error: 'Not in a room' });
    callback({ rtpCapabilities: room.router.rtpCapabilities });
  });

  socket.on('sfu:create-send-transport', async (callback) => {
    try {
        let room;
        for (const r of rooms.values()) {
          if (r.peers.has(socket.id)) {
            room = r;
            break;
          }
        }
        if (!room) throw new Error('Not in room');

        const transport = await room.router.createWebRtcTransport(mediasoupConfig.webRtcTransport);
        
        // Store transport
        const peer = room.peers.get(socket.id);
        peer.transports.push(transport);

        transport.on('dtlsstatechange', (dtlsState) => {
            if (dtlsState === 'closed') transport.close();
        });

        callback({
            transport: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            }
        });
    } catch (err) {
        callback({ error: err.message });
    }
  });

  socket.on('sfu:create-recv-transport', async (callback) => {
    try {
        let room;
        for (const r of rooms.values()) {
          if (r.peers.has(socket.id)) {
            room = r;
            break;
          }
        }
        if (!room) throw new Error('Not in room');

        const transport = await room.router.createWebRtcTransport(mediasoupConfig.webRtcTransport);
        const peer = room.peers.get(socket.id);
        peer.transports.push(transport);

        transport.on('dtlsstatechange', (dtlsState) => {
            if (dtlsState === 'closed') transport.close();
        });

        callback({
            transport: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            }
        });
    } catch (err) {
        callback({ error: err.message });
    }
  });

  socket.on('sfu:connect-transport', async ({ transportId, dtlsParameters }, callback) => {
      try {
        let room;
        for (const r of rooms.values()) {
          if (r.peers.has(socket.id)) {
            room = r;
            break;
          }
        }
        if (!room) throw new Error('Not in room');
        
        const peer = room.peers.get(socket.id);
        const transport = peer.transports.find(t => t.id === transportId);
        
        if (!transport) throw new Error('Transport not found');
        
        await transport.connect({ dtlsParameters });
        callback({ success: true });
      } catch (err) {
          callback({ error: err.message });
      }
  });

  socket.on('sfu:produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
      try {
        let room;
        for (const r of rooms.values()) {
          if (r.peers.has(socket.id)) {
            room = r;
            break;
          }
        }
        if (!room) throw new Error('Not in room');

        const peer = room.peers.get(socket.id);
        const transport = peer.transports.find(t => t.id === transportId);

        if (!transport) throw new Error('Transport not found');

        const producer = await transport.produce({ kind, rtpParameters, appData });
        peer.producers.push(producer);

        producer.on('transportclose', () => producer.close());

        // Notify others
        socket.to(Array.from(room.peers.keys())).emit('sfu:new-producer', {
            producerId: producer.id,
            producerSocketId: socket.id,
            kind: producer.kind,
            appData: producer.appData
        });

        callback({ producerId: producer.id });
      } catch (err) {
          callback({ error: err.message });
      }
  });

  socket.on('sfu:consume', async ({ producerId, rtpCapabilities, transportId }, callback) => {
      try {
        let room;
        for (const r of rooms.values()) {
            if (r.peers.has(socket.id)) {
                room = r;
                break;
            }
        }
        if (!room) throw new Error('Not in room');
        
        const peer = room.peers.get(socket.id);
        const transport = peer.transports.find(t => t.id === transportId);

        if (!transport) throw new Error('Transport not found');

        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
            throw new Error('Cannot consume');
        }

        const consumer = await transport.consume({
            producerId,
            rtpCapabilities,
            paused: true, // Start paused
        });

        peer.consumers.push(consumer);
        
        consumer.on('transportclose', () => consumer.close());
        consumer.on('producerclose', () => {
            socket.emit('sfu:consumer-closed', { consumerId: consumer.id });
            consumer.close();
        });

        callback({
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            type: consumer.type,
            producerPaused: consumer.producerPaused
        });
        
        // Resume immediately
        await consumer.resume();

      } catch (err) {
          callback({ error: err.message });
      }
  });
  
  // Also handle legacy signaling for chat/etc if needed, 
  // but preferably keep that in main backend? 
  // Actually, chat messages might be easier here if we want them in the same socket connection.
  // But for now, let's assume chat goes through main backend or we duplicate the logic.
  // For now, only media logic.
});

function ensureDirectory(dirPath) {
  return fs.promises.mkdir(dirPath, { recursive: true });
}

function createTempDirectory(prefix) {
  const dirPath = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return ensureDirectory(dirPath).then(() => dirPath);
}

function downloadFile(url, destinationPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const fileStream = fs.createWriteStream(destinationPath);

    const request = client.get(url, (response) => {
      if (response.statusCode !== 200) {
        fileStream.close(() => {});
        fs.unlink(destinationPath, () => {});
        return reject(new Error(`Download failed with status code ${response.statusCode}`));
      }

      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(() => resolve());
      });
    });

    request.on('error', (err) => {
      fileStream.close(() => {});
      fs.unlink(destinationPath, () => {});
      reject(err);
    });
  });
}

async function uploadFileToSpaces(filePath, key, contentType) {
  const client = getSpacesClient();
  if (!client) {
    throw new Error('Spaces configuration is missing');
  }
  const body = await fs.promises.readFile(filePath);
  await client.putObject({
    Bucket: SPACES_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    ACL: 'public-read',
  });
  return getSpacesUrl(key);
}

async function uploadHlsDirectoryToSpaces(dir, keyPrefix) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  await Promise.all(
    files.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.m3u8') {
        contentType = 'application/vnd.apple.mpegurl';
      } else if (ext === '.ts') {
        contentType = 'video/MP2T';
      }
      const key = `${keyPrefix}/${entry.name}`;
      await uploadFileToSpaces(fullPath, key, contentType);
    })
  );
  const playlistKey = `${keyPrefix}/index.m3u8`;
  return getSpacesUrl(playlistKey);
}

function parseFfmpegDuration(stderr) {
  if (!stderr) {
    return null;
  }
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!match) {
    return null;
  }
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseFloat(match[3]);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(totalSeconds) && totalSeconds > 0
    ? totalSeconds
    : null;
}

function runFfmpegHls(inputPath, outputDir, segmentDurationSeconds = 6) {
  return new Promise((resolve, reject) => {
    let stderrBuffer = '';
    const args = [
      '-y',
      '-i',
      inputPath,
      '-profile:v',
      'baseline',
      '-level',
      '3.0',
      '-start_number',
      '0',
      '-hls_time',
      String(segmentDurationSeconds),
      '-hls_list_size',
      '0',
      '-f',
      'hls',
      path.join(outputDir, 'index.m3u8'),
    ];

    const ffmpeg = spawn('ffmpeg', args);

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuffer += text;
      console.log(`[ffmpeg] ${text}`);
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        const durationSeconds = parseFfmpegDuration(stderrBuffer);
        resolve({ durationSeconds });
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

app.post('/hls/from-url', async (req, res) => {
  const { url, channelId, messageId } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url_required' });
  }

  try {
    const workDir = await createTempDirectory('hissechat-hls');
    const sourcePath = path.join(workDir, 'source.mp4');

    await downloadFile(url, sourcePath);

    const hlsDir = path.join(workDir, 'hls');
    await ensureDirectory(hlsDir);

    const { durationSeconds } = await runFfmpegHls(sourcePath, hlsDir, 6);

    const baseKey =
      channelId && messageId
        ? `hls/channel/${channelId}/${messageId}`
        : `hls/misc/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let playlistUrl = null;

    try {
      playlistUrl = await uploadHlsDirectoryToSpaces(hlsDir, baseKey);
    } finally {
      try {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('HLS temp cleanup error', cleanupError);
      }
    }

    if (!playlistUrl) {
      return res.status(500).json({ error: 'hls_upload_failed' });
    }

    return res.json({
      playlistUrl,
      durationSeconds,
    });
  } catch (err) {
    console.error('HLS conversion error', err);
    return res.status(500).json({ error: 'hls_conversion_failed' });
  }
});

// Health Check
app.get('/health', (req, res) => res.status(200).send('Media Server OK'));

// Start Server
runMediasoupWorkers().then(() => {
  server.listen(PORT, () => {
    console.log(`Media Server running on port ${PORT}`);
  });
});
