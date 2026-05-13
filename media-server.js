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
const MEDIASOUP_MIN_PORT = parseInt(process.env.MEDIASOUP_MIN_PORT, 10) || 10000;
const MEDIASOUP_MAX_PORT = parseInt(process.env.MEDIASOUP_MAX_PORT, 10) || 10100;
const MEDIASOUP_LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
const MEDIASOUP_ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1';

const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT;
const SPACES_KEY = process.env.SPACES_KEY;
const SPACES_SECRET = process.env.SPACES_SECRET;
const SPACES_BUCKET = process.env.SPACES_BUCKET;
const SPACES_REGION = process.env.SPACES_REGION;

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseIntegerEnv(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const HLS_SEGMENT_DURATION_SECONDS = parseIntegerEnv(process.env.HLS_SEGMENT_DURATION_SECONDS, 6);
const HLS_ENABLE_ABR = parseBooleanEnv(process.env.HLS_ENABLE_ABR, false);
const HLS_GENERATE_THUMBNAIL = parseBooleanEnv(process.env.HLS_GENERATE_THUMBNAIL, true);
const MEDIASOUP_ENABLE_VP9 = parseBooleanEnv(process.env.MEDIASOUP_ENABLE_VP9, true);
const HLS_SEGMENT_TYPE =
  String(process.env.HLS_SEGMENT_TYPE || 'mpegts').trim().toLowerCase() === 'fmp4'
    ? 'fmp4'
    : 'mpegts';
const LIVE_HLS_BASE_URL =
  String(process.env.LIVE_HLS_BASE_URL || '').trim()
  || String(process.env.MEDIA_PUBLIC_BASE_URL || '').trim()
  || `http://localhost:${PORT}/live`;

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

// ICE Servers Configuration (STUN + TURN)
// Uses environment variables if set, otherwise falls back to defaults
const TURN_URL = process.env.TURN_SERVER_URL || 'turn:api.appandcapital.com.tr:3478';
const TURN_USER = process.env.TURN_SERVER_USERNAME || 'paralaus';
const TURN_PASS = process.env.TURN_SERVER_CREDENTIAL || 'Pi3AlFa1970!';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Own coturn server
  {
    urls: TURN_URL,
    username: TURN_USER,
    credential: TURN_PASS
  },
  {
    urls: TURN_URL + '?transport=tcp',
    username: TURN_USER,
    credential: TURN_PASS
  },
  {
    urls: TURN_URL.replace('turn:', 'turns:').replace(':3478', ':5349'),
    username: TURN_USER,
    credential: TURN_PASS
  }
];

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
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        parameters: {
          useinbandfec: 1,
          usedtx: 1,
          stereo: 1,
          'sprop-stereo': 1,
          maxplaybackrate: 48000,
        },
      },
      // VP8 (Genel uyumluluk için)
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
      // VP9 (Daha iyi sıkıştırma, cihaz destekliyse otomatik tercih edilebilir)
      ...(MEDIASOUP_ENABLE_VP9
        ? [{ kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 0, 'x-google-start-bitrate': 1000 } }]
        : []),
      // H264 Constrained Baseline Profile Level 3.1 (Packetization Mode 1)
      { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 } },
      // H264 Constrained Baseline Profile Level 3.1 (Packetization Mode 0 - Bazı eski Androidler için)
      { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 0, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 } },
      // H264 Main Profile Level 3.1
      { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '4d001f', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 } }
    ],
  },
  webRtcTransport: {
    listenIps: [{ ip: MEDIASOUP_LISTEN_IP, announcedIp: MEDIASOUP_ANNOUNCED_IP }],
    enableUdp: true,
    enableTcp: true, // Enable TCP fallback for firewall issues
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
    maxIncomingBitrate: 1500000,
  },
};

// Global State
let workers = [];
let nextWorkerIndex = 0;
const rooms = new Map(); // roomId -> { router, peers: Map<socketId, { transports, producers, consumers }> }
const socketRoomMap = new Map(); // socketId -> roomId
const typingUsersByRoom = new Map(); // roomId -> Set<userId>
const roomHostByRoom = new Map(); // roomId -> host userId (first joiner fallback)
const liveBroadcastSessions = new Map(); // roomId -> { sessionId, roomId, hlsUrl, playbackUrl, ... }

// Grace period before tearing down an empty room. Lets a broadcaster (or any
// viewer in a regular call) reconnect after a short network blip without
// losing the mediasoup router, transports, FFmpeg pipeline and HLS playlist.
const ROOM_TEARDOWN_GRACE_MS = 60 * 1000;
const roomTeardownTimers = new Map(); // roomId -> Timeout

function cancelRoomTeardown(roomId, reason) {
  const t = roomTeardownTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    roomTeardownTimers.delete(roomId);
    console.log(`[room ${roomId}] teardown cancelled (${reason || 'rejoin'})`);
  }
}

