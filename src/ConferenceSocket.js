const mediasoup = require('mediasoup');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const config = require('./config');

dotenv.config();

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || (config.jwt && config.jwt.key) || 'saigm_video_chat_sfu_jwt_secret';
const MEDIASOUP_MIN_PORT = parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000; // Safe range
const MEDIASOUP_MAX_PORT = parseInt(process.env.MEDIASOUP_MAX_PORT) || 40100;
const MEDIASOUP_LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
const MEDIASOUP_ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || '104.248.212.6'; // Public IP fallback

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
  const numWorkers = 1;
  console.log(`[ConferenceSocket] Creating ${numWorkers} mediasoup workers...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: mediasoupConfig.worker.logLevel,
      logTags: mediasoupConfig.worker.logTags,
      rtcMinPort: mediasoupConfig.worker.rtcMinPort,
      rtcMaxPort: mediasoupConfig.worker.rtcMaxPort,
    });

    worker.on('died', () => {
      console.error('[ConferenceSocket] Mediasoup worker died, exiting...');
      process.exit(1); // Careful with this in shared process
    });

    workers.push(worker);
  }
}

function getNextWorker() {
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

module.exports = async function init(io) {
  const conferenceNsp = io.of('/conference');

  conferenceNsp.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
    // Allow unauthenticated for now if token missing? No, strict.
    if (!token) {
        console.warn('[ConferenceSocket] Missing token');
        return next(new Error('Authentication required'));
    }

    // Try to verify with multiple secrets to handle dev/prod mismatches
    let decoded = null;
    const secrets = [
        process.env.JWT_SECRET,
        config.jwt && config.jwt.key,
        'saigm_video_chat_sfu_jwt_secret',
        'saigmvideochatsfu_jwt_secret',
        'thisisasamplesecret'
    ].filter(Boolean); // Remove null/undefined

    for (const secret of secrets) {
        try {
            decoded = jwt.verify(token, secret);
            // If verification succeeds, break the loop
            break;
        } catch (e) {
            // Continue to next secret
        }
    }

    if (!decoded) {
        console.error('[ConferenceSocket] Invalid token: verification failed with all available secrets');
        return next(new Error('Invalid token'));
    }

    socket.userId = decoded.sub || decoded.id || decoded.user_id; // Handle various payload formats
    socket.isAdmin = !!(decoded.is_admin || decoded.role === 'admin' || decoded.admin);
    socket.userName = socket.handshake.query.name || 'User';
    socket.userAvatar = socket.handshake.query.avatar || null;
    next();
  });

  conferenceNsp.on('connection', (socket) => {
    console.log(`[ConferenceSocket] User connected: ${socket.userId} (${socket.userName}) [Admin: ${socket.isAdmin}]`);

    socket.on('join-room', async (data, callback) => {
      const roomId = data.roomId || data.roomName;
      const { userName } = data;
      
      if (!roomId) {
          if (typeof callback === 'function') callback({ error: 'Missing roomId' });
          return;
      }

      if (workers.length === 0) {
        console.warn('[ConferenceSocket] Workers not ready, rejecting join-room');
        const errorMsg = 'Server initializing, please try again';
        if (typeof callback === 'function') callback({ error: errorMsg });
        else socket.emit('error', { message: errorMsg });
        return;
      }

      socket.join(roomId);
      
      let router;
      if (rooms.has(roomId)) {
        router = rooms.get(roomId).router;
      } else {
        const worker = getNextWorker();
        router = await worker.createRouter({ mediaCodecs: mediasoupConfig.router.mediaCodecs });
        rooms.set(roomId, { router, peers: new Map() });
        console.log(`[ConferenceSocket] Created router for room ${roomId}`);
      }

      const room = rooms.get(roomId);
      if (room.peers.has(socket.id)) {
          const oldPeer = room.peers.get(socket.id);
          oldPeer.transports.forEach(t => t.close());
      }
      
      room.peers.set(socket.id, { 
      socket, // Store socket reference
      userId: socket.userId,
      socketId: socket.id,
      userName: socket.userName || userName,
      userAvatar: socket.userAvatar,
      isAdmin: socket.isAdmin,
      transports: [], 
      producers: [], 
      consumers: [] 
    });

      console.log(`[ConferenceSocket] User joined room ${roomId}: ${socket.userName} (Peers: ${room.peers.size})`);

      const responseData = {
        roomId,
        mode: 'sfu',
        isAdmin: socket.isAdmin,
        participants: Array.from(room.peers.values()).map(p => ({
            socketId: p.socketId,
            userId: p.userId,
            userName: p.userName || 'Unknown User',
            userAvatar: p.userAvatar,
            isAdmin: p.isAdmin
        }))
      };
      
      console.log('[ConferenceSocket] Sending room-joined response:', JSON.stringify(responseData.participants.map(p => p.userName)));

      socket.emit('room-joined', responseData);
      if (typeof callback === 'function') callback(responseData);

      socket.to(roomId).emit('user-joined', {
        socketId: socket.id,
        userId: socket.userId,
        userName: socket.userName || userName,
        userAvatar: socket.userAvatar,
        isAdmin: socket.isAdmin,
      });
    });

    socket.on('disconnect', () => {
      rooms.forEach((room, roomId) => {
        if (room.peers.has(socket.id)) {
          // Notify others before cleaning up
          socket.to(roomId).emit('user-left', {
              socketId: socket.id,
              userId: socket.userId
          });

          const peer = room.peers.get(socket.id);
          peer.transports.forEach(t => t.close());
          room.peers.delete(socket.id);
          
          if (room.peers.size === 0) {
            room.router.close();
            rooms.delete(roomId);
            console.log(`[ConferenceSocket] Room ${roomId} closed`);
          }
        }
      });
    });

    // SFU Handlers
    const getRtpCapabilities = (callback) => {
      let room;
      for (const r of rooms.values()) {
        if (r.peers.has(socket.id)) {
          room = r;
          break;
        }
      }
      if (!room) return callback({ error: 'Not in a room' });
      callback({ rtpCapabilities: room.router.rtpCapabilities });
    };

    socket.on('sfu:get-rtp-capabilities', getRtpCapabilities);
    socket.on('getRouterRtpCapabilities', getRtpCapabilities); // Legacy

    const createTransport = async (callback) => {
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
                },
                id: transport.id, // Legacy support
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters
            });
        } catch (err) {
            callback({ error: err.message });
        }
    };

    socket.on('sfu:create-send-transport', createTransport);
    socket.on('createWebRtcTransport', createTransport); // Legacy
    socket.on('sfu:create-recv-transport', createTransport);

    const connectTransport = async ({ transportId, dtlsParameters }, callback) => {
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
            callback({ connected: true });
        } catch (err) {
            callback({ error: err.message });
        }
    };

    socket.on('sfu:connect-transport', connectTransport);
    socket.on('connectTransport', connectTransport); // Legacy

    const produce = async ({ transportId, kind, rtpParameters }, callback) => {
        try {
            let room;
            let roomId;
            for (const [rId, r] of rooms.entries()) {
                if (r.peers.has(socket.id)) {
                    room = r;
                    roomId = rId;
                    break;
                }
            }
            if (!room) throw new Error('Not in room');

            const peer = room.peers.get(socket.id);
            const transport = peer.transports.find(t => t.id === transportId);
            if (!transport) throw new Error('Transport not found');

            const producer = await transport.produce({ 
                kind, 
                rtpParameters,
                appData: { producerOdaId: socket.userId, mediaType: kind } 
            });
            peer.producers.push(producer);

            producer.on('transportclose', () => {
                producer.close();
            });

            // Announce to others
            socket.to(roomId).emit('sfu:new-producer', {
                producerId: producer.id,
                producerSocketId: socket.id,
                socketId: socket.id,
                userId: socket.userId,
                kind: producer.kind,
                appData: producer.appData
            });
            
            // Legacy announce
            socket.to(roomId).emit('newProducer', {
                producerId: producer.id,
                socketId: socket.id,
                kind: producer.kind
            });

            callback({ id: producer.id });
        } catch (err) {
            callback({ error: err.message });
        }
    };

    socket.on('sfu:produce', produce);
    socket.on('produce', produce); // Legacy

    const consume = async ({ producerId, rtpCapabilities, transportId, consumerTransportId }, callback) => {
        try {
            let room;
            for (const r of rooms.values()) {
                if (r.peers.has(socket.id)) {
                    room = r;
                    break;
                }
            }
            if (!room) throw new Error('Not in room');

            const roomRouter = room.router;
            if (!roomRouter.canConsume({ producerId, rtpCapabilities })) {
                return callback({ error: 'Cannot consume' });
            }

            const peer = room.peers.get(socket.id);
            const tId = transportId || consumerTransportId;
            const transport = peer.transports.find(t => t.id === tId);
            if (!transport) throw new Error('Transport not found');

            const consumer = await transport.consume({
                producerId,
                rtpCapabilities,
                paused: true,
            });

            peer.consumers.push(consumer);

            consumer.on('transportclose', () => {
                consumer.close();
            });
            
            consumer.on('producerclose', () => {
                consumer.close();
                socket.emit('consumer-closed', { consumerId: consumer.id });
                socket.emit('consumerClosed', { consumer_id: consumer.id, consumer_kind: consumer.kind });
            });

            callback({
                id: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
            
            // Resume immediately? Client usually asks to resume.
        } catch (err) {
            callback({ error: err.message });
        }
    };

    socket.on('sfu:consume', consume);
    socket.on('consume', consume); // Legacy

    const resumeConsumer = async ({ consumerId }, callback) => {
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
            const consumer = peer.consumers.find(c => c.id === consumerId);
            if (!consumer) throw new Error('Consumer not found');
            
            await consumer.resume();
            if (typeof callback === 'function') callback({ resumed: true });
        } catch(err) {
            if (typeof callback === 'function') callback({ error: err.message });
        }
    };

    socket.on('sfu:resume-consumer', resumeConsumer);
    socket.on('resumeConsumer', resumeConsumer); // Legacy

    const pauseConsumer = async ({ consumerId }, callback) => {
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
            const consumer = peer.consumers.find(c => c.id === consumerId);
            if (!consumer) throw new Error('Consumer not found');
            
            await consumer.pause();
            if (typeof callback === 'function') callback({ paused: true });
        } catch(err) {
            if (typeof callback === 'function') callback({ error: err.message });
        }
    };

    socket.on('sfu:pause-consumer', pauseConsumer);

    const setConsumerLayers = async ({ consumerId, spatialLayer, temporalLayer }, callback) => {
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
            const consumer = peer.consumers.find(c => c.id === consumerId);
            if (!consumer) throw new Error('Consumer not found');
            
            await consumer.setPreferredLayers({ spatialLayer, temporalLayer });
            if (typeof callback === 'function') callback({ layersSet: true });
        } catch(err) {
            if (typeof callback === 'function') callback({ error: err.message });
        }
    };

    socket.on('sfu:consumer-set-layers', setConsumerLayers);

    socket.on('getProducers', () => {
        let room;
        for (const r of rooms.values()) {
            if (r.peers.has(socket.id)) {
                room = r;
                break;
            }
        }
        if (!room) return;

        console.log(`[ConferenceSocket] Sending existing producers to ${socket.userName}`);

        const producers = [];
        for (const peer of room.peers.values()) {
            if (peer.socketId === socket.id) continue;

            for (const producer of peer.producers) {
                producers.push({
                    producer_id: producer.id,
                    producer_socket_id: peer.socketId,
                    peer_name: peer.userName,
                    kind: producer.kind,
                    type: producer.type,
                    appData: producer.appData || { producerOdaId: peer.userId }
                });
            }
        }
        
        if (producers.length > 0) {
            console.log(`[ConferenceSocket] Sending ${producers.length} producers to ${socket.userName}`);
            socket.emit('newProducers', producers);
        }
    });
  });

  // Initialize workers
  if (workers.length === 0) {
    await runMediasoupWorkers();
  }
};
