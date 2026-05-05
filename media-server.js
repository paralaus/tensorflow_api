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
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      // VP8 (Genel uyumluluk için)
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
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
          room.router.close();
          rooms.delete(roomId);
          roomHostByRoom.delete(roomId);
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