function scheduleRoomTeardown(roomId) {
  // If a timer is already pending, keep it (don't extend the window every
  // time a stray socket disconnect fires).
  if (roomTeardownTimers.has(roomId)) return;
  console.log(`[room ${roomId}] scheduling teardown in ${ROOM_TEARDOWN_GRACE_MS}ms`);
  const timer = setTimeout(() => {
    roomTeardownTimers.delete(roomId);
    const room = rooms.get(roomId);
    // Only tear down if the room is still empty when the timer fires.
    if (!room) return;
    if (room.peers.size > 0) {
      console.log(`[room ${roomId}] teardown skipped (peers rejoined)`);
      return;
    }
    if (liveHlsPipelines.has(roomId)) {
      stopLiveHlsForRoom(roomId).catch(() => {});
    }
    try { room.router.close(); } catch (_) {}
    rooms.delete(roomId);
    roomHostByRoom.delete(roomId);
    console.log(`Room ${roomId} closed (after grace period)`);
  }, ROOM_TEARDOWN_GRACE_MS);
  roomTeardownTimers.set(roomId, timer);
}

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
    socket.isAdmin = !!(decoded.is_admin || decoded.role === 'admin' || decoded.admin);
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
  console.log(`User connected: ${socket.userId} (${socket.userName}) [Admin: ${socket.isAdmin}]`);

  const normalizeAlias = (value) => {
    const text = String(value || '').trim();
    return text.startsWith('sfu-') ? text.slice(4) : text;
  };

  const resolveTargetSocketInRoom = (roomId, rawTarget) => {
    const target = normalizeAlias(rawTarget);
    if (!roomId || !target) return null;

    // Direct socket id path.
    const directSocket = conferenceNsp.sockets.get(target);
    if (directSocket && socketRoomMap.get(target) === roomId) {
      return { targetSocketId: target, targetUserId: String(directSocket.userId || '') };
    }

    // userId path via sockets in room.
    const room = rooms.get(roomId);
    if (!room) return null;
    for (const socketId of room.peers.keys()) {
      const peerSocket = conferenceNsp.sockets.get(socketId);
      if (!peerSocket) continue;
      if (normalizeAlias(peerSocket.userId) === target) {
        return { targetSocketId: socketId, targetUserId: String(peerSocket.userId || target) };
      }
    }
    return null;
  };

  const canManageRoom = (roomId) => {
    if (!roomId) return false;
    if (socket.isAdmin) return true;
    const roomHostId = String(roomHostByRoom.get(roomId) || '');
    return Boolean(roomHostId && roomHostId === socket.userId);
  };

  socket.on('join-room', async (data, callback) => {
    // Handle both roomId and roomName (mobile app uses roomName)
    const roomId = data.roomId || data.roomName;
    const { userName } = data;
    
    if (!roomId) {
        console.error('join-room: Missing roomId/roomName');
        if (typeof callback === 'function') callback({ error: 'Missing roomId' });
        return;
    }

    socket.join(roomId);
    socketRoomMap.set(socket.id, roomId);

    // Someone is rejoining — cancel any pending teardown so the existing
    // router + HLS pipeline stay alive.
    cancelRoomTeardown(roomId, 'join-room');

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
    // Cleanup existing peer if any
    if (room.peers.has(socket.id)) {
        const oldPeer = room.peers.get(socket.id);
        oldPeer.transports.forEach(t => t.close());
    }
    
    room.peers.set(socket.id, { transports: [], producers: [], consumers: [] });

    if (!roomHostByRoom.has(roomId)) {
      roomHostByRoom.set(roomId, socket.userId);
    }

    console.log(`[MediaServer] User joined room ${roomId}: ${socket.userName} (Socket: ${socket.id})`);

    // Send SFU mode confirmation (Always SFU in this service)
    const responseData = {
      roomId,
      mode: 'sfu',
      isAdmin: socket.isAdmin,
      hostId: roomHostByRoom.get(roomId) || null,
      iceServers: ICE_SERVERS, // CRITICAL: Include TURN servers for NAT traversal
      participants: [] // Client will get participants via user-joined events or can request them
    };
    
    console.log(`[MediaServer] Sending room-joined with ${ICE_SERVERS.length} ICE servers`);
    socket.emit('room-joined', responseData);
    if (typeof callback === 'function') callback(responseData);

    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userId: socket.userId,
      userName: socket.userName || userName, // Use socket.userName (from token) or fallback to data
      userAvatar: socket.userAvatar,
      isAdmin: socket.isAdmin,
    });
  });

  socket.on('disconnect', () => {
    console.log(`[MediaServer] Socket disconnected: ${socket.id}`);
    const leftRoomId = socketRoomMap.get(socket.id);
    if (leftRoomId) {
      socket.to(leftRoomId).emit('user-left', {
        socketId: socket.id,
        userId: socket.userId,
      });
      socketRoomMap.delete(socket.id);
      if (typingUsersByRoom.has(leftRoomId)) {
        const nextTypingUsers = typingUsersByRoom.get(leftRoomId);
        nextTypingUsers.delete(socket.userId);
        conferenceNsp.to(leftRoomId).emit('typing-users', {
          users: Array.from(nextTypingUsers),
        });
      }
    }
    // Cleanup
    rooms.forEach((room, roomId) => {
      if (room.peers.has(socket.id)) {
        const peer = room.peers.get(socket.id);
        peer.transports.forEach(t => t.close());
        room.peers.delete(socket.id);

        if (roomHostByRoom.get(roomId) === socket.userId) {
          let nextHostId = null;
          for (const socketId of room.peers.keys()) {
            const peerSocket = conferenceNsp.sockets.get(socketId);
            if (peerSocket?.userId) {
              nextHostId = String(peerSocket.userId);
              break;
            }
          }
          if (nextHostId) {
            roomHostByRoom.set(roomId, nextHostId);
            conferenceNsp.to(roomId).emit('host-changed', { hostId: nextHostId });
          } else {
            roomHostByRoom.delete(roomId);
          }
        }
        
        if (room.peers.size === 0) {
          // Defer teardown: keep router + HLS pipeline alive for a grace
          // window so the broadcaster (or anyone) can reconnect after a
          // short network drop without losing the stream.
          scheduleRoomTeardown(roomId);
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

        // Auto-start live HLS pipeline if this room has a registered broadcast session.
        console.log(
          `[produce] kind=${kind} socket=${socket.id} producerId=${producer.id} ` +
            `(checking live-hls auto-start)`
        );
        try { maybeStartLiveHlsForSocketRoom(socket); } catch (_) {}

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

  socket.on('sfu:resume-consumer', async ({ consumerId: _consumerId }, callback) => {
      if (callback) callback({ resumed: true });
  });

  // --- LEGACY Handlers (Mobile App Compatibility) ---

  socket.on('getRouterRtpCapabilities', (data, callback) => {
    const cb = typeof data === 'function' ? data : callback;
    let room;
    for (const r of rooms.values()) {
      if (r.peers.has(socket.id)) {
        room = r;
        break;
      }
    }
    if (!room) return cb({ error: 'Not in a room' });
    cb({ rtpCapabilities: room.router.rtpCapabilities });
  });

  socket.on('createWebRtcTransport', async ({ consumer: _consumer }, callback) => {
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

        console.log(`[MediaServer] Created WebRtcTransport: ${transport.id} for socket: ${socket.id}`);

        callback({
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
        });
    } catch (err) {
        callback({ error: err.message });
    }
  });

  socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
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
        const transport = peer.transports.find(t => t.id === transport_id); // Note: transport_id
        
        if (!transport) throw new Error('Transport not found');
        
        await transport.connect({ dtlsParameters });
        callback({ success: true });
      } catch (err) {
          callback({ error: err.message });
      }
  });

  socket.on('produce', async ({ producerTransportId, kind, rtpParameters, appData }, callback) => {
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
        const transport = peer.transports.find(t => t.id === producerTransportId); // Note: producerTransportId

        if (!transport) throw new Error('Transport not found');

        const producer = await transport.produce({ kind, rtpParameters, appData });
        peer.producers.push(producer);

        producer.on('transportclose', () => producer.close());

        // Auto-start live HLS pipeline if this room has a registered broadcast session.
        console.log(
          `[produce/legacy] kind=${kind} socket=${socket.id} producerId=${producer.id} ` +
            `(checking live-hls auto-start)`
        );
        try { maybeStartLiveHlsForSocketRoom(socket); } catch (_) {}

        // Notify others
        socket.to(Array.from(room.peers.keys())).emit('newProducers', [{
            producer_id: producer.id,
            producer_socket_id: socket.id,
            kind: producer.kind,
            appData: producer.appData
        }]);
        // Also emit sfu:new-producer for new clients
        socket.to(Array.from(room.peers.keys())).emit('sfu:new-producer', {
            producerId: producer.id,
            producerSocketId: socket.id,
            kind: producer.kind,
            appData: producer.appData
        });

        callback({ producer_id: producer.id });
      } catch (err) {
          callback({ error: err.message });
      }
  });

  socket.on('consume', async ({ producerId, consumerTransportId, rtpCapabilities }, callback) => {
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
        const transport = peer.transports.find(t => t.id === consumerTransportId); // Note: consumerTransportId

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
            socket.emit('consumerClosed', { consumer_id: consumer.id });
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

  socket.on('resumeConsumer', async ({ consumerId: _consumerId, consumer_id: _consumer_id }, callback) => {
      if (typeof callback === 'function') callback({ resumed: true });
  });

  // --- Mesh Fallback Signaling ---
  socket.on('offer', (data) => {
      socket.to(data.to).emit('offer', { ...data, from: socket.id });
  });
  
  socket.on('answer', (data) => {
      socket.to(data.to).emit('answer', { ...data, from: socket.id });
  });
  
  socket.on('ice-candidate', (data) => {
      socket.to(data.to).emit('ice-candidate', { ...data, from: socket.id });
  });

  // --- Self media toggle (participant announces own mute/unmute) ---
  socket.on('toggle-audio', ({ enabled } = {}) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('user-audio-toggle', {
      userId: socket.userId,
      enabled: Boolean(enabled),
    });
  });

  socket.on('toggle-video', ({ enabled } = {}) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('user-video-toggle', {
      userId: socket.userId,
      enabled: Boolean(enabled),
    });
  });

  // --- Host controls ---
  socket.on('mute-participant', ({ targetUserId, userId }, callback) => {
    console.log('[TF-SFU] mute-participant recv', { by: socket.userId, socketId: socket.id, targetUserId, userId });
    try {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return callback?.({ error: 'Room not found' });
      if (!canManageRoom(roomId)) return callback?.({ error: 'Sadece host bu islemi yapabilir.' });
      const target = resolveTargetSocketInRoom(roomId, targetUserId || userId);
      if (!target?.targetSocketId) return callback?.({ error: 'Kullanici odada degil.' });

      conferenceNsp.to(target.targetSocketId).emit('force-mute', {
        by: socket.userId,
        byName: socket.userName,
      });
      conferenceNsp.to(roomId).emit('participant-muted', {
        userId: target.targetUserId,
        by: socket.userId,
      });
      conferenceNsp.to(roomId).emit('user-audio-toggle', {
        userId: target.targetUserId,
        enabled: false,
      });
      console.log('[TF-SFU] mute-participant ok', { roomId, target: target.targetUserId });
      callback?.({ success: true });
    } catch (err) {
      console.error('[TF-SFU] mute-participant failed', err);
      callback?.({ error: err?.message || 'Mute failed' });
    }
  });

  socket.on('unmute-participant', ({ targetUserId, userId }, callback) => {
    console.log('[TF-SFU] unmute-participant recv', { by: socket.userId, socketId: socket.id, targetUserId, userId });
    try {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return callback?.({ error: 'Room not found' });
      if (!canManageRoom(roomId)) return callback?.({ error: 'Sadece host bu islemi yapabilir.' });
      const target = resolveTargetSocketInRoom(roomId, targetUserId || userId);
      if (!target?.targetSocketId) return callback?.({ error: 'Kullanici odada degil.' });

      conferenceNsp.to(target.targetSocketId).emit('force-unmute', {
        by: socket.userId,
        byName: socket.userName,
      });
      conferenceNsp.to(roomId).emit('participant-unmuted', {
        userId: target.targetUserId,
        by: socket.userId,
      });
      conferenceNsp.to(roomId).emit('user-audio-toggle', {
        userId: target.targetUserId,
        enabled: true,
      });
      console.log('[TF-SFU] unmute-participant ok', { roomId, target: target.targetUserId });
      callback?.({ success: true });
    } catch (err) {
      console.error('[TF-SFU] unmute-participant failed', err);
      callback?.({ error: err?.message || 'Unmute failed' });
    }
  });

  socket.on('set-participant-video', ({ targetUserId, userId, enabled }, callback) => {
    console.log('[TF-SFU] set-participant-video recv', { by: socket.userId, socketId: socket.id, targetUserId, userId, enabled });
    try {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return callback?.({ error: 'Room not found' });
      if (!canManageRoom(roomId)) return callback?.({ error: 'Sadece host bu islemi yapabilir.' });
      const target = resolveTargetSocketInRoom(roomId, targetUserId || userId);
      if (!target?.targetSocketId) return callback?.({ error: 'Kullanici odada degil.' });

      conferenceNsp.to(target.targetSocketId).emit('force-video-toggle', {
        enabled: Boolean(enabled),
        by: socket.userId,
        byName: socket.userName,
      });
      conferenceNsp.to(roomId).emit('participant-video-forced', {
        userId: target.targetUserId,
        enabled: Boolean(enabled),
        by: socket.userId,
      });
      conferenceNsp.to(roomId).emit('user-video-toggle', {
        userId: target.targetUserId,
        enabled: Boolean(enabled),
      });
      console.log('[TF-SFU] set-participant-video ok', { roomId, target: target.targetUserId, enabled: Boolean(enabled) });
      callback?.({ success: true });
    } catch (err) {
      console.error('[TF-SFU] set-participant-video failed', err);
      callback?.({ error: err?.message || 'Set video failed' });
    }
  });

  socket.on('kick-participant', ({ targetUserId, userId }, callback) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return callback?.({ error: 'Room not found' });
    if (!canManageRoom(roomId)) return callback?.({ error: 'Sadece host bu islemi yapabilir.' });
    const target = resolveTargetSocketInRoom(roomId, targetUserId || userId);
    if (!target?.targetSocketId) return callback?.({ error: 'Kullanici odada degil.' });

    conferenceNsp.to(target.targetSocketId).emit('kicked', {
      by: socket.userId,
      byName: socket.userName,
    });
    setTimeout(() => {
      const targetSocket = conferenceNsp.sockets.get(target.targetSocketId);
      if (targetSocket) {
        targetSocket.disconnect();
      }
    }, 100);
    callback?.({ success: true });
  });

  socket.on('ban-participant', ({ targetUserId, userId }, callback) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return callback?.({ error: 'Room not found' });
    if (!canManageRoom(roomId)) return callback?.({ error: 'Sadece host bu islemi yapabilir.' });
    const target = resolveTargetSocketInRoom(roomId, targetUserId || userId);
    if (!target?.targetSocketId) return callback?.({ error: 'Kullanici odada degil.' });

    conferenceNsp.to(target.targetSocketId).emit('banned', {
      by: socket.userId,
      byName: socket.userName,
    });
    setTimeout(() => {
      const targetSocket = conferenceNsp.sockets.get(target.targetSocketId);
      if (targetSocket) {
        targetSocket.disconnect();
      }
    }, 100);
    callback?.({ success: true });
  });
  
  // --- Chat / Reactions / Typing (vizyo clients use same namespace) ---
  socket.on('chat-message', ({ id, content, type, file, replyTo, mentions, timestamp }) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return;
    const messageId = String(id || `${Date.now()}-${socket.userId}-${String(content || file?.name || '').slice(0, 24)}`);
    conferenceNsp.to(roomId).emit('chat-message', {
      id: messageId,
      userId: socket.userId,
      odaId: socket.userId,
      userName: socket.userName,
      userAvatar: socket.userAvatar,
      content: String(content || ''),
      type: type || 'text',
      file,
      replyTo,
      mentions,
      timestamp: timestamp || Date.now(),
    });
  });

  const handleMessageReaction = (eventName, payload = {}) => {
    const roomId = socketRoomMap.get(socket.id);
    const messageId = String(payload?.messageId || payload?.message_id || payload?.msgId || '');
    const emoji = String(payload?.emoji || '');
    console.log(
      `[ConferenceSocket] message reaction received (${eventName}) from ${socket.userName}: room=${roomId || 'none'}, messageId=${messageId || 'missing'}, emoji=${emoji || 'missing'}`
    );
    if (!roomId || !messageId || !emoji) {
      console.warn(
        `[ConferenceSocket] message reaction ignored (${eventName}) for ${socket.userName}: invalid payload ${JSON.stringify(payload)}`
      );
      return;
    }
    const reactionPayload = {
      messageId,
      message_id: messageId,
      msgId: messageId,
      emoji,
      userId: socket.userId,
      odaId: socket.userId,
      userName: socket.userName,
    };
    conferenceNsp.to(roomId).emit('message-reaction', reactionPayload);
    conferenceNsp.to(roomId).emit('messageReaction', reactionPayload);
    console.log(
      `[ConferenceSocket] message reaction broadcast in room ${roomId}: user=${socket.userName}, messageId=${messageId}, emoji=${emoji}`
    );
  };

  socket.on('message-reaction', (payload) => {
    handleMessageReaction('message-reaction', payload);
  });

  socket.on('messageReaction', (payload) => {
    handleMessageReaction('messageReaction', payload);
  });

  socket.on('reaction', ({ emoji }) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId || !emoji) return;
    conferenceNsp.to(roomId).emit('user-reaction', {
      emoji: String(emoji),
      userId: socket.userId,
      userName: socket.userName,
    });
  });

  socket.on('typing-start', () => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return;
    if (!typingUsersByRoom.has(roomId)) {
      typingUsersByRoom.set(roomId, new Set());
    }
    const typingSet = typingUsersByRoom.get(roomId);
    typingSet.add(socket.userName || socket.userId);
    conferenceNsp.to(roomId).emit('typing-users', { users: Array.from(typingSet) });
  });

  socket.on('typing-stop', () => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId || !typingUsersByRoom.has(roomId)) return;
    const typingSet = typingUsersByRoom.get(roomId);
    typingSet.delete(socket.userName || socket.userId);
    conferenceNsp.to(roomId).emit('typing-users', { users: Array.from(typingSet) });
  });

  socket.on('file-share', ({ fileName, fileUrl, fileType, fileSize }) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId) return;
    const messageId = `${Date.now()}-${socket.userId}-${String(fileName || 'file').slice(0, 24)}`;
    conferenceNsp.to(roomId).emit('file-shared', {
      id: messageId,
      userId: socket.userId,
      odaId: socket.userId,
      userName: socket.userName,
      userAvatar: socket.userAvatar,
      fileName,
      fileUrl,
      fileType,
      fileSize,
      timestamp: Date.now(),
    });
  });
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

