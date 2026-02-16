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

// ICE Servers Configuration (STUN + TURN)
// TURN server is CRITICAL for mobile users behind symmetric NAT
const ICE_SERVERS = [
  // Google STUN servers (free, reliable)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  // Local TURN server (coturn) - recommended for production
  // Configure your own TURN server for best results
  ...(process.env.TURN_SERVER_URL ? [
    {
      urls: process.env.TURN_SERVER_URL,
      username: process.env.TURN_SERVER_USERNAME || 'turnuser',
      credential: process.env.TURN_SERVER_CREDENTIAL || 'turnpassword'
    },
    {
      urls: process.env.TURN_SERVER_URL + '?transport=tcp',
      username: process.env.TURN_SERVER_USERNAME || 'turnuser',
      credential: process.env.TURN_SERVER_CREDENTIAL || 'turnpassword'
    },
    {
      urls: process.env.TURN_SERVER_URL.replace('turn:', 'turns:').replace(':3478', ':5349'),
      username: process.env.TURN_SERVER_USERNAME || 'turnuser',
      credential: process.env.TURN_SERVER_CREDENTIAL || 'turnpassword'
    }
  ] : [
    // Free TURN servers for testing (NOT for production - limited bandwidth)
    // Metered.ca free tier
    {
      urls: 'turn:a.relay.metered.ca:80',
      username: 'e8dd65c92f9c9c4e4c2df66f',
      credential: 'uWdWNmkhvyqTH3/c'
    },
    {
      urls: 'turn:a.relay.metered.ca:443',
      username: 'e8dd65c92f9c9c4e4c2df66f',
      credential: 'uWdWNmkhvyqTH3/c'
    },
    {
      urls: 'turn:a.relay.metered.ca:443?transport=tcp',
      username: 'e8dd65c92f9c9c4e4c2df66f',
      credential: 'uWdWNmkhvyqTH3/c'
    }
  ])
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
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
      { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 2, 'x-google-start-bitrate': 1000 } },
      { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '4d0032', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 } },
    ],
  },
  webRtcTransport: {
    listenIps: [{ ip: MEDIASOUP_LISTEN_IP, announcedIp: MEDIASOUP_ANNOUNCED_IP }],
    enableUdp: true,
    enableTcp: true, // IMPORTANT: Enable TCP fallback for firewall issues
    preferUdp: true, // Prefer UDP but allow TCP fallback
    initialAvailableOutgoingBitrate: 1000000,
    maxIncomingBitrate: 1500000,
  },
};

console.log('[ConferenceSocket] Mediasoup config:', {
  listenIp: MEDIASOUP_LISTEN_IP,
  announcedIp: MEDIASOUP_ANNOUNCED_IP,
  portRange: `${MEDIASOUP_MIN_PORT}-${MEDIASOUP_MAX_PORT}`,
  iceServersCount: ICE_SERVERS.length
});

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
        iceServers: ICE_SERVERS, // CRITICAL: Send ICE servers including TURN for NAT traversal
        participants: Array.from(room.peers.values()).map(p => ({
            socketId: p.socketId,
            userId: p.userId,
            userName: p.userName || 'Unknown User',
            userAvatar: p.userAvatar,
            isAdmin: p.isAdmin
        }))
      };
      
      console.log('[ConferenceSocket] Sending room-joined response with ICE servers:', ICE_SERVERS.length, 'servers,', responseData.participants.length, 'participants');

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
    const getRtpCapabilities = (dataOrCallback, maybeCallback) => {
      // Support both (callback) and (data, callback) signatures
      const callback = typeof dataOrCallback === 'function' ? dataOrCallback : maybeCallback;
      
      if (typeof callback !== 'function') {
        console.error('[ConferenceSocket] getRtpCapabilities called without callback');
        return;
      }
      
      let room;
      for (const r of rooms.values()) {
        if (r.peers.has(socket.id)) {
          room = r;
          break;
        }
      }
      if (!room) return callback({ error: 'Not in a room' });
      
      console.log('[ConferenceSocket] Sending RTP capabilities');
      callback({ rtpCapabilities: room.router.rtpCapabilities });
    };

    socket.on('sfu:get-rtp-capabilities', getRtpCapabilities);
    socket.on('getRouterRtpCapabilities', getRtpCapabilities); // Legacy

    const createTransport = async (dataOrCallback, maybeCallback) => {
        // Support both (callback) and (data, callback) signatures
        const callback = typeof dataOrCallback === 'function' ? dataOrCallback : maybeCallback;
        const data = typeof dataOrCallback === 'object' ? dataOrCallback : {};
        
        if (typeof callback !== 'function') {
            console.error('[ConferenceSocket] createTransport called without callback');
            return;
        }
        
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

            console.log(`[ConferenceSocket] Created ${data.consumer ? 'recv' : 'send'} transport: ${transport.id}`);
    
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
            console.error('[ConferenceSocket] createTransport error:', err.message);
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
            console.log(`[ConferenceSocket] Produce request: kind=${kind}, transportId=${transportId}`);
            
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

            console.log(`[ConferenceSocket] Producer created: ${producer.id} (${kind}) for user ${socket.userName}`);

            // Announce to others
            const announcementData = {
                producerId: producer.id,
                producerSocketId: socket.id,
                socketId: socket.id,
                userId: socket.userId,
                kind: producer.kind,
                appData: producer.appData
            };
            
            socket.to(roomId).emit('sfu:new-producer', announcementData);
            
            // Legacy announce
            socket.to(roomId).emit('newProducer', {
                producerId: producer.id,
                socketId: socket.id,
                kind: producer.kind
            });

            console.log(`[ConferenceSocket] Announced new producer to room ${roomId}`);
            callback({ id: producer.id, producerId: producer.id }); // Support both id and producerId
        } catch (err) {
            console.error('[ConferenceSocket] Produce error:', err.message);
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