async function uploadFileToSpaces(filePath, key, contentType, cacheControl) {
  const client = getSpacesClient();
  if (!client) {
    throw new Error('Spaces configuration is missing');
  }
  const body = await fs.promises.readFile(filePath);
  const putParams = {
    Bucket: SPACES_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    ACL: 'public-read',
  };
  if (cacheControl) {
    putParams.CacheControl = cacheControl;
  }
  await client.putObject(putParams);
  return getSpacesUrl(key);
}

async function listFilesRecursively(rootDir, currentDir = rootDir) {
  const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await listFilesRecursively(rootDir, fullPath);
      files.push(...nestedFiles);
    } else if (entry.isFile()) {
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      files.push({ fullPath, relativePath });
    }
  }
  return files;
}

function getHlsContentMetadata(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  let contentType = 'application/octet-stream';
  let cacheControl = 'public, max-age=31536000, immutable';

  if (ext === '.m3u8') {
    contentType = 'application/vnd.apple.mpegurl';
    cacheControl = 'public, max-age=60';
  } else if (ext === '.ts') {
    contentType = 'video/MP2T';
  } else if (ext === '.m4s') {
    contentType = 'video/iso.segment';
  } else if (ext === '.mp4') {
    contentType = 'video/mp4';
  } else if (ext === '.jpg' || ext === '.jpeg') {
    contentType = 'image/jpeg';
  }

  return { contentType, cacheControl };
}

async function uploadHlsDirectoryToSpaces(dir, keyPrefix, artifact = {}) {
  const files = await listFilesRecursively(dir);
  const fileUrlMap = new Map();

  await Promise.all(
    files.map(async ({ fullPath, relativePath }) => {
      const { contentType, cacheControl } = getHlsContentMetadata(relativePath);
      const key = `${keyPrefix}/${relativePath}`;
      const fileUrl = await uploadFileToSpaces(fullPath, key, contentType, cacheControl);
      fileUrlMap.set(relativePath, fileUrl);
    })
  );

  const playlistRelativePath = artifact.playlistRelativePath || 'index.m3u8';
  const masterPlaylistRelativePath = artifact.masterPlaylistRelativePath || null;
  const fallbackPlaylistRelativePath = artifact.fallbackPlaylistRelativePath || 'index.m3u8';
  const thumbnailRelativePath = artifact.thumbnailRelativePath || 'thumb.jpg';

  return {
    playlistUrl: fileUrlMap.get(playlistRelativePath) || null,
    masterPlaylistUrl: masterPlaylistRelativePath
      ? (fileUrlMap.get(masterPlaylistRelativePath) || null)
      : null,
    fallbackPlaylistUrl: fileUrlMap.get(fallbackPlaylistRelativePath) || null,
    thumbnailUrl: fileUrlMap.get(thumbnailRelativePath) || null,
  };
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

function runFfmpegHls(inputPath, outputDir, options = {}) {
  return new Promise((resolve, reject) => {
    const segmentDurationSeconds = Math.max(
      2,
      parseIntegerEnv(options.segmentDurationSeconds, HLS_SEGMENT_DURATION_SECONDS),
    );
    const segmentType = options.segmentType === 'fmp4' ? 'fmp4' : 'mpegts';
    const enableAbr = Boolean(options.enableAbr);
    const segmentExt = segmentType === 'fmp4' ? 'm4s' : 'ts';
    let stderrBuffer = '';
    let args;
    let artifact;

    if (enableAbr) {
      args = [
        '-y',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-profile:v',
        'main',
        '-level',
        '4.0',
        '-pix_fmt',
        'yuv420p',
        '-sc_threshold',
        '0',
        '-g',
        '48',
        '-keyint_min',
        '48',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-filter:v:0',
        'scale=-2:480',
        '-filter:v:1',
        'scale=-2:720',
        '-filter:v:2',
        'scale=-2:1080',
        '-b:v:0',
        '1000k',
        '-maxrate:v:0',
        '1070k',
        '-bufsize:v:0',
        '1500k',
        '-b:v:1',
        '2800k',
        '-maxrate:v:1',
        '2996k',
        '-bufsize:v:1',
        '4200k',
        '-b:v:2',
        '5000k',
        '-maxrate:v:2',
        '5350k',
        '-bufsize:v:2',
        '7500k',
        '-var_stream_map',
        'v:0,a:0,name:480p v:1,a:1,name:720p v:2,a:2,name:1080p',
        '-master_pl_name',
        'master.m3u8',
        '-hls_time',
        String(segmentDurationSeconds),
        '-hls_list_size',
        '0',
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'independent_segments',
      ];

      if (segmentType === 'fmp4') {
        args.push(
          '-hls_segment_type',
          'fmp4',
          '-hls_fmp4_init_filename',
          'v%v/init.mp4',
        );
      }

      args.push(
        '-hls_segment_filename',
        path.join(outputDir, 'v%v', `segment_%06d.${segmentExt}`),
        '-f',
        'hls',
        path.join(outputDir, 'v%v', 'index.m3u8'),
      );

      artifact = {
        playlistRelativePath: 'master.m3u8',
        masterPlaylistRelativePath: 'master.m3u8',
        fallbackPlaylistRelativePath: 'v0/index.m3u8',
        renditions: ['480p', '720p', '1080p'],
      };
    } else {
      args = [
        '-y',
        '-i',
        inputPath,
        '-c:v',
        'libx264',
        '-profile:v',
        'main',
        '-level',
        '4.0',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-start_number',
        '0',
        '-hls_time',
        String(segmentDurationSeconds),
        '-hls_list_size',
        '0',
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'independent_segments',
      ];

      if (segmentType === 'fmp4') {
        args.push(
          '-hls_segment_type',
          'fmp4',
          '-hls_fmp4_init_filename',
          'init.mp4',
        );
      }

      args.push(
        '-hls_segment_filename',
        path.join(outputDir, `segment_%06d.${segmentExt}`),
        '-f',
        'hls',
        path.join(outputDir, 'index.m3u8'),
      );

      artifact = {
        playlistRelativePath: 'index.m3u8',
        masterPlaylistRelativePath: null,
        fallbackPlaylistRelativePath: 'index.m3u8',
        renditions: ['single'],
      };
    }

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
        resolve({
          durationSeconds,
          ...artifact,
          segmentType,
          abrEnabled: enableAbr,
        });
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

function runFfmpegThumbnail(inputPath, outputPath, seekSeconds = 1) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss',
      String(Math.max(0, seekSeconds)),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outputPath,
    ];

    const ffmpeg = spawn('ffmpeg', args);
    let stderrBuffer = '';

    ffmpeg.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
    });

    ffmpeg.on('error', (err) => reject(err));
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(`thumbnail ffmpeg exited with code ${code}: ${stderrBuffer}`));
      }
    });
  });
}

// ============================================================================
// LIVE HLS BROADCAST PIPELINE (PlainTransport -> FFmpeg -> HLS)
// ============================================================================

const LIVE_HLS_DIR = process.env.LIVE_HLS_DIR
  ? path.resolve(process.env.LIVE_HLS_DIR)
  : path.join(__dirname, 'public', 'live');
try { fs.mkdirSync(LIVE_HLS_DIR, { recursive: true }); } catch (_) {}

const LIVE_RTP_PORT_BASE = parseIntegerEnv(process.env.LIVE_RTP_PORT_BASE, 30000);
const LIVE_RTP_PORT_MAX = parseIntegerEnv(process.env.LIVE_RTP_PORT_MAX, 30400);
const liveRtpPortInUse = new Set();
const liveHlsPipelines = new Map(); // roomId -> { ffmpeg, transports, consumers, ports, hlsDir, starting, stopping }
const liveHlsCleanupTimers = new Map(); // roomId -> Timeout (pending hlsDir rm)

function cancelLiveHlsCleanup(roomId, reason) {
  const t = liveHlsCleanupTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    liveHlsCleanupTimers.delete(roomId);
    console.log(`[live-hls ${roomId}] cleanup timer cancelled (${reason || 'restart'})`);
  }
}

function allocLiveRtpPort() {
  // Allocate pair (RTP + RTCP non-mux not used; we use rtcp-mux so single port).
  for (let p = LIVE_RTP_PORT_BASE; p <= LIVE_RTP_PORT_MAX; p++) {
    if (!liveRtpPortInUse.has(p)) {
      liveRtpPortInUse.add(p);
      return p;
    }
  }
  throw new Error('no_live_rtp_port_available');
}
function freeLiveRtpPort(p) {
  if (typeof p === 'number') liveRtpPortInUse.delete(p);
}

function sanitizeRoomIdForPath(roomId) {
  return String(roomId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'room';
}

function findRoomIdByRoom(targetRoom) {
  for (const [rid, r] of rooms.entries()) {
    if (r === targetRoom) return rid;
  }
  return null;
}

function pickProducersForBroadcast(room) {
  let videoProducer = null;
  let audioProducer = null;
  for (const peer of room.peers.values()) {
    for (const producer of peer.producers) {
      if (producer.closed) continue;
      if (!videoProducer && producer.kind === 'video') videoProducer = producer;
      if (!audioProducer && producer.kind === 'audio') audioProducer = producer;
    }
    if (videoProducer && audioProducer) break;
  }
  return { videoProducer, audioProducer };
}

function buildSdpForConsumers({ videoConsumer, videoPort, audioConsumer, audioPort }) {
  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=mediasoup-live',
    'c=IN IP4 127.0.0.1',
    't=0 0',
  ];

  function appendMedia(kind, consumer, port) {
    const codec = consumer.rtpParameters.codecs[0];
    const pt = codec.payloadType;
    const mime = codec.mimeType.split('/')[1]; // VP8, H264, opus, ...
    const clockRate = codec.clockRate;
    const channels = codec.channels && codec.channels > 1 ? `/${codec.channels}` : '';
    lines.push(`m=${kind} ${port} RTP/AVP ${pt}`);
    lines.push('a=rtcp-mux');
    lines.push(`a=rtpmap:${pt} ${mime}/${clockRate}${channels}`);
    const params = codec.parameters || {};
    const fmtpParts = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`);
    if (fmtpParts.length > 0) {
      lines.push(`a=fmtp:${pt} ${fmtpParts.join(';')}`);
    }
    lines.push('a=sendonly');
  }

  appendMedia('video', videoConsumer, videoPort);
  if (audioConsumer) {
    appendMedia('audio', audioConsumer, audioPort);
  }
  return lines.join('\n') + '\n';
}

async function startLiveHlsForRoom(roomId) {
  if (liveHlsPipelines.has(roomId)) return liveHlsPipelines.get(roomId);

  const room = rooms.get(roomId);
  if (!room) throw new Error(`live_hls_room_not_found:${roomId}`);

  const { videoProducer, audioProducer } = pickProducersForBroadcast(room);
  if (!videoProducer) {
    // Not enough producers yet; will be retried on next produce.
    console.log(
      `[live-hls ${roomId}] startLiveHlsForRoom: no video producer yet ` +
        `(peers=${room.peers.size}). Will retry on next produce.`
    );
    return null;
  }
  console.log(
    `[live-hls ${roomId}] startLiveHlsForRoom: producers ready ` +
      `(video=${!!videoProducer}, audio=${!!audioProducer}). Starting pipeline...`
  );

  // Reserve slot early to avoid races.
  const placeholder = { starting: true };
  liveHlsPipelines.set(roomId, placeholder);

  let videoTransport = null;
  let audioTransport = null;
  let videoConsumer = null;
  let audioConsumer = null;
  let videoPort = null;
  let audioPort = null;
  let ffmpeg = null;
  const hlsDir = path.join(LIVE_HLS_DIR, sanitizeRoomIdForPath(roomId));

  // If we are restarting within the grace window, the cleanup timer from a
  // previous stopLiveHlsForRoom may still be pending. Cancel it before we
  // begin writing new segments.
  cancelLiveHlsCleanup(roomId, 'pipeline-start');

  try {
    await fs.promises.mkdir(hlsDir, { recursive: true });
    // Determine where to resume segment numbering: if old segments exist in
    // the directory (broadcaster reconnecting after a blip), continue the
    // index so viewers' playlists stay continuous. Otherwise start fresh.
    let startNumber = 0;
    let resumeFromExisting = false;
    try {
      const existing = await fs.promises.readdir(hlsDir);
      let maxSeg = -1;
      for (const f of existing) {
        const m = f.match(/^seg_(\d+)\.ts$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n > maxSeg) maxSeg = n;
        }
      }
      if (maxSeg >= 0) {
        startNumber = maxSeg + 1;
        resumeFromExisting = true;
        console.log(`[live-hls ${roomId}] resuming segment numbering at ${startNumber}`);
      } else {
        // No previous segments — clean any stale junk (e.g. old sdp).
        await Promise.all(existing.map((f) =>
          fs.promises.unlink(path.join(hlsDir, f)).catch(() => {})
        ));
      }
    } catch (_) {}

    const router = room.router;
    const plainOpts = {
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: true,
      comedia: false,
      enableSrtp: false,
    };

    videoTransport = await router.createPlainTransport(plainOpts);
    videoPort = allocLiveRtpPort();
    await videoTransport.connect({ ip: '127.0.0.1', port: videoPort });
    videoConsumer = await videoTransport.consume({
      producerId: videoProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });

    if (audioProducer) {
      audioTransport = await router.createPlainTransport(plainOpts);
      audioPort = allocLiveRtpPort();
      await audioTransport.connect({ ip: '127.0.0.1', port: audioPort });
      audioConsumer = await audioTransport.consume({
        producerId: audioProducer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true,
      });
    }

    const sdp = buildSdpForConsumers({ videoConsumer, videoPort, audioConsumer, audioPort });
    const sdpPath = path.join(hlsDir, 'input.sdp');
    await fs.promises.writeFile(sdpPath, sdp, 'utf8');

    const ffmpegArgs = [
      '-loglevel', 'warning',
      '-protocol_whitelist', 'file,udp,rtp',
      '-fflags', '+genpts+nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-i', sdpPath,
      '-map', '0:v:0',
      ...(audioConsumer ? ['-map', '0:a:0'] : []),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-pix_fmt', 'yuv420p',
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0',
      '-b:v', '1500k',
      '-maxrate', '1800k',
      '-bufsize', '3000k',
      ...(audioConsumer
        ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']
        : []),
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '6',
      '-hls_flags', resumeFromExisting
        ? 'delete_segments+independent_segments+omit_endlist+program_date_time+append_list'
        : 'delete_segments+independent_segments+omit_endlist+program_date_time',
      '-hls_segment_type', 'mpegts',
      '-start_number', String(startNumber),
      '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.ts'),
      path.join(hlsDir, 'index.m3u8'),
    ];

    console.log(`[live-hls ${roomId}] spawning ffmpeg (videoPort=${videoPort}, audioPort=${audioPort ?? 'none'})`);
    ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpeg.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.trim().length > 0) console.log(`[live-hls ${roomId}] ${text.trim()}`);
    });
    ffmpeg.on('error', (err) => {
      console.error(`[live-hls ${roomId}] ffmpeg error:`, err.message);
    });
    ffmpeg.on('close', (code) => {
      console.log(`[live-hls ${roomId}] ffmpeg exited code=${code}`);
      stopLiveHlsForRoom(roomId).catch(() => {});
    });

    const pipeline = {
      roomId,
      hlsDir,
      ffmpeg,
      videoTransport,
      audioTransport,
      videoConsumer,
      audioConsumer,
      videoPort,
      audioPort,
      videoProducerId: videoProducer.id,
      audioProducerId: audioProducer ? audioProducer.id : null,
      startedAt: Date.now(),
      stopping: false,
    };
    liveHlsPipelines.set(roomId, pipeline);

    // Auto-stop pipeline when source producer closes.
    const onVideoClosed = () => {
      console.log(`[live-hls ${roomId}] video producer closed`);
      stopLiveHlsForRoom(roomId).catch(() => {});
    };
    videoConsumer.on('producerclose', onVideoClosed);
    if (audioConsumer) {
      audioConsumer.on('producerclose', () => {
        console.log(`[live-hls ${roomId}] audio producer closed (continuing video-only)`);
      });
    }

    // Resume consumers so RTP starts flowing.
    await videoConsumer.resume();
    if (audioConsumer) await audioConsumer.resume();

    // Mark broadcast session as live.
    const session = liveBroadcastSessions.get(roomId);
    if (session) {
      session.status = 'live';
      session.streamStartedAt = new Date().toISOString();
    }

    console.log(`[live-hls ${roomId}] pipeline started -> ${hlsDir}`);
    return pipeline;
  } catch (err) {
    console.error(`[live-hls ${roomId}] start failed:`, err);
    // Cleanup on failure.
    try { if (ffmpeg) ffmpeg.kill('SIGKILL'); } catch (_) {}
    try { if (videoConsumer) videoConsumer.close(); } catch (_) {}
    try { if (audioConsumer) audioConsumer.close(); } catch (_) {}
    try { if (videoTransport) videoTransport.close(); } catch (_) {}
    try { if (audioTransport) audioTransport.close(); } catch (_) {}
    freeLiveRtpPort(videoPort);
    freeLiveRtpPort(audioPort);
    if (liveHlsPipelines.get(roomId) === placeholder) {
      liveHlsPipelines.delete(roomId);
    } else {
      liveHlsPipelines.delete(roomId);
    }
    throw err;
  }
}

async function stopLiveHlsForRoom(roomId) {
  const p = liveHlsPipelines.get(roomId);
  if (!p || p.starting === true) return;
  if (p.stopping) return;
  p.stopping = true;

  try { if (p.ffmpeg && !p.ffmpeg.killed) p.ffmpeg.kill('SIGINT'); } catch (_) {}
  setTimeout(() => {
    try { if (p.ffmpeg && !p.ffmpeg.killed) p.ffmpeg.kill('SIGKILL'); } catch (_) {}
  }, 3000);

  try { if (p.videoConsumer && !p.videoConsumer.closed) p.videoConsumer.close(); } catch (_) {}
  try { if (p.audioConsumer && !p.audioConsumer.closed) p.audioConsumer.close(); } catch (_) {}
  try { if (p.videoTransport && !p.videoTransport.closed) p.videoTransport.close(); } catch (_) {}
  try { if (p.audioTransport && !p.audioTransport.closed) p.audioTransport.close(); } catch (_) {}
  freeLiveRtpPort(p.videoPort);
  freeLiveRtpPort(p.audioPort);

  liveHlsPipelines.delete(roomId);

  const session = liveBroadcastSessions.get(roomId);
  if (session) {
    session.status = 'ended';
    session.streamEndedAt = new Date().toISOString();
  }

  // Schedule HLS directory cleanup after a grace period so late viewers see EXT-X-ENDLIST behaviour.
  if (p.hlsDir) {
    const cleanupTimer = setTimeout(() => {
      liveHlsCleanupTimers.delete(roomId);
      fs.rm(p.hlsDir, { recursive: true, force: true }, () => {});
    }, 60 * 1000);
    liveHlsCleanupTimers.set(roomId, cleanupTimer);
  }
  console.log(`[live-hls ${roomId}] pipeline stopped`);
}

function maybeStartLiveHlsForSocketRoom(socket) {
  // Find roomId where socket is a peer.
  for (const [rid, r] of rooms.entries()) {
    if (r.peers.has(socket.id)) {
      const hasSession = liveBroadcastSessions.has(rid);
      const hasPipeline = liveHlsPipelines.has(rid);
      if (hasSession && !hasPipeline) {
        console.log(`[live-hls ${rid}] auto-start triggered (socket=${socket.id})`);
        startLiveHlsForRoom(rid).catch((e) =>
          console.error(`[live-hls ${rid}] auto-start failed:`, e.message)
        );
      } else if (!hasSession) {
        console.log(
          `[live-hls ${rid}] auto-start skipped: no session registered yet (socket=${socket.id}). ` +
            `Sessions in map: ${liveBroadcastSessions.size}`
        );
      }
      return rid;
    }
  }
  return null;
}

// Serve HLS segments
app.use(
  '/live',
  express.static(LIVE_HLS_DIR, {
    fallthrough: false,
    setHeaders: (res, filePath) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Cache-Control', 'public, max-age=10');
        res.setHeader('Content-Type', 'video/mp2t');
      }
    },
  })
);

app.post('/live-broadcast/session', async (req, res) => {
  const { roomId, title, channelId, startTime, scheduledEndTime } = req.body || {};
  const normalizedRoomId = String(roomId || '').trim() || `broadcast-${Date.now()}`;
  const sessionId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const hlsUrl = `${LIVE_HLS_BASE_URL.replace(/\/$/, '')}/${encodeURIComponent(normalizedRoomId)}/index.m3u8`;

  const existed = liveBroadcastSessions.has(normalizedRoomId);
  const roomReady = rooms.has(normalizedRoomId);
  console.log(
    `[live-broadcast/session] register roomId=${normalizedRoomId} ` +
      `existed=${existed} roomReady=${roomReady} channelId=${channelId || '-'}`
  );

  const session = {
    sessionId,
    roomId: normalizedRoomId,
    title: String(title || 'Canli Yayin'),
    channelId: channelId || null,
    startTime: startTime || new Date().toISOString(),
    scheduledEndTime: scheduledEndTime || null,
    hlsUrl,
    playbackUrl: hlsUrl,
    llhls: true,
    status: 'provisioned',
    createdAt: new Date().toISOString(),
  };

  liveBroadcastSessions.set(normalizedRoomId, session);

  // If broadcaster already joined the mediasoup room before calling session, start now.
  if (rooms.has(normalizedRoomId)) {
    startLiveHlsForRoom(normalizedRoomId).catch((e) =>
      console.error(`[live-hls ${normalizedRoomId}] start on session failed:`, e.message)
    );
  }

  // Defansif: client/backend POST'u yayıncının mediasoup produce'undan ÖNCE
  // gelirse, `startLiveHlsForRoom` no-op döner ve sadece bir sonraki `produce`
  // olayı pipeline'i tetikleyebilir. O olay da kaçırılırsa izleyici sonsuza
  // kadar 404 alır. 30sn'lik bir watcher koy: her saniye odanın hazır olup
  // olmadığını kontrol et, hazırsa pipeline'i başlat.
  if (!liveHlsPipelines.has(normalizedRoomId)) {
    let attempts = 0;
    const maxAttempts = 30;
    const watcher = setInterval(() => {
      attempts += 1;
      // Pipeline başladıysa veya session kaldırıldıysa dur.
      if (
        liveHlsPipelines.has(normalizedRoomId) ||
        !liveBroadcastSessions.has(normalizedRoomId)
      ) {
        clearInterval(watcher);
        return;
      }
      if (attempts >= maxAttempts) {
        console.warn(
          `[live-hls ${normalizedRoomId}] watcher giving up after ${attempts}s; ` +
            `broadcaster never produced media (peers=` +
            `${rooms.get(normalizedRoomId)?.peers.size ?? 0}).`
        );
        clearInterval(watcher);
        return;
      }
      if (rooms.has(normalizedRoomId)) {
        startLiveHlsForRoom(normalizedRoomId).catch((e) =>
          console.error(
            `[live-hls ${normalizedRoomId}] watcher start failed:`,
            e.message
          )
        );
      }
    }, 1000);
  }

  return res.status(201).json(session);
});

app.post('/live-broadcast/stop/:roomId', async (req, res) => {
  const roomId = String(req.params.roomId || '').trim();
  if (!roomId) return res.status(400).json({ error: 'roomId_required' });
  await stopLiveHlsForRoom(roomId);
  const session = liveBroadcastSessions.get(roomId);
  if (session) {
    session.status = 'ended';
    session.streamEndedAt = new Date().toISOString();
  }
  return res.json({ ok: true, roomId });
});

app.get('/live-broadcast/session/:roomId', (req, res) => {
  const roomId = String(req.params.roomId || '').trim();
  if (!roomId || !liveBroadcastSessions.has(roomId)) {
    return res.status(404).json({ error: 'live_broadcast_session_not_found' });
  }
  return res.json(liveBroadcastSessions.get(roomId));
});

// Debug: tüm canlı yayın durumunun anlık görünümü. Yayıncı yayını başlattı
// ama izleyici "hazırlanıyor"da kalıyorsa burayı kontrol et:
//   - sessions: liveBroadcastSessions map (backend veya client tarafından
//     register edilmiş yayınlar). Boşsa media-server hiç bilgilendirilmemiş.
//   - rooms: mediasoup oda map'i (yayıncı bağlandıysa burada görünür).
//   - pipelines: aktif FFmpeg/HLS pipeline'ları (m3u8 üretiliyor demektir).
// Bir oda `sessions` ve `rooms` içinde ama `pipelines` içinde yoksa,
// maybeStartLiveHlsForSocketRoom henüz tetiklenmemiş olabilir.
app.get('/live-broadcast/debug', (req, res) => {
  const sessions = Array.from(liveBroadcastSessions.entries()).map(([rid, s]) => ({
    roomId: rid,
    sessionId: s.sessionId,
    status: s.status,
    channelId: s.channelId,
    startTime: s.startTime,
    streamEndedAt: s.streamEndedAt || null,
    hasPipeline: liveHlsPipelines.has(rid),
    hasRoom: rooms.has(rid),
    peerCount: rooms.has(rid) ? rooms.get(rid).peers.size : 0,
  }));
  const orphanRooms = [];
  for (const [rid, r] of rooms.entries()) {
    if (!liveBroadcastSessions.has(rid)) {
      orphanRooms.push({ roomId: rid, peerCount: r.peers.size });
    }
  }
  return res.json({
    now: new Date().toISOString(),
    sessionCount: liveBroadcastSessions.size,
    roomCount: rooms.size,
    pipelineCount: liveHlsPipelines.size,
    sessions,
    pipelines: Array.from(liveHlsPipelines.keys()),
    orphanRooms, // mediasoup'a katılmış ama session register edilmemiş odalar
  });
});

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

    const hlsArtifact = await runFfmpegHls(sourcePath, hlsDir, {
      segmentDurationSeconds: HLS_SEGMENT_DURATION_SECONDS,
      segmentType: HLS_SEGMENT_TYPE,
      enableAbr: HLS_ENABLE_ABR,
    });

    if (HLS_GENERATE_THUMBNAIL) {
      try {
        await runFfmpegThumbnail(sourcePath, path.join(hlsDir, 'thumb.jpg'), 1);
        hlsArtifact.thumbnailRelativePath = 'thumb.jpg';
      } catch (thumbErr) {
        console.warn('[hls] thumbnail generation failed', thumbErr.message);
      }
    }

    const baseKey =
      channelId && messageId
        ? `hls/channel/${channelId}/${messageId}`
        : `hls/misc/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let uploadResult = null;

    try {
      uploadResult = await uploadHlsDirectoryToSpaces(hlsDir, baseKey, hlsArtifact);
    } finally {
      try {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('HLS temp cleanup error', cleanupError);
      }
    }

    if (!uploadResult?.playlistUrl) {
      return res.status(500).json({ error: 'hls_upload_failed' });
    }

    return res.json({
      playlistUrl: uploadResult.playlistUrl,
      masterPlaylistUrl: uploadResult.masterPlaylistUrl,
      fallbackPlaylistUrl: uploadResult.fallbackPlaylistUrl,
      thumbnailUrl: uploadResult.thumbnailUrl,
      durationSeconds: hlsArtifact.durationSeconds,
      abrEnabled: hlsArtifact.abrEnabled,
      segmentType: hlsArtifact.segmentType,
      renditions: hlsArtifact.renditions,
    });
  } catch (err) {
    console.error('HLS conversion error', err);
    return res.status(500).json({ error: 'hls_conversion_failed' });
  }
});

// --- Audio transcode (in-place size/bitrate optimization, no HLS) ---
// Backwards compatible: returns a plain m4a/aac URL that any HTML5 <audio>
// or react-native-audio-recorder-player can play directly.
function runFfmpegAudioTranscode(inputPath, outputPath, bitrateKbps = 64) {
  return new Promise((resolve, reject) => {
    let stderrBuffer = '';
    const args = [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      `${bitrateKbps}k`,
      '-ac',
      '1',
      '-ar',
      '44100',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      outputPath,
    ];

    const ffmpeg = spawn('ffmpeg', args);

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuffer += text;
      // Quieter than HLS path; only log on error close
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        const durationSeconds = parseFfmpegDuration(stderrBuffer);
        resolve({ durationSeconds });
      } else {
        console.error(`[ffmpeg-audio] exited with code ${code}: ${stderrBuffer}`);
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

app.post('/audio/transcode/from-url', async (req, res) => {
  const {
    url,
    channelId,
    messageId,
    minDurationSeconds,
    minSizeBytes,
    bitrateKbps,
  } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url_required' });
  }

  const minDuration =
    typeof minDurationSeconds === 'number' && minDurationSeconds >= 0
      ? minDurationSeconds
      : 30;
  const minSize =
    typeof minSizeBytes === 'number' && minSizeBytes >= 0
      ? minSizeBytes
      : 256 * 1024; // 256 KB
  const bitrate =
    typeof bitrateKbps === 'number' && bitrateKbps >= 16 && bitrateKbps <= 320
      ? bitrateKbps
      : 64;

  let workDir;
  try {
    workDir = await createTempDirectory('hissechat-audio');
    const sourcePath = path.join(workDir, 'source.bin');
    const outputPath = path.join(workDir, 'out.m4a');

    await downloadFile(url, sourcePath);

    const sourceStat = await fs.promises.stat(sourcePath);

    // Probe duration via a no-op ffmpeg pass on the source so we can decide
    // whether transcoding is worth it before actually re-encoding.
    let originalDuration = null;
    try {
      const probeStderr = await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', ['-i', sourcePath, '-f', 'null', '-']);
        let buf = '';
        ff.stderr.on('data', (d) => {
          buf += d.toString();
        });
        ff.on('error', reject);
        ff.on('close', () => resolve(buf));
      });
      originalDuration = parseFfmpegDuration(probeStderr);
    } catch (probeErr) {
      console.warn('[audio-transcode] probe failed, continuing:', probeErr.message);
    }

    // Skip conditions: too short or too small to be worth optimizing.
    if (
      (originalDuration !== null && originalDuration < minDuration) ||
      sourceStat.size < minSize
    ) {
      return res.json({
        skipped: true,
        reason: 'below_threshold',
        durationSeconds: originalDuration,
        originalSize: sourceStat.size,
      });
    }

    const { durationSeconds } = await runFfmpegAudioTranscode(
      sourcePath,
      outputPath,
      bitrate,
    );

    const outStat = await fs.promises.stat(outputPath);

    // If transcode didn't actually shrink the file, skip the replace.
    // Use a 5% margin to avoid flapping for already-optimized inputs.
    if (outStat.size >= sourceStat.size * 0.95) {
      return res.json({
        skipped: true,
        reason: 'no_size_gain',
        durationSeconds: durationSeconds || originalDuration,
        originalSize: sourceStat.size,
        transcodedSize: outStat.size,
      });
    }

    const baseKey =
      channelId && messageId
        ? `audio/channel/${channelId}/${messageId}.m4a`
        : `audio/misc/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`;

    const newUrl = await uploadFileToSpaces(outputPath, baseKey, 'audio/mp4');

    return res.json({
      skipped: false,
      url: newUrl,
      durationSeconds: durationSeconds || originalDuration,
      originalSize: sourceStat.size,
      transcodedSize: outStat.size,
    });
  } catch (err) {
    console.error('Audio transcode error', err);
    return res.status(500).json({ error: 'audio_transcode_failed' });
  } finally {
    if (workDir) {
      try {
        await fs.promises.rm(workDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('Audio transcode temp cleanup error', cleanupError);
      }
    }
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
