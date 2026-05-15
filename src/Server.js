'use strict';

/*
dependencies: {
    @sentry/node            : https://www.npmjs.com/package/@sentry/node
    @sentry/integrations    : https://www.npmjs.com/package/@sentry/integrations
    axios                   : https://www.npmjs.com/package/axios
    body-parser             : https://www.npmjs.com/package/body-parser
    compression             : https://www.npmjs.com/package/compression
    colors                  : https://www.npmjs.com/package/colors
    cors                    : https://www.npmjs.com/package/cors
    crypto-js               : https://www.npmjs.com/package/crypto-js
    express                 : https://www.npmjs.com/package/express
    express-openid-connect  : https://www.npmjs.com/package/express-openid-connect
    httpolyglot             : https://www.npmjs.com/package/httpolyglot
    jsonwebtoken            : https://www.npmjs.com/package/jsonwebtoken
    js-yaml                 : https://www.npmjs.com/package/js-yaml
    mediasoup               : https://www.npmjs.com/package/mediasoup
    mediasoup-client        : https://www.npmjs.com/package/mediasoup-client
    ngrok                   : https://www.npmjs.com/package/ngrok
    openai                  : https://www.npmjs.com/package/openai
    qs                      : https://www.npmjs.com/package/qs
    socket.io               : https://www.npmjs.com/package/socket.io
    swagger-ui-express      : https://www.npmjs.com/package/swagger-ui-express
    uuid                    : https://www.npmjs.com/package/uuid
    xss                     : https://www.npmjs.com/package/xss
}
*/

/**
 * SAI-GM Video Chat SFU - Sunucu bileşeni
 */

require('dotenv').config();
const express = require('express');
const { auth, requiresAuth } = require('express-openid-connect');
const cors = require('cors');
const compression = require('compression');
const https = require('httpolyglot');
const mediasoup = require('mediasoup');
const mediasoupClient = require('mediasoup-client');
const http = require('http');
const path = require('path');
const axios = require('axios');
const ngrok = require('ngrok');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const dgram = require('dgram');
const config = require('./config');
const checkXSS = require('./XSS.js');
const Host = require('./Host');
const Room = require('./Room');
const Peer = require('./Peer');
const ServerApi = require('./ServerApi');
const Logger = require('./Logger');
const log = new Logger('Server');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = yaml.load(fs.readFileSync(path.join(__dirname, '/../api/swagger.yaml'), 'utf8'));
const Sentry = require('@sentry/node');
const { CaptureConsole } = require('@sentry/integrations');
const restrictAccessByIP = require('./middleware/IpWhitelist.js');
const packageJson = require('../package.json');

// E-posta uyarıları ve bildirimleri
const nodemailer = require('./lib/nodemailer');

// Slack API
const CryptoJS = require('crypto-js');
const qS = require('qs');
const slackEnabled = config.slack.enabled;
const slackSigningSecret = config.slack.signingSecret;
const bodyParser = require('body-parser');
const { S3 } = require('@aws-sdk/client-s3');
const { createSpacesHlsUploader } = require('./SpacesHlsUploader');
const { spawn } = require('child_process');
const os = require('os');
require('dotenv').config();

const app = express();

// HLS / Spaces Configuration
const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT;
const SPACES_KEY = process.env.SPACES_KEY;
const SPACES_SECRET = process.env.SPACES_SECRET;
const SPACES_BUCKET = process.env.SPACES_BUCKET;
const SPACES_REGION = process.env.SPACES_REGION;

// Live HLS → Spaces CDN config
// SPACES_PUBLIC_BASE_URL: CDN/edge URL viewers fetch HLS from (e.g.
//   https://hissechat.fra1.cdn.digitaloceanspaces.com). When set, viewer
//   playlists are served from Spaces and the droplet's egress bandwidth stays
//   flat regardless of viewer count.
// SPACES_HLS_PREFIX: key prefix inside the bucket; default 'live'. Each room
//   is stored under `<prefix>/<roomId>/{index.m3u8,init.mp4,seg_*.m4s}`.
// SPACES_HLS_RETENTION_SEC: seconds to keep objects after pipeline stop
//   before bulk-delete. Default 600 (10 min) — enough for replay buffers.
const SPACES_PUBLIC_BASE_URL = String(process.env.SPACES_PUBLIC_BASE_URL || '').trim();
const SPACES_HLS_PREFIX = (process.env.SPACES_HLS_PREFIX || 'live').replace(/^\/+|\/+$/g, '');
const SPACES_HLS_RETENTION_SEC = (() => {
    const n = parseInt(process.env.SPACES_HLS_RETENTION_SEC, 10);
    return Number.isFinite(n) ? n : 600;
})();

// LIVE_HLS_VOD_ENABLED: "Replay (VOD)" — yayin bittikten sonra video kalici
// olsun mu? true ise:
//   * Canli sirasinda FFmpeg'in `delete_segments` bayragi kaldirilir ve
//     `hls_list_size=0` yapilir; tum segmentler diskte ve Spaces'te kalir
//     (~50MB/saat @ 1.2Mbps).
//   * Yayin bitince playlist `#EXT-X-PLAYLIST-TYPE:VOD` + `#EXT-X-ENDLIST`
//     ile finalize edilir ve Spaces'e son hali yuklenir.
//   * `deleteRemote()` cagrilmaz; ayni `index.m3u8` URL'i replay olarak
//     calismaya devam eder.
// SPACES yapilandirilmissa default ON. Manuel kapatmak icin '0' ver.
const LIVE_HLS_VOD_ENABLED = (() => {
    const v = String(process.env.LIVE_HLS_VOD_ENABLED || '').trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return Boolean(SPACES_PUBLIC_BASE_URL && SPACES_BUCKET);
})();

// VOD finalize edildikten sonra lokal kopyayi diskte ne kadar tutalim.
// Spaces'e mirror edildigi icin lokali silmek guvenli; default 1 saat.
const LIVE_HLS_VOD_LOCAL_CLEANUP_SEC = (() => {
    const n = parseInt(process.env.LIVE_HLS_VOD_LOCAL_CLEANUP_SEC, 10);
    return Number.isFinite(n) ? n : 3600;
})();

// ============================================================================
// LIVE HLS BROADCAST PIPELINE (PlainTransport -> FFmpeg -> HLS)
// Ported from media-server.js so that the conference mediasoup router
// (owned by this process) can feed FFmpeg directly.
// ============================================================================

function _parseIntEnv(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

const LIVE_HLS_PORT = _parseIntEnv(process.env.PORT, 4000);
const LIVE_HLS_DIR = process.env.LIVE_HLS_DIR
    ? path.resolve(process.env.LIVE_HLS_DIR)
    : path.join(__dirname, '..', 'public', 'live');
try {
    fs.mkdirSync(LIVE_HLS_DIR, { recursive: true });
} catch (_) {}

const LIVE_HLS_BASE_URL =
    String(process.env.LIVE_HLS_BASE_URL || '').trim() ||
    String(process.env.MEDIA_PUBLIC_BASE_URL || '').trim() ||
    `http://localhost:${LIVE_HLS_PORT}/live`;

// IMPORTANT: keep this range OUTSIDE mediasoup worker's rtcMinPort/rtcMaxPort
// (default 10000-59999). PlainTransport's listenIp picks a random local port
// from that worker range, so any overlap causes ffmpeg's UDP bind to fail
// with 'Address already in use'. 60000-60400 is well outside the default.
const LIVE_RTP_PORT_BASE = _parseIntEnv(process.env.LIVE_RTP_PORT_BASE, 60000);
const LIVE_RTP_PORT_MAX = _parseIntEnv(process.env.LIVE_RTP_PORT_MAX, 60400);
const liveRtpPortInUse = new Set();
const liveHlsPipelines = new Map(); // roomId -> pipeline
const liveHlsCleanupTimers = new Map(); // roomId -> Timeout
const liveBroadcastSessions = new Map(); // roomId -> session metadata
const liveHlsRestartState = new Map(); // roomId -> { lastFailAt, failCount, nextAllowedAt }

function cancelLiveHlsCleanup(roomId, reason) {
    const t = liveHlsCleanupTimers.get(roomId);
    if (t) {
        clearTimeout(t);
        liveHlsCleanupTimers.delete(roomId);
        log.info(`[live-hls ${roomId}] cleanup timer cancelled (${reason || 'restart'})`);
    }
}

function allocLiveRtpPort() {
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

// Test whether a UDP port can be bound on 127.0.0.1 right now. Used to skip
// ports already held by other processes on the host so ffmpeg doesn't crash
// with 'Address already in use'.
function probeUdpPortFree(port) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { sock.close(); } catch (_) {}
            resolve(ok);
        };
        sock.once('error', () => finish(false));
        try {
            sock.bind({ port, address: '127.0.0.1', exclusive: true }, () => finish(true));
        } catch (_) {
            finish(false);
        }
    });
}

// Reserve a UDP port that is both free in our in-memory tracker AND actually
// bindable on the host. Returns the port number, or throws if exhausted.
//
// Strategy: first ask the kernel for an ephemeral port (bind to :0). The OS
// guarantees this port is free right now and uses a wide range (Linux default
// 32768-60999), which avoids the case where a fixed port like 60000 is being
// held by another process on the host. We close the probe socket immediately
// so ffmpeg can take the port; a tiny race window remains but is far smaller
// than scanning a fixed slot.
async function reserveBindableUdpPort() {
    // First try OS-assigned ephemeral ports (a few attempts).
    for (let attempt = 0; attempt < 8; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        const port = await new Promise((resolve) => {
            const sock = dgram.createSocket('udp4');
            sock.once('error', () => resolve(null));
            try {
                sock.bind({ port: 0, address: '127.0.0.1', exclusive: true }, () => {
                    const p = sock.address() && sock.address().port;
                    sock.close(() => resolve(p || null));
                });
            } catch (_) {
                resolve(null);
            }
        });
        if (port && !liveRtpPortInUse.has(port)) {
            liveRtpPortInUse.add(port);
            return port;
        }
    }
    // Fallback: scan the configured fixed range and probe each port.
    for (let p = LIVE_RTP_PORT_BASE; p <= LIVE_RTP_PORT_MAX; p++) {
        if (liveRtpPortInUse.has(p)) continue;
        // eslint-disable-next-line no-await-in-loop
        const ok = await probeUdpPortFree(p);
        if (ok) {
            liveRtpPortInUse.add(p);
            return p;
        }
    }
    throw new Error('no_bindable_live_rtp_port');
}

function sanitizeRoomIdForPath(roomId) {
    return String(roomId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'room';
}

// Yayin bittikten sonra HLS playlist'i "VOD" formatina cevirir:
//   * #EXT-X-PLAYLIST-TYPE:VOD baslik ekler (yoksa)
//   * Sonuna #EXT-X-ENDLIST ekler (player'a "akis bitti, basa sarilabilir"
//     sinyali verir; seek bar dolu gozukur).
// Yazma sonrasi fs.watch'i tetikleyip Spaces'e son hali itmek arayanin sorumlulugu.
async function finalizeVodPlaylist(roomId, hlsDir) {
    const playlistPath = path.join(hlsDir, 'index.m3u8');
    let text;
    try {
        text = await fs.promises.readFile(playlistPath, 'utf8');
    } catch (e) {
        log.error(`[live-hls ${roomId}] vod finalize read failed: ${e.message}`);
        return null;
    }
    if (/#EXT-X-ENDLIST/.test(text)) return playlistPath; // zaten finalize

    if (/#EXT-X-PLAYLIST-TYPE:/.test(text)) {
        text = text.replace(/#EXT-X-PLAYLIST-TYPE:[A-Z]+/, '#EXT-X-PLAYLIST-TYPE:VOD');
    } else {
        text = text.replace(/(#EXTM3U\s*\n)/, '$1#EXT-X-PLAYLIST-TYPE:VOD\n');
    }
    if (!text.endsWith('\n')) text += '\n';
    text += '#EXT-X-ENDLIST\n';
    await fs.promises.writeFile(playlistPath, text, 'utf8');
    log.info(`[live-hls ${roomId}] vod playlist finalized (${text.length} bytes)`);
    return playlistPath;
}

// Pick the first video (and optionally audio) producer in a Room.
// Server.js uses Room (src/Room.js) with peers Map<socketId, Peer>;
// each Peer (src/Peer.js) keeps `producers` as Map<producerId, producer>.
function pickProducersForBroadcast(room) {
    let videoProducer = null;
    let audioProducer = null;
    if (!room || !room.peers) return { videoProducer, audioProducer };
    for (const peer of room.peers.values()) {
        if (!peer || !peer.producers) continue;
        const iter =
            typeof peer.producers.values === 'function'
                ? peer.producers.values()
                : peer.producers;
        for (const producer of iter) {
            if (!producer || producer.closed) continue;
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
        const mime = codec.mimeType.split('/')[1];
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

// Resolve a mediasoup room by id, looking in Server.js's own `roomList` first
// and falling back to the ConferenceSocket module's `rooms` map. Both expose
// `{ router, peers: Map<socketId, { producers }> }` and are compatible with
// `pickProducersForBroadcast`.
function resolveMediasoupRoom(roomId) {
    if (roomList && roomList.has && roomList.has(roomId)) return roomList.get(roomId);
    const confRooms = conferenceSocketMod && conferenceSocketMod.rooms;
    if (confRooms && confRooms.has(roomId)) return confRooms.get(roomId);
    return null;
}

function hasMediasoupRoom(roomId) {
    return resolveMediasoupRoom(roomId) !== null;
}

async function startLiveHlsForRoom(roomId) {
    if (liveHlsPipelines.has(roomId)) return liveHlsPipelines.get(roomId);

    const room = resolveMediasoupRoom(roomId);
    if (!room) throw new Error(`live_hls_room_not_found:${roomId}`);

    const { videoProducer, audioProducer } = pickProducersForBroadcast(room);
    if (!videoProducer) {
        log.info(`[live-hls ${roomId}] no video producer yet (peers=${room.peers ? room.peers.size : 0}); will retry on next produce`);
        return null;
    }
    log.info(`[live-hls ${roomId}] producers ready (video=${!!videoProducer}, audio=${!!audioProducer}); starting pipeline`);

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

    cancelLiveHlsCleanup(roomId, 'pipeline-start');

    try {
        await fs.promises.mkdir(hlsDir, { recursive: true });

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
                log.info(`[live-hls ${roomId}] resuming segment numbering at ${startNumber}`);
            } else {
                await Promise.all(
                    existing.map((f) =>
                        fs.promises.unlink(path.join(hlsDir, f)).catch(() => {}),
                    ),
                );
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
        videoPort = await reserveBindableUdpPort();
        await videoTransport.connect({ ip: '127.0.0.1', port: videoPort });
        videoConsumer = await videoTransport.consume({
            producerId: videoProducer.id,
            rtpCapabilities: router.rtpCapabilities,
            paused: true,
            // Simulcast producer'larda EN YUKSEK spatial+temporal katmani sec:
            //   spatialLayer 2 = HD katman (~720p, 30fps)
            //   spatialLayer 0 = en dusuk katman (~180p, 10-15fps) -> FFmpeg'in
            //     "More than 1000 frames duplicated" yazip izleyicide donma
            //     hissi vermesinin asil sebebi buydu.
            // Yayinci simulcast yapmiyorsa (tek katman) mediasoup otomatik
            // mevcut en yuksege clamp eder; kotu bir senaryo yok.
            preferredLayers: { spatialLayer: 2, temporalLayer: 2 },
        });

        // Lock the layer hard so mediasoup BWE doesn't downgrade us mid-stream.
        try {
            await videoConsumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
        } catch (_) {}

        if (audioProducer) {
            audioTransport = await router.createPlainTransport(plainOpts);
            audioPort = await reserveBindableUdpPort();
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

        // Detect video codec to decide between passthrough (no transcode) and
        // libx264 transcode. If the producer is already H.264 we can pipe RTP
        // straight into the HLS muxer, which is ~10x cheaper on CPU and adds
        // ~1-2 seconds less latency than decode+re-encode.
        const videoMime = (videoConsumer.rtpParameters.codecs[0].mimeType || '').toLowerCase();
        const isH264Passthrough = videoMime === 'video/h264';
        log.info(`[live-hls ${roomId}] video codec=${videoMime} mode=${isH264Passthrough ? 'passthrough' : 'transcode'}`);

        const videoOutputArgs = isH264Passthrough
            ? [
                // Passthrough: ship the H.264 NAL units straight into HLS.
                // We still need bitstream filter to insert SPS/PPS in every
                // keyframe (some players require it for mid-stream join).
                '-c:v', 'copy',
                '-bsf:v', 'h264_mp4toannexb,dump_extra=freq=keyframe',
            ]
            : [
                // Transcode fallback (VP8/VP9 -> H.264). Mobile-friendly
                // settings for React Native Video (ExoPlayer / AVPlayer):
                // CFR 24fps is enough for talking-head content and avoids
                // duplicating frames from sources that don't hit 30fps.
                // GOP 48 (2s) aligns with hls_time=2 so every segment
                // starts with an IDR -> seamless ABR / mid-stream join.
                // ultrafast + scaled 720p + threaded encoding: tarayıcı/cihaz
                // H.264 yerine VP8 yolladığında transcode kaçınılmaz. CPU
                // bütçesini taşmaması için: çözünürlük 720p'ye düşürülür
                // (mobil için zaten yeterli), preset ultrafast, x264 thread
                // limiti 4 (8vCPU'da diğer yayınlara yer bırakır).
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-profile:v', 'baseline',
                '-level', '3.1',
                '-pix_fmt', 'yuv420p',
                '-vf', 'scale=-2:720,format=yuv420p',
                // VFR (passthrough timestamps): kaynak <24fps verirse
                // duplicate frame uretmek yerine olan FPS'i koru. Bu hem
                // CPU'yu dusurur hem de izleyici tarafinda "ayni kare 200ms
                // donuyor sonra zipliyor" hissini ortadan kaldirir.
                // -r yok; HLS keyframe alignment frame-bazli -g yerine
                // zaman-bazli -force_key_frames ile saglaniyor (FPS ne olursa
                // olsun her 2sn'de IDR -> her segment kendi keyframe'i ile baslar).
                '-force_key_frames', 'expr:gte(t,n_forced*2)',
                '-sc_threshold', '0',
                '-threads', '4',
                '-b:v', '1200k',
                '-maxrate', '1400k',
                '-bufsize', '2800k',
                '-x264-params', 'sliced-threads=1:sync-lookahead=0:rc-lookahead=0',
            ];

        const ffmpegArgs = [
            '-loglevel', 'warning',
            // -stats: warning seviyesinde bile periyodik "frame=.. fps=.. bitrate=.."
            // progress satirlarini stderr'e yazar. Live yayinin gercek FPS'i ve
            // bitrate'ini izlemek icin gerekli. Yaklasik 2sn'de bir satir basar.
            '-stats',
            '-protocol_whitelist', 'file,udp,rtp',
            // NOTE: do NOT use +genpts here. RTP packets carry their own
            // timestamps; +genpts would overwrite them with a frame counter
            // and cause libx264 to encode at wall-clock speed (1000+ fps)
            // producing endless 'VBV underflow' warnings. Use the RTP
            // timestamps as-is; -fflags nobuffer keeps latency low.
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            // Give ffmpeg enough data to parse H.264 SPS/PPS before it gives
            // up. With -probesize 32 / -analyzeduration 0 it sometimes never
            // initializes the decoder, so no segments are produced.
            '-probesize', '500000',
            '-analyzeduration', '500000',
            // RTP demuxer reorder buffer. Defaults are tiny (~500ms /
            // 500 packets) and overflow rapidly under simulcast/layer
            // switching, producing 'RTP: missed N packets' floods. Give
            // it more headroom.
            '-max_delay', '5000000',
            '-reorder_queue_size', '16384',
            '-i', sdpPath,
            '-map', '0:v:0',
            ...(audioConsumer ? ['-map', '0:a:0'] : []),
            ...videoOutputArgs,
            ...(audioConsumer
                ? ['-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
                   // aresample async=1 absorbs RTP jitter and resamples to a
                   // monotonic PTS instead of FFmpeg printing "Non-monotonic
                   // DTS" warnings + occasional audio drops on the client.
                   '-af', 'aresample=async=1:first_pts=0']
                : []),
            '-f', 'hls',
            // Mobile-friendly HLS: 2s segments x 8 list = 16s playlist
            // window. Bigger than LL-HLS but much more resilient to mobile
            // network jitter (TCP slow-start has time to ramp, players can
            // pre-buffer ~3-4 segments before showing first frame).
            // Glass-to-glass latency ~6-10s, acceptable for broadcast.
            // +temp_file ensures players never read half-written segments.
            '-hls_time', '2',
            // VOD modunda kayan pencere YOK; tum segmentler kalir ki yayin
            // bittikten sonra basa sarilabilsin. Canli modda mobil network
            // jitter'a dayanikli 8x2sn=16sn pencere kullaniriz.
            '-hls_list_size', LIVE_HLS_VOD_ENABLED ? '0' : '8',
            '-hls_flags', (() => {
                // delete_segments: live moddayken eski segmentleri diskten
                //   ve playlistten siler. VOD'da ASLA olmamali, yoksa replay
                //   yapacak segment kalmaz.
                const base = LIVE_HLS_VOD_ENABLED
                    ? 'independent_segments+omit_endlist+program_date_time+temp_file'
                    : 'delete_segments+independent_segments+omit_endlist+program_date_time+temp_file';
                return resumeFromExisting ? `${base}+append_list` : base;
            })(),
            '-hls_segment_type', 'fmp4',
            '-hls_fmp4_init_filename', 'init.mp4',
            '-start_number', String(startNumber),
            '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.m4s'),
            path.join(hlsDir, 'index.m3u8'),
        ];

        log.info(`[live-hls ${roomId}] spawning ffmpeg (videoPort=${videoPort}, audioPort=${audioPort ?? 'none'})`);
        ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

        ffmpeg.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            const trimmed = text.trim();
            if (trimmed.length === 0) return;
            // Filter known benign/noisy ffmpeg lines so logs aren't flooded.
            if (/VBV underflow|past duration .* too large|Non-monotonous DTS|max delay reached|RTP: missed \d+ packets|Discarding interframe without a prior keyframe|Error submitting packet to decoder/i.test(trimmed)) return;
            log.info(`[live-hls ${roomId}] ${trimmed}`);
        });
        ffmpeg.on('error', (err) => {
            log.error(`[live-hls ${roomId}] ffmpeg error:`, err.message);
        });
        ffmpeg.on('close', (code) => {
            log.info(`[live-hls ${roomId}] ffmpeg exited code=${code}`);
            // If ffmpeg dies very quickly after start, record a failure so the
            // session-watcher backs off instead of hot-looping spawns.
            const pNow = liveHlsPipelines.get(roomId);
            const ranMs = pNow && pNow.startedAt ? Date.now() - pNow.startedAt : 0;
            if (code !== 0 && ranMs < 5000) {
                const st = liveHlsRestartState.get(roomId) || { failCount: 0 };
                st.failCount = (st.failCount || 0) + 1;
                st.lastFailAt = Date.now();
                // Exponential backoff: 2s, 4s, 8s, capped at 30s
                const backoffMs = Math.min(30000, 2000 * Math.pow(2, st.failCount - 1));
                st.nextAllowedAt = Date.now() + backoffMs;
                liveHlsRestartState.set(roomId, st);
                log.error(`[live-hls ${roomId}] ffmpeg crashed within ${ranMs}ms (code=${code}); backoff ${backoffMs}ms (fail #${st.failCount})`);
            } else if (code === 0) {
                liveHlsRestartState.delete(roomId);
            }
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
            kfTimers: [],
            kfInterval: null,
            uploader: null,
        };
        liveHlsPipelines.set(roomId, pipeline);

        // Mirror HLS output to Spaces so the CDN serves viewers and the droplet
        // egress doesn't scale with audience size. Disabled automatically if
        // SPACES_PUBLIC_BASE_URL is empty (local-only mode for dev).
        if (SPACES_PUBLIC_BASE_URL && SPACES_BUCKET) {
            const s3 = getSpacesClient();
            if (s3) {
                try {
                    pipeline.uploader = createSpacesHlsUploader({
                        s3,
                        bucket: SPACES_BUCKET,
                        localDir: hlsDir,
                        keyPrefix: `${SPACES_HLS_PREFIX}/${sanitizeRoomIdForPath(roomId)}`,
                        logInfo: (m) => log.info(`[live-hls ${roomId}] ${m}`),
                        logError: (m) => log.error(`[live-hls ${roomId}] ${m}`),
                    });
                } catch (e) {
                    log.error(`[live-hls ${roomId}] uploader init failed: ${e.message}`);
                }
            }
        }

        videoConsumer.on('producerclose', () => {
            log.info(`[live-hls ${roomId}] video producer closed`);
            stopLiveHlsForRoom(roomId).catch(() => {});
        });
        if (audioConsumer) {
            audioConsumer.on('producerclose', () => {
                log.info(`[live-hls ${roomId}] audio producer closed (continuing video-only)`);
            });
        }

        await videoConsumer.resume();
        if (audioConsumer) await audioConsumer.resume();

        // Force the broadcaster to send a key frame so ffmpeg can start
        // producing HLS segments immediately instead of waiting for the
        // next periodic keyframe. Repeat a few times to recover quickly
        // from packet loss at startup.
        const requestKf = () => {
            const p = liveHlsPipelines.get(roomId);
            if (!p || p.stopping) return;
            if (!videoConsumer || videoConsumer.closed) return;
            try {
                const ret = videoConsumer.requestKeyFrame();
                // requestKeyFrame returns a Promise; swallow rejections
                // (e.g. consumer/producer closed mid-flight) so they don't
                // crash the process as an unhandled rejection.
                if (ret && typeof ret.then === 'function') {
                    ret.catch(() => {});
                }
            } catch (_) {}
        };
        requestKf();
        pipeline.kfTimers = [
            setTimeout(requestKf, 500),
            setTimeout(requestKf, 1500),
            setTimeout(requestKf, 3000),
        ];
        // Periodic keyframe nudge every 5s while the pipeline is alive.
        pipeline.kfInterval = setInterval(requestKf, 5000);

        const session = liveBroadcastSessions.get(roomId);
        if (session) {
            session.status = 'live';
            session.streamStartedAt = new Date().toISOString();
        }

        log.info(`[live-hls ${roomId}] pipeline started -> ${hlsDir}`);
        return pipeline;
    } catch (err) {
        log.error(`[live-hls ${roomId}] start failed:`, err);
        try { if (ffmpeg) ffmpeg.kill('SIGKILL'); } catch (_) {}
        try { if (videoConsumer) videoConsumer.close(); } catch (_) {}
        try { if (audioConsumer) audioConsumer.close(); } catch (_) {}
        try { if (videoTransport) videoTransport.close(); } catch (_) {}
        try { if (audioTransport) audioTransport.close(); } catch (_) {}
        freeLiveRtpPort(videoPort);
        freeLiveRtpPort(audioPort);
        liveHlsPipelines.delete(roomId);
        throw err;
    }
}

async function stopLiveHlsForRoom(roomId) {
    const p = liveHlsPipelines.get(roomId);
    if (!p || p.starting === true) return;
    if (p.stopping) return;
    p.stopping = true;

    if (Array.isArray(p.kfTimers)) p.kfTimers.forEach((t) => clearTimeout(t));
    if (p.kfInterval) clearInterval(p.kfInterval);

    // FFmpeg'e once SIGINT gonderip dogal kapanmasini bekleriz; bu sayede
    // index.m3u8'in son hali (tum segmentler dahil) diske flush edilir.
    // VOD finalize bu son playlist'in uzerinden yapilir.
    if (p.ffmpeg && p.ffmpeg.exitCode === null && !p.ffmpeg.killed) {
        try { p.ffmpeg.kill('SIGINT'); } catch (_) {}
        await new Promise((resolve) => {
            const killTimer = setTimeout(() => {
                try { if (p.ffmpeg.exitCode === null) p.ffmpeg.kill('SIGKILL'); } catch (_) {}
            }, 3000);
            const doneTimer = setTimeout(() => resolve(), 5000); // ust sinir
            p.ffmpeg.once('close', () => {
                clearTimeout(killTimer);
                clearTimeout(doneTimer);
                resolve();
            });
        });
    }

    try { if (p.videoConsumer && !p.videoConsumer.closed) p.videoConsumer.close(); } catch (_) {}
    try { if (p.audioConsumer && !p.audioConsumer.closed) p.audioConsumer.close(); } catch (_) {}
    try { if (p.videoTransport && !p.videoTransport.closed) p.videoTransport.close(); } catch (_) {}
    try { if (p.audioTransport && !p.audioTransport.closed) p.audioTransport.close(); } catch (_) {}
    freeLiveRtpPort(p.videoPort);
    freeLiveRtpPort(p.audioPort);

    // ---- VOD finalize (replay) ----
    // Yayin bittikten sonra ayni playback URL'i VOD olarak servis edebilmek
    // icin playlist'i ENDLIST ile kapatip Spaces'e son halini yazariz.
    let vodFinalized = false;
    if (LIVE_HLS_VOD_ENABLED && p.hlsDir) {
        try {
            const finalized = await finalizeVodPlaylist(roomId, p.hlsDir);
            if (finalized) {
                vodFinalized = true;
                // fs.watch debounce penceresi (150ms) gecsin ki uploader
                // finalize edilmis index.m3u8'i Spaces'e PUT'lasin; sonra
                // uploader.stop() in-flight PUT'i drenaj eder.
                await new Promise((r) => setTimeout(r, 300));
            }
        } catch (e) {
            log.error(`[live-hls ${roomId}] vod finalize failed: ${e.message}`);
        }
    }

    // Spaces uploader'i durdur (in-flight PUT'lari drenaj eder). VOD modunda
    // ASLA deleteRemote cagirmiyoruz; aksi halde replay icin gereken
    // segmentler silinir. Live-only modda eski davranis korunuyor.
    if (p.uploader) {
        const up = p.uploader;
        Promise.resolve()
            .then(() => up.stop())
            .then(() => {
                if (vodFinalized) return; // VOD: segmentleri Spaces'te birak
                if (SPACES_HLS_RETENTION_SEC <= 0) return up.deleteRemote();
                setTimeout(() => {
                    up.deleteRemote().catch(() => {});
                }, SPACES_HLS_RETENTION_SEC * 1000).unref();
            })
            .catch((e) => log.error(`[live-hls ${roomId}] uploader teardown: ${e.message}`));
    }

    liveHlsPipelines.delete(roomId);

    const session = liveBroadcastSessions.get(roomId);
    if (session) {
        session.status = vodFinalized ? 'vod' : 'ended';
        session.streamEndedAt = new Date().toISOString();
        if (vodFinalized) {
            session.replayReady = true;
            session.replayReadyAt = session.streamEndedAt;
            // replayUrl == hlsUrl (ayni index.m3u8); player ENDLIST gorunce VOD oynatir.
            session.replayUrl = session.hlsUrl;
        }
    }

    if (p.hlsDir) {
        // VOD: lokali daha uzun tut (CDN cold edge backfill marji). Live-only:
        // 60 sn yeterli, segmentler zaten silinmis vaziyette.
        const localTtlMs = vodFinalized
            ? LIVE_HLS_VOD_LOCAL_CLEANUP_SEC * 1000
            : 60 * 1000;
        const cleanupTimer = setTimeout(() => {
            liveHlsCleanupTimers.delete(roomId);
            fs.rm(p.hlsDir, { recursive: true, force: true }, () => {});
        }, localTtlMs);
        if (cleanupTimer.unref) cleanupTimer.unref();
        liveHlsCleanupTimers.set(roomId, cleanupTimer);
    }
    log.info(`[live-hls ${roomId}] pipeline stopped${vodFinalized ? ' (vod ready)' : ''}`);
}

function maybeStartLiveHlsForRoom(roomId) {
    if (!roomId) return;
    if (!hasMediasoupRoom(roomId)) return;
    if (!liveBroadcastSessions.has(roomId)) {
        log.info(`[live-hls ${roomId}] skip auto-start: no session registered yet (sessions=${liveBroadcastSessions.size})`);
        return;
    }
    if (liveHlsPipelines.has(roomId)) return;
    const st = liveHlsRestartState.get(roomId);
    if (st && st.nextAllowedAt && Date.now() < st.nextAllowedAt) {
        return; // silent skip during backoff
    }
    log.info(`[live-hls ${roomId}] auto-start triggered`);
    startLiveHlsForRoom(roomId).catch((e) =>
        log.error(`[live-hls ${roomId}] auto-start failed:`, e.message),
    );
}

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

function ensureDirectory(dirPath) {
  return fs.promises.mkdir(dirPath, { recursive: true });
}

function createTempDirectory(prefix) {
  const dirPath = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return ensureDirectory(dirPath).then(() => dirPath);
}

function downloadFile(url, destinationPath) {
  return new Promise((resolve, reject) => {
    const nodeHttps = require('https');
    const requestClient = url.startsWith('https') ? nodeHttps : http;
    
    const fileStream = fs.createWriteStream(destinationPath);

    const request = requestClient.get(url, (response) => {
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



const options = {
    cert: fs.existsSync(path.join(__dirname, '../ssl/cert.pem')) 
        ? fs.readFileSync(path.join(__dirname, '../ssl/cert.pem'), 'utf-8')
        : fs.readFileSync(path.join(__dirname, config.server.ssl.cert), 'utf-8'),
    key: fs.existsSync(path.join(__dirname, '../ssl/key.pem'))
        ? fs.readFileSync(path.join(__dirname, '../ssl/key.pem'), 'utf-8')
        : fs.readFileSync(path.join(__dirname, config.server.ssl.key), 'utf-8'),
};

const corsOptions = {
    origin: config.server?.cors?.origin || '*',
    methods: config.server?.cors?.methods || ['GET', 'POST'],
};

const httpsServer = https.createServer(options, app);
const io = require('socket.io')(httpsServer, {
    maxHttpBufferSize: 1e7,
    transports: ['websocket', 'polling'], // Allow polling fallback for mobile
    cors: corsOptions,
    pingTimeout: 60000, // 60 seconds before considering connection dead
    pingInterval: 25000, // Send ping every 25 seconds to keep connection alive
    connectTimeout: 45000, // 45 seconds to establish connection
});

// Initialize Conference Namespace (for Admin and Mobile App compatibility)
// We capture the module handle (not just the init function) so we can read
// its `rooms` map and register a producer-added hook. The broadcaster flow
// goes through ConferenceSocket, while live HLS pipeline state lives here
// in Server.js — the hook bridges the two.
const conferenceSocketMod = require('./ConferenceSocket');
conferenceSocketMod(io).catch(err => console.error('Failed to init conference socket:', err));
conferenceSocketMod.setOnProducerAddedHook((roomId) => {
    try {
        maybeStartLiveHlsForRoom(roomId);
    } catch (e) {
        log.error('[live-hls] hook maybeStartLiveHlsForRoom failed:', e && e.message);
    }
});


const host = 'https://' + 'localhost' + ':' + config.server.listen.port; // config.server.listen.ip

const jwtCfg = {
    JWT_KEY: (config.jwt && config.jwt.key) || 'saigmvideochatsfu_jwt_secret',
    JWT_EXP: (config.jwt && config.jwt.exp) || '1h',
};

const hostCfg = {
    protected: config.host.protected,
    user_auth: config.host.user_auth,
    users_from_db: config.host.users_from_db,
    users_api_endpoint: config.host.users_api_endpoint,
    users_api_secret_key: config.host.users_api_secret_key,
    users: config.host.users,
    authenticated: !config.host.protected,
};

const restApi = {
    basePath: '/api/v1', // API uç noktası yolu
    docs: host + '/api/v1/docs', // api belgeleri
    allowed: config.api?.allowed,
};

// Sentry izleme
const sentryEnabled = config.sentry.enabled;
const sentryDSN = config.sentry.DSN;
const sentryTracesSampleRate = config.sentry.tracesSampleRate;
if (sentryEnabled) {
    Sentry.init({
        dsn: sentryDSN,
        integrations: [
            new CaptureConsole({
                // ['log', 'info', 'warn', 'error', 'debug', 'assert']
                levels: ['error'],
            }),
        ],
        tracesSampleRate: sentryTracesSampleRate,
    });
    /*
    log.log('test-log');
    log.info('test-info');
    log.warn('test-warning');
    log.error('test-error');
    log.debug('test-debug');
    */
}

// İstatistikler
const defaultStats = {
    enabled: true,
    src: 'https://stats.alchemy.com.tr/script.js',
    id: '41d26670-f275-45bb-af82-3ce91fe57756',
};

// OpenAI/ChatGPT
let chatGPT;
if (config.chatGPT.enabled) {
    if (config.chatGPT.apiKey) {
        const { OpenAI } = require('openai');
        const configuration = {
            basePath: config.chatGPT.basePath,
            apiKey: config.chatGPT.apiKey,
        };
        chatGPT = new OpenAI(configuration);
    } else {
        log.warning('ChatGPT etkin görünüyor, ancak apiKey eksik!');
    }
}

// OpenID Bağlantısı
const OIDC = config.oidc ? config.oidc : { enabled: false };

// dizin
const dir = {
    public: path.join(__dirname, '../', 'public'),
    rec: path.join(__dirname, '../', config?.server?.recording?.dir ? config.server.recording.dir + '/' : 'rec/'),
};

// rec dizini oluştur
const serverRecordingEnabled = config?.server?.recording?.enabled;
if (serverRecordingEnabled) {
    if (!fs.existsSync(dir.rec)) {
        fs.mkdirSync(dir.rec, { recursive: true });
    }
}

// HTML görünümleri
const views = {
    about: path.join(__dirname, '../', 'public/views/about.html'),
    landing: path.join(__dirname, '../', 'public/views/landing.html'),
    login: path.join(__dirname, '../', 'public/views/login.html'),
    newRoom: path.join(__dirname, '../', 'public/views/newroom.html'),
    notFound: path.join(__dirname, '../', 'public/views/404.html'),
    permission: path.join(__dirname, '../', 'public/views/permission.html'),
    privacy: path.join(__dirname, '../', 'public/views/privacy.html'),
    room: path.join(__dirname, '../', 'public/views/Room.html'),
};

const authHost = new Host(); // Giriş yaparak doğrulanmış IP

const roomList = new Map(); // Bütün Odalar

const presenters = {}; // sunum yapan kişilerin grp'sini oda kimliğine göre toplayın

const webRtcServerActive = config.mediasoup.webRtcServerActive;

// ip (sunucu yerel IPv4)
const IPv4 = webRtcServerActive
    ? config.mediasoup.webRtcServerOptions.listenInfos[0].ip
    : config.mediasoup.webRtcTransport.listenInfos[0].ip;

// announcedAddress (sunucu genel IPv4)
let announcedAddress = webRtcServerActive
    ? config.mediasoup.webRtcServerOptions.listenInfos[0].announcedAddress
    : config.mediasoup.webRtcTransport.listenInfos[0].announcedAddress;

// Tüm mediasoup çalışanları
const workers = [];
let nextMediasoupWorkerIdx = 0;

// Otomatik algılama announcedAddress (https://www.ipify.org)
if (!announcedAddress && IPv4 === '0.0.0.0') {
    http.get(
        {
            host: 'api.ipify.org',
            port: 80,
            path: '/',
        },
        (resp) => {
            resp.on('data', (ip) => {
                announcedAddress = ip.toString();
                if (webRtcServerActive) {
                    config.mediasoup.webRtcServerOptions.listenInfos.forEach((info) => {
                        info.announcedAddress = announcedAddress;
                    });
                } else {
                    config.mediasoup.webRtcTransport.listenInfos.forEach((info) => {
                        info.announcedAddress = announcedAddress;
                    });
                }
                startServer();
            });
        },
    );
} else {
    startServer();
}

// OIDC kimlik doğrulaması için özel middleware işlevi
function OIDCAuth(req, res, next) {
    if (OIDC.enabled) {
        // requireAuth() middleware'i koşullu olarak uygulayın
        requiresAuth()(req, res, function () {
            log.debug('[OIDC] ------> requiresAuth');
            // Kullanıcının kimliğinin doğrulanıp doğrulanmadığını kontrol edin
            if (req.oidc.isAuthenticated()) {
                log.debug('[OIDC] ------> Kullanıcı isAuthenticated');
                // Kullanıcının kimliği doğrulandı
                if (hostCfg.protected) {
                    const ip = authHost.getIP(req);
                    hostCfg.authenticated = true;
                    authHost.setAuthorizedIP(ip, true);
                    // Kontrol...
                    log.debug('[OIDC] ------> Ana bilgisayar korumalı', {
                        authenticated: hostCfg.authenticated,
                        authorizedIPs: authHost.getAuthorizedIPs(),
                        activeRoom: authHost.isRoomActive(),
                    });
                }
                next();
            } else {
                // Kullanıcının kimliği doğrulanmadı
                res.status(401).send('unauthorized');
            }
        });
    } else {
        next();
    }
}

function sanitizeMediaUrl(url) {
    if (typeof url !== 'string') {
        return url;
    }
    let result = url.trim();
    if (result) {
        result = result.replace(/^`+/, '').replace(/`+$/, '');
    }
    return result;
}

function startServer() {
    // uygulamayı başlat
    app.use(cors(corsOptions));
    app.use(compression());
    app.use(express.json());
    app.use(express.static(dir.public));
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(restApi.basePath + '/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument)); // api belgeleri

    // IP Beyaz Listesi kontrolü...
    app.use(restrictAccessByIP);

    // İstekleri günlüğe kaydet
    app.use((req, res, next) => {
        log.debug('Yeni istek:', {
            // headers: req.headers,
            body: req.body,
            method: req.method,
            path: req.originalUrl,
        });
        next();
    });

    // Health Check
    app.get('/health', (req, res) => res.status(200).send('Media Server OK'));

    // HLS Conversion Route
    app.post('/hls/from-url', async (req, res) => {
      const raw = (req.body && req.body.url) || null;
      const url = sanitizeMediaUrl(raw);
      const channelId = req.body && req.body.channelId;
      const messageId = req.body && req.body.messageId;

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

    // POST buradan başlıyor...
    app.post('*', function (next) {
        next();
    });

    // GET buradan başlıyor...
    app.get('*', function (next) {
        next();
    });

    // URL'deki kötü istekleri işlemek için sondaki eğik çizgileri kaldırın
    app.use((err, req, res, next) => {
        if (err instanceof SyntaxError || err.status === 400 || 'body' in err) {
            log.error('Talep Hatası', {
                header: req.headers,
                body: req.body,
                error: err.message,
            });
            return res.status(400).send({ status: 404, message: err.message }); // Geçersiz istek
        }
        if (req.path.substr(-1) === '/' && req.path.length > 1) {
            let query = req.url.slice(req.path.length);
            res.redirect(301, req.path.slice(0, -1) + query);
        } else {
            next();
        }
    });

    // Sağlık kontrolü
    app.get('/health', (req, res) => {
        res.status(200).send('OK');
    });

    // OpenID Bağlantısı
    if (OIDC.enabled) {
        try {
            app.use(auth(OIDC.config));
        } catch (err) {
            log.error(err);
            process.exit(1);
        }
    }

    // Kullanıcı bilgilerini görüntüleme rotası
    app.get('/profile', OIDCAuth, (req, res) => {
        if (OIDC.enabled) {
            return res.json(req.oidc.user); // Kullanıcı bilgilerini JSON olarak gönder
        }
        res.sendFile(views.notFound);
    });

    // Kimlik Doğrulama Geri Arama Rotası
    app.get('/auth/callback', (req, res, next) => {
        next(); // Express-openid-connect'in bu rotayı yönetmesine izin ver
    });

    // Çıkış Rotası
    app.get('/logout', (req, res) => {
        if (OIDC.enabled) {
            //
            if (hostCfg.protected) {
                const ip = authHost.getIP(req);
                if (authHost.isAuthorizedIP(ip)) {
                    authHost.deleteIP(ip);
                }
                hostCfg.authenticated = false;
                //
                log.debug('[OIDC] ------> Logout', {
                    authenticated: hostCfg.authenticated,
                    authorizedIPs: authHost.getAuthorizedIPs(),
                    activeRoom: authHost.isRoomActive(),
                });
            }
            req.logout(); // Kullanıcı oturumunu kapat
        }
        res.redirect('/'); // Çıkış yaptıktan sonra ana sayfaya yönlendir
    });

    // Kullanıcı arayüzü butonlarının yapılandırması
    app.get('/config', (req, res) => {
        res.status(200).json({ message: config.ui ? config.ui.buttons : false });
    });

    // Marka yapılandırması
    app.get('/brand', (req, res) => {
        res.status(200).json({ message: config.ui ? config.ui.brand : false });
    });

    // ana sayfa
    app.get(['/'], OIDCAuth, (req, res) => {
        //log.debug('/ - hostCfg ----->', hostCfg);
        if ((!OIDC.enabled && hostCfg.protected && !hostCfg.authenticated) || authHost.isRoomActive()) {
            const ip = getIP(req);
            if (allowedIP(ip)) {
                res.sendFile(views.landing);
                hostCfg.authenticated = true;
            } else {
                hostCfg.authenticated = false;
                res.sendFile(views.login);
            }
        } else {
            res.sendFile(views.landing);
        }
    });

    // yeni oda adı belirleyin ve katılın
    app.get(['/newroom'], OIDCAuth, (req, res) => {
        //log.info('/newroom - hostCfg ----->', hostCfg);

        if ((!OIDC.enabled && hostCfg.protected && !hostCfg.authenticated) || authHost.isRoomActive()) {
            const ip = getIP(req);
            if (allowedIP(ip)) {
                res.sendFile(views.newRoom);
                hostCfg.authenticated = true;
            } else {
                hostCfg.authenticated = false;
                res.sendFile(views.login);
            }
        } else {
            res.sendFile(views.newRoom);
        }
    });

    // Parametre'lerle doğrudan katılma odasını yönetin
    app.get('/join/', async (req, res) => {
        if (Object.keys(req.query).length > 0) {
            //log.debug('/join/params - hostCfg ----->', hostCfg);

            log.debug('Doğrudan Katılma', req.query);

            // http://localhost:3010/join?room=test&roomPassword=0&name=saigmvideochatsfu&audio=1&video=1&screen=0&hide=0&notify=1
            // http://localhost:3010/join?room=test&roomPassword=0&name=saigmvideochatsfu&audio=1&video=1&screen=0&hide=0&notify=0&token=token

            const { room, roomPassword, name, audio, video, screen, hide, notify, token, isPresenter } = checkXSS(
                req.query,
            );

            let peerUsername = '';
            let peerPassword = '';
            let isPeerValid = false;
            let isPeerPresenter = false;

            if (token) {
                try {
                    const validToken = await isValidToken(token);

                    if (!validToken) {
                        return res.status(401).json({ message: 'Geçersiz Jeton' });
                    }

                    const { username, password, presenter } = checkXSS(decodeToken(token));

                    peerUsername = username;
                    peerPassword = password;
                    isPeerValid = await isAuthPeer(username, password);
                    isPeerPresenter = presenter === '1' || presenter === 'true';

                    if (isPeerPresenter) {
                        const roomAllowedForUser = isRoomAllowedForUser('Token ile Doğrudan Katılma', username, room);
                        if (!roomAllowedForUser) {
                            return res.status(401).json({ message: 'Bu Kullanıcının Doğrudan Odaya Katılma Yetkisi Yok' });
                        }
                    }
                } catch (err) {
                    log.error('Doğrudan Katılma JWT hatası', { error: err.message, token: token });
                    return hostCfg.protected || hostCfg.user_auth
                        ? res.sendFile(views.login)
                        : res.sendFile(views.landing);
                }
            } else {
                const allowRoomAccess = isAllowedRoomAccess('/join/params', req, hostCfg, authHost, roomList, room);
                const roomAllowedForUser = isRoomAllowedForUser('Token ile Doğrudan Katılma', name, room);
                if (!allowRoomAccess && !roomAllowedForUser) {
                    return res.status(401).json({ message: 'Doğrudan Odaya Yetkisiz Katılma' });
                }
            }

            const OIDCUserAuthenticated = OIDC.enabled && req.oidc.isAuthenticated();

            if (
                (hostCfg.protected && isPeerValid && isPeerPresenter && !hostCfg.authenticated) ||
                OIDCUserAuthenticated
            ) {
                const ip = getIP(req);
                hostCfg.authenticated = true;
                authHost.setAuthorizedIP(ip, true);
                log.debug('Ana makine olarak doğrudan katılma kullanıcı kimlik doğrulaması tamamlandı', {
                    ip: ip,
                    username: peerUsername,
                    password: peerPassword,
                });
            }

            if (room && (hostCfg.authenticated || isPeerValid)) {
                return res.sendFile(views.room);
            } else {
                return res.sendFile(views.login);
            }
        }
    });

    // odaya kimliğe göre katıl
    app.get('/join/:roomId', (req, res) => {
        //
        const allowRoomAccess = isAllowedRoomAccess(
            '/join/:roomId',
            req,
            hostCfg,
            authHost,
            roomList,
            req.params.roomId,
        );

        if (allowRoomAccess) {
            if (hostCfg.protected) authHost.setRoomActive();

            res.sendFile(views.room);
        } else {
            if (!OIDC.enabled && hostCfg.protected) {
                return res.sendFile(views.login);
            }
            res.redirect('/');
        }
    });

    // oda kimliği doğru belirtilmemiş
    app.get('/join/*', (req, res) => {
        res.redirect('/');
    });

    // video'ya/ses'e izin verilmiyorsa
    app.get(['/permission'], (req, res) => {
        res.sendFile(views.permission);
    });

    // Gizlilik Politikası
    app.get(['/privacy'], (req, res) => {
        res.sendFile(views.privacy);
    });

    // SAI-GM Video Chat hakkında
    app.get(['/about'], (req, res) => {
        res.sendFile(views.about);
    });

    // İstatistik uç noktasını al
    app.get(['/stats'], (req, res) => {
        const stats = config.stats ? config.stats : defaultStats;
        // log.debug('İstatistik gönder', stats);
        res.send(stats);
    });

    // user_auth etkinse oturum açma işlemini gerçekleştirin
    app.get(['/login'], (req, res) => {
        res.sendFile(views.login);
    });

    // korumalı ana bilgisayarda oturum açmışları yönet
    app.get(['/logged'], (req, res) => {
        const ip = getIP(req);
        if (allowedIP(ip)) {ß
            res.sendFile(views.landing);
            hostCfg.authenticated = true;
        } else {
            hostCfg.authenticated = false;
            res.sendFile(views.login);
        }
    });

    // ####################################################
    // EKSENLER
    // ####################################################

    // korumalı ana bilgisayarda oturum açmayı yönet
    app.post(['/login'], async (req, res) => {
        const ip = getIP(req);
        log.debug(`Şurada barındırılmak için oturum açma isteğinde bulun: ${ip}`, req.body);

        const { username, password } = checkXSS(req.body);

        const isPeerValid = await isAuthPeer(username, password);

        if (hostCfg.protected && isPeerValid && !hostCfg.authenticated) {
            const ip = getIP(req);
            hostCfg.authenticated = true;
            authHost.setAuthorizedIP(ip, true);
            log.debug('ANA BİLGİSAYAR GİRİŞİ TAMAM', {
                ip: ip,
                authorized: authHost.isAuthorizedIP(ip),
                authorizedIps: authHost.getAuthorizedIPs(),
            });

            const isPresenter =
                config.presenters && config.presenters.join_first
                    ? true
                    : config.presenters &&
                      config.presenters.list &&
                      config.presenters.list.includes(username).toString();

            const token = encodeToken({ username: username, password: password, presenter: isPresenter });
            return res.status(200).json({ message: token });
        }

        if (isPeerValid) {
            log.debug('KATILIMCI GİRİŞİ TAMAM', { ip: ip, authorized: true });
            const isPresenter =
                config.presenters && config.presenters.list && config.presenters.list.includes(username).toString();
            const token = encodeToken({ username: username, password: password, presenter: isPresenter });
            return res.status(200).json({ message: token });
        } else {
            return res.status(401).json({ message: 'unauthorized' });
        }
    });

    // ####################################################
    // SUNUCU DİZİNİNE KAYIT ETMEYE DEVAM EDİN
    // ####################################################

    app.post(['/recSync'], (req, res) => {
        // Kaydı saklayın...
        if (serverRecordingEnabled) {
            //
            const { fileName } = req.query;

            if (!fileName) {
                return res.status(400).send('Dosya adı belirtilmedi');
            }

            try {
                if (!fs.existsSync(dir.rec)) {
                    fs.mkdirSync(dir.rec, { recursive: true });
                }
                const filePath = dir.rec + fileName;
                const writeStream = fs.createWriteStream(filePath, { flags: 'a' });

                req.pipe(writeStream);

                writeStream.on('error', (err) => {
                    log.error('Dosyaya yazma hatası:', err.message);
                    res.status(500).send('İç Sunucu Hatası');
                });

                writeStream.on('finish', () => {
                    log.debug('Dosya başarıyla kaydedildi:', fileName);
                    res.status(200).send('Dosya başarıyla kaydedildi');
                });
            } catch (err) {
                log.error('Yükleme işlenirken hata oluştu', err.message);
                res.status(500).send('İç Sunucu Hatası');
            }
        }
    });

    // ####################################################
    // REST API
    // ####################################################

    // toplantı listesi talep et
    app.get([restApi.basePath + '/meetings'], (req, res) => {
        // Uç noktaya izin verilip verilmediğini kontrol edin
        if (restApi.allowed && !restApi.allowed.meetings) {
            return res.status(403).json({
                error: 'Bu uç nokta devre dışı bırakıldı. Daha fazla bilgi için lütfen yöneticiyle iletişime geçin.',
            });
        }
        // check if user was authorized for the api call
        const { host, authorization } = req.headers;
        const api = new ServerApi(host, authorization);
        if (!api.isAuthorized()) {
            log.debug('SAI-GM Video Chat toplantıları getir - Yetkisiz', {
                header: req.headers,
                body: req.body,
            });
            return res.status(403).json({ error: 'unauthorized!' });
        }
        // Toplantıları getir
        const meetings = api.getMeetings(roomList);
        res.json({ meetings: meetings });
        // her şey tamamlandıysa çıktıyı log.debug yapın
        log.debug('SAI-GM Video Chat toplantıları getir - Yetkili', {
            header: req.headers,
            body: req.body,
            meetings: meetings,
        });
    });

    // toplantı odası uç noktası iste
    app.post([restApi.basePath + '/meeting'], (req, res) => {
        // Uç noktaya izin verilip verilmediğini kontrol edin
        if (restApi.allowed && !restApi.allowed.meeting) {
            return res.status(403).json({
                error: 'Bu uç nokta devre dışı bırakıldı. Daha fazla bilgi için lütfen yöneticiyle iletişime geçin.',
            });
        }
        // kullanıcının API çağrısı için yetkili olup olmadığını kontrol edin
        const { host, authorization } = req.headers;
        const api = new ServerApi(host, authorization);
        if (!api.isAuthorized()) {
            log.debug('SAI-GM Video Chat toplantıları getir - Yetkisiz', {
                header: req.headers,
                body: req.body,
            });
            return res.status(403).json({ error: 'unauthorized!' });
        }
        // toplantı URL'ini ayarla
        const meetingURL = api.getMeetingURL();
        res.json({ meeting: meetingURL });
        // her şey tamamlandıysa çıktıyı log.debug yapın
        log.debug('SAI-GM Video Chat toplantıları getir - Yetkili', {
            header: req.headers,
            body: req.body,
            meeting: meetingURL,
        });
    });

    // oda uç noktasına katılma isteği
    app.post([restApi.basePath + '/join'], (req, res) => {
        // Uç noktaya izin verilip verilmediğini kontrol edin
        if (restApi.allowed && !restApi.allowed.join) {
            return res.status(403).json({
                error: 'Bu uç nokta devre dışı bırakıldı. Daha fazla bilgi için lütfen yöneticiyle iletişime geçin.',
            });
        }
        // kullanıcının API çağrısı için yetkili olup olmadığını kontrol edin
        const { host, authorization } = req.headers;
        const api = new ServerApi(host, authorization);
        if (!api.isAuthorized()) {
            log.debug('SAI-GM Video Chat katıl - Yetkisiz', {
                header: req.headers,
                body: req.body,
            });
            return res.status(403).json({ error: 'unauthorized!' });
        }
        // Kurulum URL'i
        const joinURL = api.getJoinURL(req.body);
        res.json({ join: joinURL });
        // her şey tamamlandıysa çıktıyı log.debug yapın
        log.debug('SAI-GM Video Chat katıl - Yetkili', {
            header: req.headers,
            body: req.body,
            join: joinURL,
        });
    });

    // uç noktadan token isteği
    app.post([restApi.basePath + '/token'], (req, res) => {
        // Uç noktaya izin verilip verilmediğini kontrol edin
        if (restApi.allowed && !restApi.allowed.token) {
            return res.status(403).json({
                error: 'Bu uç nokta devre dışı bırakıldı. Daha fazla bilgi için lütfen yöneticiyle iletişime geçin.',
            });
        }
        // kullanıcının API çağrısı için yetkili olup olmadığını kontrol edin
        const { host, authorization } = req.headers;
        const api = new ServerApi(host, authorization);
        if (!api.isAuthorized()) {
            log.debug('SAI-GM Video Chat Token Al - Yetkisiz', {
                header: req.headers,
                body: req.body,
            });
            return res.status(403).json({ error: 'unauthorized!' });
        }
        // Token Al
        const token = api.getToken(req.body);
        res.json({ token: token });
        // her şey tamamlandıysa çıktıyı log.debug yapın
        log.debug('SAI-GM Video Chat Token Al - Yetkili', {
            header: req.headers,
            body: req.body,
            token: token,
        });
    });

    // ####################################################
    // SLACK API
    // ####################################################

    app.post('/slack', (req, res) => {
        if (!slackEnabled) return res.end('`Bakım yapılıyor` - Lütfen kısa süre sonra tekrar kontrol edin.');

        if (restApi.allowed && !restApi.allowed.slack) {
            return res.end(
                '`Bu uç nokta devre dışı bırakıldı. Daha fazla bilgi için lütfen yöneticiyle iletişime geçin.',
            );
        }

        log.debug('Slack', req.headers);

        if (!slackSigningSecret) return res.end('`Slack İmzalama Gizi boş!`');

        const slackSignature = req.headers['x-slack-signature'];
        const requestBody = qS.stringify(req.body, { format: 'RFC1738' });
        const timeStamp = req.headers['x-slack-request-timestamp'];
        const time = Math.floor(new Date().getTime() / 1000);

        if (Math.abs(time - timeStamp) > 300) return res.end('`Yanlış zaman damgası` - Bu isteği dikkate almayın.');

        const sigBaseString = 'v0:' + timeStamp + ':' + requestBody;
        const mySignature = 'v0=' + CryptoJS.HmacSHA256(sigBaseString, slackSigningSecret);

        if (mySignature == slackSignature) {
            const host = req.headers.host;
            const api = new ServerApi(host);
            const meetingURL = api.getMeetingURL();
            log.debug('Slack', { meeting: meetingURL });
            return res.end(meetingURL);
        }
        return res.end('`Yanlış imza` - Doğrulama başarısız oldu!');
    });

    // ====================================================
    // LIVE HLS BROADCAST ROUTES (must be registered BEFORE
    // the catch-all `app.get('*')` so requests to
    // `/live/<roomId>/...` and `/live-broadcast/*` are
    // handled here instead of falling through to 404.html.
    // ====================================================

    // Serve generated HLS segments + playlists from disk.
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
        }),
    );

    // Register a broadcast session for a given roomId. Backend (PocketBase
    // or Express app on :3000) calls this when the user creates a live
    // broadcast. Once the broadcaster joins the mediasoup room and produces
    // video, the HLS pipeline auto-starts.
    app.post('/live-broadcast/session', async (req, res) => {
        const { roomId, title, channelId, startTime, scheduledEndTime } = req.body || {};
        const normalizedRoomId = String(roomId || '').trim() || `broadcast-${Date.now()}`;
        const sessionId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Prefer Spaces CDN when configured; falls back to droplet-served URL otherwise.
        const playbackBase = SPACES_PUBLIC_BASE_URL
            ? `${SPACES_PUBLIC_BASE_URL.replace(/\/$/, '')}/${SPACES_HLS_PREFIX}`
            : LIVE_HLS_BASE_URL.replace(/\/$/, '');
        const hlsUrl = `${playbackBase}/${encodeURIComponent(
            normalizedRoomId,
        )}/index.m3u8`;

        const session = {
            sessionId,
            roomId: normalizedRoomId,
            title: String(title || 'Canli Yayin'),
            channelId: channelId || null,
            startTime: startTime || new Date().toISOString(),
            scheduledEndTime: scheduledEndTime || null,
            hlsUrl,
            playbackUrl: hlsUrl,
            // Replay (VOD): yayin bittikten sonra ayni URL VOD olarak servis
            // eder (playlist'e EXT-X-ENDLIST eklenir). Client status='vod' ya
            // da replayReady=true gorunce "sonradan izle" akisina gecebilir.
            replayEnabled: LIVE_HLS_VOD_ENABLED,
            replayUrl: LIVE_HLS_VOD_ENABLED ? hlsUrl : null,
            replayReady: false,
            llhls: true,
            status: 'provisioned',
            createdAt: new Date().toISOString(),
        };

        liveBroadcastSessions.set(normalizedRoomId, session);

        const roomReady = hasMediasoupRoom(normalizedRoomId);
        log.info(
            `[live-broadcast/session] register roomId=${normalizedRoomId} ` +
                `roomReady=${roomReady} channelId=${channelId || '-'}`,
        );

        // If broadcaster already joined the mediasoup room before calling session, start now.
        if (roomReady) {
            startLiveHlsForRoom(normalizedRoomId).catch((e) =>
                log.error(`[live-hls ${normalizedRoomId}] start on session failed:`, e.message),
            );
        }

        // Defansif: client/backend POST'u yayıncının produce'undan ÖNCE gelirse
        // ya da producer hook kaçırılırsa, 30sn boyunca her saniye yeniden dene.
        if (!liveHlsPipelines.has(normalizedRoomId)) {
            let attempts = 0;
            const maxAttempts = 30;
            const watcher = setInterval(() => {
                attempts += 1;
                if (
                    liveHlsPipelines.has(normalizedRoomId) ||
                    !liveBroadcastSessions.has(normalizedRoomId)
                ) {
                    clearInterval(watcher);
                    return;
                }
                if (attempts >= maxAttempts) {
                    const room = resolveMediasoupRoom(normalizedRoomId);
                    log.warn(
                        `[live-hls ${normalizedRoomId}] watcher giving up after ${attempts}s ` +
                            `(roomReady=${!!room}, peers=${room && room.peers ? room.peers.size : 0})`,
                    );
                    clearInterval(watcher);
                    return;
                }
                if (hasMediasoupRoom(normalizedRoomId)) {
                    // Use maybeStartLiveHlsForRoom so the exponential-backoff
                    // state (liveHlsRestartState) is respected; otherwise a
                    // crashing ffmpeg would be relaunched every second.
                    try {
                        maybeStartLiveHlsForRoom(normalizedRoomId);
                    } catch (e) {
                        log.error(`[live-hls ${normalizedRoomId}] watcher start failed:`, e && e.message);
                    }
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

    // Debug: anlık canlı yayın durumu. İzleyici "hazırlanıyor"da kalıyorsa:
    //   - sessions boş → POST /live-broadcast/session media-server'a hiç ulaşmamış
    //   - session var, hasRoom=false → yayıncı henüz mediasoup'a bağlanmamış
    //   - hasRoom=true, hasPipeline=false → produce hook'u tetiklenmemiş
    //     ya da pickProducersForBroadcast video bulamamış
    app.get('/live-broadcast/debug', (req, res) => {
        const confRooms = (conferenceSocketMod && conferenceSocketMod.rooms) || new Map();
        const sessions = Array.from(liveBroadcastSessions.entries()).map(([rid, s]) => {
            const room = resolveMediasoupRoom(rid);
            return {
                roomId: rid,
                sessionId: s.sessionId,
                status: s.status,
                channelId: s.channelId,
                startTime: s.startTime,
                streamStartedAt: s.streamStartedAt || null,
                streamEndedAt: s.streamEndedAt || null,
                hasRoom: !!room,
                roomSource: roomList.has(rid) ? 'roomList' : confRooms.has(rid) ? 'conferenceSocket' : null,
                peerCount: room && room.peers ? room.peers.size : 0,
                hasPipeline: liveHlsPipelines.has(rid),
            };
        });
        const orphanRooms = [];
        for (const [rid, r] of confRooms.entries()) {
            if (!liveBroadcastSessions.has(rid)) {
                orphanRooms.push({ roomId: rid, source: 'conferenceSocket', peerCount: r.peers ? r.peers.size : 0 });
            }
        }
        for (const [rid, r] of roomList.entries()) {
            if (!liveBroadcastSessions.has(rid)) {
                orphanRooms.push({ roomId: rid, source: 'roomList', peerCount: r.peers ? r.peers.size : 0 });
            }
        }
        return res.json({
            now: new Date().toISOString(),
            sessionCount: liveBroadcastSessions.size,
            confRoomCount: confRooms.size,
            mainRoomCount: roomList.size,
            pipelineCount: liveHlsPipelines.size,
            sessions,
            pipelines: Array.from(liveHlsPipelines.keys()),
            orphanRooms,
        });
    });

    // daha önce hiçbir sayfayla eşleşmediğinden 404 bulunamadı
    app.get('*', function (req, res) {
        res.sendFile(views.notFound);
    });

    // ####################################################
    // SUNUCU YAPILANDIRMASI
    // ####################################################

    function getServerConfig(tunnel = false) {
        return {
            app_version: packageJson.version,
            node_version: process.versions.node,
            cors_options: corsOptions,
            middleware: config.middleware,
            server_listen: host,
            server_tunnel: tunnel,
            hostConfig: hostCfg,
            jwtCfg: jwtCfg,
            presenters: config.presenters,
            rest_api: restApi,
            mediasoup_worker_bin: mediasoup.workerBin,
            mediasoup_server_version: mediasoup.version,
            mediasoup_client_version: mediasoupClient.version,
            mediasoup_listenInfos: config.mediasoup.webRtcTransport.listenInfos,
            ip_lookup_enabled: config.IPLookup.enabled,
            sentry_enabled: sentryEnabled,
            redirect_enabled: config.redirect.enabled,
            slack_enabled: slackEnabled,
            stats_enabled: config.stats.enabled,
            chatGPT_enabled: config.chatGPT.enabled,
            configUI: config.ui,
            serverRec: config?.server?.recording,
            oidc: OIDC.enabled ? OIDC : false,
        };
    }

    // ####################################################
    // NGROK
    // ####################################################

    async function ngrokStart() {
        try {
            await ngrok.authtoken(config.ngrok.authToken);
            await ngrok.connect(config.server.listen.port);
            const api = ngrok.getApi();
            const list = await api.listTunnels();
            const tunnel = list.tunnels[0].public_url;
            log.info('Sunucu yapılandırması', getServerConfig(tunnel));
        } catch (err) {
            log.error('Ngrok Başlatma hatası: ', err.body);
            await ngrok.kill();
            process.exit(1);
        }
    }

    // ####################################################
    // SUNUCUYU BAŞLAT
    // ####################################################

    httpsServer.listen(config.server.listen.port, () => {
        log.log(
            `%c
    
        ███████╗██╗ ██████╗ ███╗   ██╗      ███████╗███████╗██████╗ ██╗   ██╗███████╗██████╗ 
        ██╔════╝██║██╔════╝ ████╗  ██║      ██╔════╝██╔════╝██╔══██╗██║   ██║██╔════╝██╔══██╗
        ███████╗██║██║  ███╗██╔██╗ ██║█████╗███████╗█████╗  ██████╔╝██║   ██║█████╗  ██████╔╝
        ╚════██║██║██║   ██║██║╚██╗██║╚════╝╚════██║██╔══╝  ██╔══██╗╚██╗ ██╔╝██╔══╝  ██╔══██╗
        ███████║██║╚██████╔╝██║ ╚████║      ███████║███████╗██║  ██║ ╚████╔╝ ███████╗██║  ██║
        ╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝      ╚══════╝╚══════╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝ started...
    
        `,
            'font-family:monospace',
        );

        if (config.ngrok.enabled && config.ngrok.authToken !== '') {
            return ngrokStart();
        }
        log.info('Sunucu yapılandırması', getServerConfig());
    });

    // ####################################################
    // İŞLEYİCİLER
    // ####################################################

    (async () => {
        try {
            await createWorkers();
        } catch (err) {
            log.error('İşleyici yaratma HATASI --->', err);
            process.exit(1);
        }
    })();

    async function createWorkers() {
        const { numWorkers } = config.mediasoup;

        const { logLevel, logTags, rtcMinPort, rtcMaxPort } = config.mediasoup.worker;

        log.info('İŞLEYİCİLER:', numWorkers);

        for (let i = 0; i < numWorkers; i++) {
            //
            const worker = await mediasoup.createWorker({
                logLevel: logLevel,
                logTags: logTags,
                rtcMinPort: rtcMinPort,
                rtcMaxPort: rtcMaxPort,
            });

            if (webRtcServerActive) {
                const webRtcServerOptions = clone(config.mediasoup.webRtcServerOptions);
                const portIncrement = i;

                for (const listenInfo of webRtcServerOptions.listenInfos) {
                    if (!listenInfo.portRange) {
                        listenInfo.port += portIncrement;
                    }
                }

                log.info('WebRtc Sunucusu Oluştur', {
                    worker_pid: worker.pid,
                    webRtcServerOptions: webRtcServerOptions,
                });

                const webRtcServer = await worker.createWebRtcServer(webRtcServerOptions);
                worker.appData.webRtcServer = webRtcServer;
            }

            worker.on('died', () => {
                log.error('Mediasoup işleyicisi 2 saniyede çıkarken öldü... [pid:%d]', worker.pid);
                setTimeout(() => process.exit(1), 2000);
            });

            workers.push(worker);

            /*
            setInterval(async () => {
                const usage = await worker.getResourceUsage();
                log.info('mediasoup işleyici kaynak kullanımı', { worker_pid: worker.pid, usage: usage });
                const dump = await worker.dump();
                log.info('mediasoup işleyici dökümü', { worker_pid: worker.pid, dump: dump });
            }, 120000);
            */
        }
    }

    async function getMediasoupWorker() {
        const worker = workers[nextMediasoupWorkerIdx];
        if (++nextMediasoupWorkerIdx === workers.length) nextMediasoupWorkerIdx = 0;
        return worker;
    }

    // ####################################################
    // SOCKET IO
    // ####################################################

    io.on('connection', (socket) => {
        socket.on('clientError', (error) => {
            try {
                log.error('İstemci hatası', error.message);
                socket.disconnect(true); // true zorunlu bir bağlantının kesildiğini gösterir
            } catch (error) {
                log.error('İstemci hatası işlenirken hata oluştu', error.message);
            }
        });

        socket.on('error', (error) => {
            try {
                log.error('Soket hatası', error.message);
                socket.disconnect(true); // true zorunlu bir bağlantının kesildiğini gösterir
            } catch (error) {
                log.error('Soket hatası işlenirken hata oluştu', error.message);
            }
        });

        socket.on('createRoom', async ({ room_id }, callback) => {
            socket.room_id = room_id;

            if (roomList.has(socket.room_id)) {
                callback({ error: 'zaten var' });
            } else {
                log.debug('Oda oluşturuldu', { room_id: socket.room_id });
                const worker = await getMediasoupWorker();
                roomList.set(socket.room_id, new Room(socket.room_id, worker, io));
                callback({ room_id: socket.room_id });
            }
        });

        socket.on('join', async (dataObject, cb) => {
            if (!roomList.has(socket.room_id)) {
                return cb({
                    error: 'Oda mevcut değil',
                });
            }

            // Katılımcı IPv4'ü alın (::1 Bu, ipv6'daki geridöngü adresidir, ipv4'teki 127.0.0.1'e eşittir)
            const peer_ip = getIpSocket(socket);

            // Katılımcı Coğrafi Konumu alın
            if (config.IPLookup.enabled && peer_ip != '::1') {
                dataObject.peer_geo = await getPeerGeoLocation(peer_ip);
            }

            const data = checkXSS(dataObject);

            log.info('Kullanıcı katıldı', data);

            const room = roomList.get(socket.room_id);

            const { peer_name, peer_id, peer_uuid, peer_token, os_name, os_version, browser_name, browser_version } =
                data.peer_info;

            let is_presenter = true;

            // Kullanıcı Kimlik Doğrulaması gerekli veya jeton tespit ediliyor, eşin geçerli olup olmadığını kontrol ediyoruz
            if (hostCfg.user_auth || peer_token) {
                // Kontrol JWT
                if (peer_token) {
                    try {
                        const validToken = await isValidToken(peer_token);

                        if (!validToken) {
                            return cb('unauthorized');
                        }

                        const { username, password, presenter } = checkXSS(decodeToken(peer_token));

                        const isPeerValid = await isAuthPeer(username, password);

                        if (!isPeerValid) {
                            // katılımcıları giriş sayfasına yönlendir
                            return cb('unauthorized');
                        }

                        is_presenter =
                            presenter === '1' ||
                            presenter === 'true' ||
                            (config.presenters.join_first && room.getPeers().size === 0);

                        log.debug('[Join] - ANA BİLGİSAYAR KORUMALI - KULLANICI YETKİSİNİ kontrol et', {
                            ip: peer_ip,
                            peer_username: username,
                            peer_password: password,
                            peer_valid: isPeerValid,
                            peer_presenter: is_presenter,
                        });
                    } catch (err) {
                        log.error('[Join] - JWT hatası', {
                            error: err.message,
                            token: peer_token,
                        });
                        return cb('unauthorized');
                    }
                } else {
                    return cb('unauthorized');
                }

                const roomAllowedForUser = isRoomAllowedForUser('[Join]', peer_name, room.id);
                if (!roomAllowedForUser) {
                    return cb('notAllowed');
                }
            }

            // check if banned...
            if (room.isBanned(peer_uuid)) {
                log.info('[Join] - peer is banned!', {
                    room_id: data.room_id,
                    peer: {
                        name: peer_name,
                        uuid: peer_uuid,
                        os_name: os_name,
                        os_version: os_version,
                        browser_name: browser_name,
                        browser_version: browser_version,
                    },
                });
                return cb('isBanned');
            }

            room.addPeer(new Peer(socket.id, data));

            const activeRooms = getActiveRooms();

            log.info('[Join] - mevcut aktif odalar', activeRooms);

            if (!(socket.room_id in presenters)) presenters[socket.room_id] = {};

            // Sunumcuları ayarla
            const presenter = {
                peer_ip: peer_ip,
                peer_name: peer_name,
                peer_uuid: peer_uuid,
                is_presenter: is_presenter,
            };
            // ilk önce kullanıcı adının sunum yapan kişinin kullanıcı adıyla eşleşip eşleşmediğini kontrol ederiz
            if (config.presenters && config.presenters.list && config.presenters.list.includes(peer_name)) {
                presenters[socket.room_id][socket.id] = presenter;
            } else {
                // sunum yapan kişinin kullanıcı adı eşleşmiyorsa odaya ilk katılan kişi sunum yapan kişidir
                if (Object.keys(presenters[socket.room_id]).length === 0) {
                    presenters[socket.room_id][socket.id] = presenter;
                }
            }

            log.info('[Join] - Bağlı sunucular, oda kimliğine göre grp', presenters);

            const isPresenter = peer_token
                ? is_presenter
                : await isPeerPresenter(socket.room_id, socket.id, peer_name, peer_uuid);

            const peer = room.getPeer(socket.id);

            peer.updatePeerInfo({ type: 'presenter', status: isPresenter });

            log.info('[Join] - Sunucu', {
                roomId: socket.room_id,
                peer_name: peer_name,
                peer_presenter: isPresenter,
            });

            if (room.isLocked() && !isPresenter) {
                log.debug('Kullanıcı, odanın kilitli olması ve sunum yapan kişi olmaması nedeniyle reddedildi');
                return cb('isLocked');
            }

            if (room.isLobbyEnabled() && !isPresenter) {
                log.debug(
                    'Lobi etkin olduğu ve sunucu olmadığı için kullanıcı şu anda odaya katılmayı bekliyor',
                );
                room.broadCast(socket.id, 'roomLobby', {
                    peer_id: peer_id,
                    peer_name: peer_name,
                    lobby_status: 'waiting',
                });
                return cb('isLobby');
            }

            if ((hostCfg.protected || hostCfg.user_auth) && isPresenter) {
                const roomAllowedForUser = isRoomAllowedForUser('[Join]', peer_name, room.id);
                if (!roomAllowedForUser) {
                    return cb('notAllowed');
                }
            }

            // SENARYO: İlk kullanıcı odaya katıldığında ve yardım beklediğinde bildirim alın...
            if (room.getPeersCount() === 1) {
                nodemailer.sendEmailAlert('join', {
                    room_id: room.id,
                    peer_name: peer_name,
                    domain: socket.handshake.headers.host.split(':')[0],
                    os: os_name ? `${os_name} ${os_version}` : '',
                    browser: browser_name ? `${browser_name} ${browser_version}` : '',
                }); // config.email.alert: true
            }

            cb(room.toJson());
        });

        socket.on('getRouterRtpCapabilities', (_, callback) => {
            if (!roomList.has(socket.room_id)) {
                return callback({ error: 'Oda bulunamadı' });
            }

            const room = roomList.get(socket.room_id);

            log.debug('Getir RouterRtpCapabilities', getPeerName(room));
            try {
                const getRouterRtpCapabilities = room.getRtpCapabilities();

                //log.debug('Getir RouterRtpCapabilities callback', { callback: getRouterRtpCapabilities });

                callback(getRouterRtpCapabilities);
            } catch (err) {
                log.error('Getir RouterRtpCapabilities error', err);
                callback({
                    error: err.message,
                });
            }
        });

        socket.on('createWebRtcTransport', async (_, callback) => {
            if (!roomList.has(socket.room_id)) {
                return callback({ error: 'Oda bulunamadı'});
            }

            const room = roomList.get(socket.room_id);

            log.debug('WebRtc aktarımı oluştur', getPeerName(room));

            try {
                const createWebRtcTransport = await room.createWebRtcTransport(socket.id);

                //log.debug('WebRtc aktarım geri araması oluştur', { callback: createWebRtcTransport });

                callback(createWebRtcTransport);
            } catch (err) {
                log.error('WebRtc Aktarımı hatası oluştur', err);
                callback({
                    error: err.message,
                });
            }
        });

        socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
            if (!roomList.has(socket.room_id)) {
                return callback({ error: 'Oda bulunamadı' });
            }

            const room = roomList.get(socket.room_id);

            const peer_name = getPeerName(room, false);

            log.debug('Aktarımı bağlayın', { peer_name: peer_name, transport_id: transport_id });

            try {
                const connectTransport = await room.connectPeerTransport(socket.id, transport_id, dtlsParameters);

                //log.debug('Aktarımı bağlayın', { callback: connectTransport });

                callback(connectTransport);
            } catch (err) {
                log.error('Aktarım bağlama hatası', err);
                callback({
                    error: err.message,
                });
            }
        });

        socket.on('restartIce', async ({ transport_id }, callback) => {
            if (!roomList.has(socket.room_id)) {
                return callback({ error: 'Oda bulunamadı' });
            }

            const room = roomList.get(socket.room_id);

            const peer = room.getPeer(socket.id);

            const peer_name = getPeerName(room, false);

            log.debug('ICE tekrar başlat', { peer_name: peer_name, transport_id: transport_id });

            try {
                const transport = peer.getTransport(transport_id);

                if (!transport) {
                    throw new Error(`ICE'yi yeniden başlatın, "${transport_id}" kimliğine sahip aktarım bulunamadı`);
                }

                const iceParameters = await transport.restartIce();

                log.debug('ICE geri aramasını yeniden başlat', { callback: iceParameters });

                callback(iceParameters);
            } catch (err) {
                log.error('ICE yeniden başlatma hatası', err);
                callback({
                    error: err.message,
                });
            }
        });

        socket.on('produce', async ({ producerTransportId, kind, appData, rtpParameters }, callback, errback) => {
            if (!roomList.has(socket.room_id)) {
                return callback({ error: 'Oda bulunamadı' });
            }

            const room = roomList.get(socket.room_id);

            const peer_name = getPeerName(room, false);

            // peer_info.audio VEYA video AÇIK
            const data = {
                room_id: room.id,
                peer_name: peer_name,
                peer_id: socket.id,
                kind: kind,
                type: appData.mediaType,
                status: true,
            };

            const peer = room.getPeer(socket.id);

            peer.updatePeerInfo(data);

            try {
                const producer_id = await room.produce(
                    socket.id,
                    producerTransportId,
                    rtpParameters,
                    kind,
                    appData.mediaType,
                );

                log.debug('Produce', {
                    kind: kind,
                    type: appData.mediaType,
                    peer_name: peer_name,
                    peer_id: socket.id,
                    producer_id: producer_id,
                });

                // üretici ses seviyesini ve aktif hoparlörü ekleyin ve izleyin
                if (kind === 'audio') {
                    room.addProducerToAudioLevelObserver({ producerId: producer_id });
                    room.addProducerToActiveSpeakerObserver({ producerId: producer_id });
                }

                //log.debug('Üretici aktarım geri araması', { callback: producer_id });

                callback({
                    producer_id,
                });

                // Auto-start the live HLS pipeline once the broadcaster
                // produces video for a room that has a registered broadcast
                // session. Idempotent — safe to call on every produce.
                try {
                    maybeStartLiveHlsForRoom(socket.room_id);
                } catch (e) {
                    log.error('maybeStartLiveHlsForRoom failed', e);
                }
            } catch (err) {
                log.error('Üretici aktarım hatası', err);
                callback({
                    error: err.message,
                });
            }
        });

        socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
            if (!roomList.has(socket.room_id)) {
                return callback({ error: 'Oda bulunamadı' });
            }

            const room = roomList.get(socket.room_id);

            const peer_name = getPeerName(room, false);

            try {
                const params = await room.consume(socket.id, consumerTransportId, producerId, rtpCapabilities);

                log.debug('Consuming', {
                    peer_name: peer_name,
                    producer_id: producerId,
                    consumer_id: params ? params.id : undefined,
                });

                //log.debug('Tüketici aktarım geri araması', { callback: params });

                callback(params);
            } catch (err) {
                log.error('Consumer transport error', err);
                callback({
                    error: err.message,
                });
            }
        });

        socket.on('producerClosed', (data) => {
            if (!roomList.has(socket.room_id)) return;

            const room = roomList.get(socket.room_id);

            const peer = room.getPeer(socket.id);

            peer.updatePeerInfo(data); // peer_info.audio VEYA video KAPALI

            room.closeProducer(socket.id, data.producer_id);
        });

        socket.on('pauseProducer', async ({ producer_id }, callback) => {
            if (!roomList.has(socket.room_id)) return;

            const room = roomList.get(socket.room_id);

            const peer_name = getPeerName(room, false);

            const peer = room.getPeer(socket.id);

            if (!peer) {
                return callback({
                    error: `"${producer_id}" kimliğine sahip üretici için ${socket.id} kimliğine sahip katılımcı bulunamadı`,
                });
            }

            const producer = peer.getProducer(producer_id);

            if (!producer) {
                return callback({ error: `"${producer_id}" kimliğine sahip üretici bulunamadı` });
            }

            try {
                await producer.pause();
            } catch (error) {
                return callback({ error: error.message });
            }

            log.debug('Üretici duraklatıldı', { peer_name: peer_name, producer_id: producer_id });

            callback('successfully');
        });

        socket.on('resumeProducer', async ({ producer_id }, callback) => {
            if (!roomList.has(socket.room_id)) return;

            const room = roomList.get(socket.room_id);

            const peer_name = getPeerName(room, false);

            const peer = room.getPeer(socket.id);

            if (!peer) {
                return callback({
                    error: `"${producer_id}" kimliğine sahip üretici için "${socket.id}" kimliğine sahip katılımcı bulunamadı`,
                });
            }

            const producer = peer.getProducer(producer_id);

            if (!producer) {
                return callback({ error: `"${producer_id}" kimliğine sahip üretici bulunamadı` });
            }

            try {
                await producer.resume();
            } catch (error) {
                return callback({ error: error.message });
            }

            log.debug('Üretici devam etti', { peer_name: peer_name, producer_id: producer_id });

            callback('successfully');
        });

        socket.on('resumeConsumer', async ({ consumer_id }, callback) => {
            if (!roomList.has(socket.room_id)) return;

            const room = roomList.get(socket.room_id);

            const peer_name = getPeerName(room, false);

            const peer = room.getPeer(socket.id);

            if (!peer) {
                return callback({
                    error: `"${consumer_id}" kimliğine sahip tüketici için "${socket.id}" kimliğine sahip katılımcı bulunamadı`,
                });
            }

            const consumer = peer.getConsumer(consumer_id);

            if (!consumer) {
                return callback({ error: `"${consumer_id}" kimliğine sahip tüketici bulunamadı` });
            }

            try {
                await consumer.resume();
            } catch (error) {
                return callback({ error: error.message });
            }

            log.debug('Tüketici devam etti', { peer_name: peer_name, consumer_id: consumer_id });

            callback('successfully');
        });

        socket.on('getProducers', () => {
            if (!roomList.has(socket.room_id)) return;

            const room = roomList.get(socket.room_id);

            log.debug('Üreticileri getir', getPeerName(room));

            // mevcut üreticilerin tamamını yeni katılan üyeye gönder
            const producerList = room.getProducerListForPeer();

            socket.emit('newProducers', producerList);
        });

        socket.on('getPeerCounts', async ({}, callback) => {
            if (!roomList.has(socket.room_id)) return;

            const room = roomList.get(socket.room_id);

            const peerCounts = room.getPeersCount();

            log.debug('Katılımcı sayısı', { peerCounts: peerCounts });

            callback({ peerCounts: peerCounts });
        });

        socket.on('cmd', async (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            log.debug('cmd', data);

            const room = roomList.get(socket.room_id);

            switch (data.type) {
                case 'privacy':
                    const peer = room.getPeer(socket.id);
                    peer.updatePeerInfo({ type: data.type, status: data.active });
                    break;
                case 'ejectAll':
                    const { peer_name, peer_uuid } = data;
                    const isPresenter = await isPeerPresenter(socket.room_id, socket.id, peer_name, peer_uuid);
                    if (!isPresenter) return;
                    break;
                default:
                    break;
                //...
            }

            data.broadcast ? room.broadCast(socket.id, 'cmd', data) : room.sendTo(data.peer_id, 'cmd', data);
        });

        socket.on('roomAction', async (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            const isPresenter = await isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            const room = roomList.get(socket.room_id);

            log.debug('Oda eylemi:', data);

            switch (data.action) {
                case 'broadcasting':
                    if (!isPresenter) return;
                    room.setIsBroadcasting(data.room_broadcasting);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'lock':
                    if (!isPresenter) return;
                    if (!room.isLocked()) {
                        room.setLocked(true, data.password);
                        room.broadCast(socket.id, 'roomAction', data.action);
                    }
                    break;
                case 'checkPassword':
                    let roomData = {
                        room: null,
                        password: 'KO',
                    };
                    if (data.password == room.getPassword()) {
                        roomData.room = room.toJson();
                        roomData.password = 'OK';
                    }
                    room.sendTo(socket.id, 'roomPassword', roomData);
                    break;
                case 'unlock':
                    if (!isPresenter) return;
                    room.setLocked(false);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'lobbyOn':
                    if (!isPresenter) return;
                    room.setLobbyEnabled(true);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'lobbyOff':
                    if (!isPresenter) return;
                    room.setLobbyEnabled(false);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'hostOnlyRecordingOn':
                    if (!isPresenter) return;
                    room.setHostOnlyRecording(true);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'hostOnlyRecordingOff':
                    if (!isPresenter) return;
                    room.setHostOnlyRecording(false);
                    room.broadCast(socket.id, 'roomAction', data.action);
                    break;
                case 'isBanned':
                    log.info('Kullanıcı spam mesajları nedeniyle odadan yasaklandı', data);
                    room.addBannedPeer(data.peer_uuid);
                    break;
                default:
                    break;
            }
            log.debug('Oda durumu', {
                broadcasting: room.isBroadcasting(),
                locked: room.isLocked(),
                lobby: room.isLobbyEnabled(),
                hostOnlyRecording: room.isHostOnlyRecording(),
            });
        });

        socket.on('roomLobby', (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            const room = roomList.get(socket.room_id);

            data.room = room.toJson();

            log.debug('Oda lobisi', {
                peer_id: data.peer_id,
                peer_name: data.peer_name,
                peers_id: data.peers_id,
                lobby: data.lobby_status,
                broadcast: data.broadcast,
            });

            if (data.peers_id && data.broadcast) {
                for (let peer_id in data.peers_id) {
                    room.sendTo(data.peers_id[peer_id], 'roomLobby', data);
                }
            } else {
                room.sendTo(data.peer_id, 'roomLobby', data);
            }
        });

        socket.on('peerAction', async (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            log.debug('Katılımcı eylemi', data);

            const presenterActions = [
                'mute',
                'unmute',
                'hide',
                'unhide',
                'stop',
                'start',
                'eject',
                'ban',
                'geoLocation',
            ];

            if (presenterActions.some((v) => data.action === v)) {
                const isPresenter = await isPeerPresenter(
                    socket.room_id,
                    socket.id,
                    data.from_peer_name,
                    data.from_peer_uuid,
                );
                if (!isPresenter) return;
            }

            const room = roomList.get(socket.room_id);

            if (data.action === 'ban') room.addBannedPeer(data.to_peer_uuid);

            data.broadcast
                ? room.broadCast(data.peer_id, 'peerAction', data)
                : room.sendTo(data.peer_id, 'peerAction', data);
        });

        socket.on('updatePeerInfo', (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            const room = roomList.get(socket.room_id);

            const peer = room.getPeer(socket.id);

            peer.updatePeerInfo(data);

            if (data.broadcast) {
                log.debug('updatePeerInfo yayın verileri');
                room.broadCast(socket.id, 'updatePeerInfo', data);
            }
        });

        socket.on('updateRoomModerator', async (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            const room = roomList.get(socket.room_id);

            const isPresenter = await isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            if (!isPresenter) return;

            const moderator = data.moderator;

            room.updateRoomModerator(moderator);

            switch (moderator.type) {
                case 'audio_cant_unmute':
                case 'video_cant_unhide':
                case 'screen_cant_share':
                case 'chat_cant_privately':
                case 'chat_cant_chatgpt':
                    room.broadCast(socket.id, 'updateRoomModerator', moderator);
                    break;
                default:
                    break;
            }
        });

        socket.on('updateRoomModeratorALL', async (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            const room = roomList.get(socket.room_id);

            const isPresenter = await isPeerPresenter(socket.room_id, socket.id, data.peer_name, data.peer_uuid);

            if (!isPresenter) return;

            const moderator = data.moderator;

            room.updateRoomModeratorALL(moderator);

            room.broadCast(socket.id, 'updateRoomModeratorALL', moderator);
        });

        socket.on('getRoomInfo', async (_, cb) => {
            if (!roomList.has(socket.room_id)) return;

            const room = roomList.get(socket.room_id);

            log.debug('Oda Bilgilerini şuraya gönder:', getPeerName(room));

            cb(room.toJson());
        });

        socket.on('fileInfo', (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            if (!isValidFileName(data.fileName)) {
                log.debug('Dosya adı geçerli değil', data);
                return;
            }

            log.debug('Dosya Bilgilerini Gönder', data);

            const room = roomList.get(socket.room_id);

            data.broadcast ? room.broadCast(socket.id, 'fileInfo', data) : room.sendTo(data.peer_id, 'fileInfo', data);
        });

        socket.on('file', (data) => {
            if (!roomList.has(socket.room_id)) return;

            const room = roomList.get(socket.room_id);

            data.broadcast ? room.broadCast(socket.id, 'file', data) : room.sendTo(data.peer_id, 'file', data);
        });

        socket.on('fileAbort', (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            roomList.get(socket.room_id).broadCast(socket.id, 'fileAbort', data);
        });

        socket.on('shareVideoAction', (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            if (data.action == 'open' && !isValidHttpURL(data.video_url)) {
                log.debug('Video kaynağı geçerli değil', data);
                return;
            }

            log.debug('Video paylaş: ', data);

            const room = roomList.get(socket.room_id);

            data.peer_id == 'all'
                ? room.broadCast(socket.id, 'shareVideoAction', data)
                : room.sendTo(data.peer_id, 'shareVideoAction', data);
        });

        socket.on('wbCanvasToJson', (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            const room = roomList.get(socket.room_id);

            // const objLength = bytesToSize(Object.keys(data).length);

            // log.debug('Send Whiteboard canvas JSON', { length: objLength });

            room.broadCast(socket.id, 'wbCanvasToJson', data);
        });

        socket.on('whiteboardAction', (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            const room = roomList.get(socket.room_id);

            log.debug('Whiteboard', data);
            room.broadCast(socket.id, 'whiteboardAction', data);
        });

        socket.on('setVideoOff', (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            log.debug('Video kapalı verileri', data.peer_name);

            const room = roomList.get(socket.room_id);

            room.broadCast(socket.id, 'setVideoOff', data);
        });

        socket.on('recordingAction', async (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            log.debug('Kayıt eylemi', data);

            const room = roomList.get(socket.room_id);

            room.broadCast(socket.id, 'recordingAction', data);
        });

        socket.on('refreshParticipantsCount', () => {
            if (!roomList.has(socket.room_id)) return;

            const room = roomList.get(socket.room_id);

            const peerCounts = room.getPeers().size;

            const data = {
                room_id: socket.room_id,
                peer_counts: peerCounts,
            };
            log.debug('Katılımcı sayısını yenile', data);
            room.broadCast(socket.id, 'refreshParticipantsCount', data);
        });

        socket.on('message', (dataObject) => {
            if (!roomList.has(socket.room_id)) return;

            const data = checkXSS(dataObject);

            const room = roomList.get(socket.room_id);

            // mesajın gerçek katılımcıdan gelip gelmediğini kontrol edin
            const realPeer = isRealPeer(data.peer_name, socket.id, socket.room_id);

            if (!realPeer) {
                const peer_name = getPeerName(room, false);
                log.debug('Sahte mesaj tespit edildi', {
                    realFrom: peer_name,
                    fakeFrom: data.peer_name,
                    msg: data.peer_msg,
                });
                return;
            }

            log.info('message', data);

            data.to_peer_id == 'all'
                ? room.broadCast(socket.id, 'message', data)
                : room.sendTo(data.to_peer_id, 'message', data);
        });

        socket.on('getChatGPT', async ({ time, room, name, prompt, context }, cb) => {
            if (!roomList.has(socket.room_id)) return;
            if (!config.chatGPT.enabled) return cb({ message: 'ChatGPT devre dışı görünüyor, daha sonra deneyin!' });
            // https://platform.openai.com/docs/api-reference/completions/create
            try {
                // İstemi içeriğe ekleyin
                context.push({ role: 'user', content: prompt });
                // Yanıt oluşturmak için OpenAI'nin API'sini çağırın
                const completion = await chatGPT.chat.completions.create({
                    model: config.chatGPT.model || 'gpt-3.5-turbo',
                    messages: context,
                    max_tokens: config.chatGPT.max_tokens,
                    temperature: config.chatGPT.temperature,
                });
                // Tamamlamadan mesajı çıkar
                const message = completion.choices[0].message.content.trim();
                // Bağlama yanıt ekleyin
                context.push({ role: 'assistant', content: message });
                // Konuşma ayrıntılarını günlüğe kaydet
                log.info('ChatGPT', {
                    time: time,
                    room: room,
                    name: name,
                    context: context,
                });
                // İstemciye geri arama yanıtı
                cb({ message: message, context: context });
            } catch (error) {
                if (error.name === 'APIError') {
                    log.error('ChatGPT', {
                        name: error.name,
                        status: error.status,
                        message: error.message,
                        code: error.code,
                        type: error.type,
                    });
                    cb({ message: error.message });
                } else {
                    // API dışı hata
                    log.error('ChatGPT', error);
                    cb({ message: error.message });
                }
            }
        });

        // https://docs.heygen.com/reference/overview-copy

        socket.on('getAvatarList', async ({}, cb) => {
            if (!config.videoAI.enabled || !config.videoAI.apiKey)
                return cb({ error: 'Video AI devre dışı görünüyor, daha sonra deneyin!' });
            try {
                const response = await axios.get(`${config.videoAI.basePath}/v1/avatar.list`, {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Api-Key': config.videoAI.apiKey,
                    },
                });

                const data = { response: response.data.data };

                //log.debug('getAvatarList', data);

                cb(data);
            } catch (error) {
                cb({ error: error.response?.status === 500 ? 'İç sunucu hatası' : error.message });
            }
        });

        socket.on('getVoiceList', async ({}, cb) => {
            if (!config.videoAI.enabled || !config.videoAI.apiKey)
                return cb({ error: 'Video AI devre dışı görünüyor, daha sonra deneyin!' });
            try {
                const response = await axios.get(`${config.videoAI.basePath}/v1/voice.list`, {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Api-Key': config.videoAI.apiKey,
                    },
                });

                const data = { response: response.data.data };

                //log.debug('getVoiceList', data);

                cb(data);
            } catch (error) {
                cb({ error: error.response?.status === 500 ? 'İç sunucu hatası' : error.message });
            }
        });

        socket.on('streamingNew', async ({ quality, avatar_name, voice_id }, cb) => {
            if (!roomList.has(socket.room_id)) return;
            if (!config.videoAI.enabled || !config.videoAI.apiKey)
                return cb({ error: 'Video AI devre dışı görünüyor, daha sonra deneyin!' });
            try {
                const response = await axios.post(
                    `${config.videoAI.basePath}/v1/streaming.new`,
                    {
                        quality,
                        avatar_name,
                        voice: {
                            voice_id: voice_id,
                        },
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Api-Key': config.videoAI.apiKey,
                        },
                    },
                );

                const data = { response: response.data };

                log.debug('streamingNew', data);

                cb(data);
            } catch (error) {
                cb({ error: error.response?.status === 500 ? 'İç sunucu hatası' : error });
            }
        });

        socket.on('streamingStart', async ({ session_id, sdp }, cb) => {
            if (!roomList.has(socket.room_id)) return;
            if (!config.videoAI.enabled || !config.videoAI.apiKey)
                return cb({ error: 'Video AI devre dışı görünüyor, daha sonra deneyin!' });

            try {
                const response = await axios.post(
                    `${config.videoAI.basePath}/v1/streaming.start`,
                    { session_id, sdp },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Api-Key': config.videoAI.apiKey,
                        },
                    },
                );

                const data = { response: response.data.data };

                log.debug('startSessionAi', data);

                cb(data);
            } catch (error) {
                cb({ error: error.response?.status === 500 ? 'sunucu hatası' : error });
            }
        });

        socket.on('streamingICE', async ({ session_id, candidate }, cb) => {
            if (!roomList.has(socket.room_id)) return;
            if (!config.videoAI.enabled || !config.videoAI.apiKey)
                return cb({ error: 'Video AI devre dışı görünüyor, daha sonra deneyin!' });

            try {
                const response = await axios.post(
                    `${config.videoAI.basePath}/v1/streaming.ice`,
                    { session_id, candidate },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Api-Key': config.videoAI.apiKey,
                        },
                    },
                );

                const data = { response: response.data };

                log.debug('streamingICE', data);

                cb(data);
            } catch (error) {
                log.error('Error in streamingICE:', error.response?.data || error.message); // Log detailed error
                cb({ error: error.response?.status === 500 ? 'İç sunucu hatası' : error });
            }
        });

        socket.on('streamingTask', async ({ session_id, text }, cb) => {
            if (!roomList.has(socket.room_id)) return;
            if (!config.videoAI.enabled || !config.videoAI.apiKey)
                return cb({ error: 'Video AI devre dışı görünüyor, daha sonra deneyin!' });
            try {
                const response = await axios.post(
                    `${config.videoAI.basePath}/v1/streaming.task`,
                    {
                        session_id,
                        text,
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Api-Key': config.videoAI.apiKey,
                        },
                    },
                );

                const data = { response: response.data };

                log.debug('streamingTask', data);

                cb(data);
            } catch (error) {
                cb({ error: error.response?.status === 500 ? 'sunucu hatası' : error });
            }
        });

        socket.on('talkToOpenAI', async ({ text, context }, cb) => {
            if (!roomList.has(socket.room_id)) return;
            if (!config.videoAI.enabled || !config.videoAI.apiKey)
                return cb({ error: 'Video AI devre dışı görünüyor, daha sonra deneyin!' });
            try {
                const systemLimit = config.videoAI.systemLimit;
                const arr = {
                    messages: [...context, { role: 'system', content: systemLimit }, { role: 'user', content: text }],
                    model: 'gpt-3.5-turbo',
                };
                const chatCompletion = await chatGPT.chat.completions.create(arr);
                const chatText = chatCompletion.choices[0].message.content;
                context.push({ role: 'system', content: chatText });
                context.push({ role: 'assistant', content: chatText });

                const data = { response: chatText, context: context };

                log.debug('talkToOpenAI', data);

                cb(data);
            } catch (error) {
                cb({ error: error.message });
            }
        });

        socket.on('streamingStop', async ({ session_id }, cb) => {
            if (!roomList.has(socket.room_id)) return;
            if (!config.videoAI.enabled || !config.videoAI.apiKey)
                return cb({ error: 'Video AI devre dışı görünüyor, daha sonra deneyin!' });
            try {
                const response = await axios.post(
                    `${config.videoAI.basePath}/v1/streaming.stop`,
                    {
                        session_id,
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Api-Key': config.videoAI.apiKey,
                        },
                    },
                );

                const data = { response: response.data };

                log.debug('streamingStop', data);

                cb(data);
            } catch (error) {
                cb({ error: error.response?.status === 500 ? 'İç sunucu hatası' : error });
            }
        });

        socket.on('disconnect', async () => {
            if (!roomList.has(socket.room_id)) return;

            const room = roomList.get(socket.room_id);

            const peer = room.getPeer(socket.id);

            const { peer_name, peer_uuid } = peer || {};

            const isPresenter = await isPeerPresenter(socket.room_id, socket.id, peer_name, peer_uuid);

            log.debug('[Disconnect] - katılımcı adı', peer_name);

            const disconnectedRoomId = socket.room_id;
            room.removePeer(socket.id);

            if (room.getPeers().size === 0) {
                //
                roomList.delete(socket.room_id);

                delete presenters[socket.room_id];

                log.info('[Disconnect] - Son katılımcı - oda kimliğine göre gruplandırılmış mevcut sunucular', presenters);

                const activeRooms = getActiveRooms();

                log.info('[Disconnect] - Son katılımcı - mevcut etkin odalar', activeRooms);

                // Tear down live HLS pipeline when the last peer leaves.
                // stopLiveHlsForRoom keeps the .m3u8 dir for a grace period
                // so reconnecting broadcasters resume the same playlist.
                stopLiveHlsForRoom(disconnectedRoomId).catch((e) =>
                    log.error(`[live-hls ${disconnectedRoomId}] stop on disconnect failed:`, e.message),
                );
            }

            room.broadCast(socket.id, 'removeMe', removeMeData(room, peer_name, isPresenter));

            if (isPresenter) removeIP(socket);

            socket.room_id = null;
        });

        socket.on('exitRoom', async (_, callback) => {
            if (!roomList.has(socket.room_id)) {
                return callback({
                    error: 'Şu anda bir odada değil',
                });
            }

            const room = roomList.get(socket.room_id);

            const peer = room.getPeer(socket.id);

            const { peer_name, peer_uuid } = peer || {};

            const isPresenter = await isPeerPresenter(socket.room_id, socket.id, peer_name, peer_uuid);

            log.debug('Odadan Çık', peer_name);

            const exitedRoomId = socket.room_id;
            room.removePeer(socket.id);

            room.broadCast(socket.id, 'removeMe', removeMeData(room, peer_name, isPresenter));

            if (room.getPeers().size === 0) {
                //
                roomList.delete(socket.room_id);

                delete presenters[socket.room_id];

                log.info('[REMOVE ME] - Son katılımcı - oda kimliğine göre gruplandırılmış mevcut sunucular', presenters);

                const activeRooms = getActiveRooms();

                log.info('[REMOVE ME] - Son katılımcı - mevcut etkin odalar', activeRooms);

                stopLiveHlsForRoom(exitedRoomId).catch((e) =>
                    log.error(`[live-hls ${exitedRoomId}] stop on exitRoom failed:`, e.message),
                );
            }

            socket.room_id = null;

            if (isPresenter) removeIP(socket);

            callback('Successfully exited room');
        });

        // common
        function getPeerName(room, json = true) {
            try {
                const DEFAULT_PEER_NAME = 'undefined';
                const peer = room.getPeer(socket.id);
                const peerName = peer.peer_name || DEFAULT_PEER_NAME;
                if (json) {
                    return { peer_name: peerName };
                }
                return peerName;
            } catch (err) {
                log.error('getPeerName', err);
                return json ? { peer_name: DEFAULT_PEER_NAME } : DEFAULT_PEER_NAME;
            }
        }

        function isRealPeer(name, id, roomId) {
            if (!roomList.has(socket.room_id)) return false;

            const room = roomList.get(roomId);

            const peer = room.getPeer(id);

            const { peer_name } = peer;

            return peer_name == name;
        }

        function isValidFileName(fileName) {
            const invalidChars = /[\\\/\?\*\|:"<>]/;
            return !invalidChars.test(fileName);
        }

        function isValidHttpURL(input) {
            const pattern = new RegExp(
                '^(https?:\\/\\/)?' + // protocol
                    '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|' + // alan adı
                    '((\\d{1,3}\\.){3}\\d{1,3}))' + // VEYA ip (v4) adresi
                    '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*' + // port ve yol
                    '(\\?[;&a-z\\d%_.~+=-]*)?' + // sorgu dizesi
                    '(\\#[-a-z\\d_]*)?$',
                'i',
            ); // parça bulucu
            return pattern.test(input);
        }

        function removeMeData(room, peerName, isPresenter) {
            const roomId = room && socket.room_id;
            const peerCounts = room && room.getPeers().size;
            const data = {
                room_id: roomId,
                peer_id: socket.id,
                peer_name: peerName,
                peer_counts: peerCounts,
                isPresenter: isPresenter,
            };
            log.debug('[REMOVE ME DATA]', data);
            return data;
        }

        function bytesToSize(bytes) {
            let sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            if (bytes == 0) return '0 Byte';
            let i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
            return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
        }
    });

    function clone(value) {
        if (value === undefined) return undefined;
        if (Number.isNaN(value)) return NaN;
        if (typeof structuredClone === 'function') return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    async function isPeerPresenter(room_id, peer_id, peer_name, peer_uuid) {
        try {
            if (
                config.presenters &&
                config.presenters.join_first &&
                (!presenters[room_id] || !presenters[room_id][peer_id])
            ) {
                // Sunumcu, sunum yapan kişinin yapılandırma listesinde değil, bağlantısı kesildi veya peer_id değişti...
                for (const [existingPeerID, presenter] of Object.entries(presenters[room_id] || {})) {
                    if (presenter.peer_name === peer_name) {
                        log.info('Sunumcu bulundu', {
                            room: room_id,
                            peer_id: existingPeerID,
                            peer_name: peer_name,
                        });
                        return true;
                    }
                }
                return false;
            }

            const isPresenter =
                (config.presenters &&
                    config.presenters.join_first &&
                    typeof presenters[room_id] === 'object' &&
                    Object.keys(presenters[room_id][peer_id]).length > 1 &&
                    presenters[room_id][peer_id]['peer_name'] === peer_name &&
                    presenters[room_id][peer_id]['peer_uuid'] === peer_uuid) ||
                (config.presenters && config.presenters.list && config.presenters.list.includes(peer_name));

            log.debug('isPeerPresenter', {
                room_id: room_id,
                peer_id: peer_id,
                peer_name: peer_name,
                peer_uuid: peer_uuid,
                isPresenter: isPresenter,
            });

            return isPresenter;
        } catch (err) {
            log.error('isPeerPresenter', err);
            return false;
        }
    }

    async function isAuthPeer(username, password) {
        // Backend'den gelen standart token ile doğrulandıysa, tekrar şifre kontrolüne gerek yok
        if (password === 'default_password') {
            return true;
        }

        if (hostCfg.users_from_db && hostCfg.users_api_endpoint) {
            try {
                const response = await axios.post(hostCfg.users_api_endpoint, {
                    email: username,
                    password: password,
                    api_secret_key: hostCfg.users_api_secret_key,
                });
                return response.data && response.data.message === true;
            } catch (error) {
                log.error('AXIOS isAuthPeer hatası', error.message);
                return false;
            }
        } else {
            return (
                hostCfg.users && hostCfg.users.some((user) => user.username === username && user.password === password)
            );
        }
    }

    async function isValidToken(token) {
        return new Promise((resolve, reject) => {
            jwt.verify(token, jwtCfg.JWT_KEY, (err, decoded) => {
                if (err) {
                    // Jeton geçersiz
                    resolve(false);
                } else {
                    // Jeton geçerli
                    resolve(true);
                }
            });
        });
    }

    function encodeToken(token) {
        if (!token) return '';

        const { username = 'username', password = 'password', presenter = false, expire } = token;

        const expireValue = expire || jwtCfg.JWT_EXP;

        // Yük oluşturma
        const payload = {
            username: String(username),
            password: String(password),
            presenter: String(presenter),
        };

        // AES şifrelemesini kullanarak veriyi şifreleme
        const payloadString = JSON.stringify(payload);
        const encryptedPayload = CryptoJS.AES.encrypt(payloadString, jwtCfg.JWT_KEY).toString();

        // JWT token'ı oluşturma
        const jwtToken = jwt.sign({ data: encryptedPayload }, jwtCfg.JWT_KEY, { expiresIn: expireValue });

        return jwtToken;
    }

    function decodeToken(jwtToken) {
        if (!jwtToken) return null;

        // JWT jetonunu doğrulayın ve kodunu çözün
        const decodedToken = jwt.verify(jwtToken, jwtCfg.JWT_KEY);
        
        // Eğer data alanı varsa, AES şifreli saigmvideochatsfu tokenıdır
        if (decodedToken && decodedToken.data) {
            // AES şifre çözmeyi kullanarak yükün şifresini çözme
            const decryptedPayload = CryptoJS.AES.decrypt(decodedToken.data, jwtCfg.JWT_KEY).toString(CryptoJS.enc.Utf8);
            // Şifresi çözülmüş veriyi JSON olarak ayrıştırma
            return JSON.parse(decryptedPayload);
        }

        // Eğer data alanı yoksa, standart backend JWT tokenıdır (Mevcut Backend uyumluluğu)
        if (decodedToken && decodedToken.sub) {
            return {
                username: decodedToken.sub, // Kullanıcı ID
                password: 'default_password',
                presenter: 'true' // Varsayılan yetki
            };
        }

        throw new Error('Invalid token format');
    }

    function getActiveRooms() {
        const roomIds = Array.from(roomList.keys());
        const roomPeersArray = roomIds.map((roomId) => {
            const room = roomList.get(roomId);
            const peerCount = (room && room.getPeers().size) || 0;
            const broadcasting = (room && room.isBroadcasting()) || false;
            return {
                room: roomId,
                broadcasting: broadcasting,
                peers: peerCount,
            };
        });
        return roomPeersArray;
    }

    function isAllowedRoomAccess(logMessage, req, hostCfg, authHost, roomList, roomId) {
        const OIDCUserAuthenticated = OIDC.enabled && req.oidc.isAuthenticated();
        const hostUserAuthenticated = hostCfg.protected && hostCfg.authenticated;
        const roomActive = authHost.isRoomActive();
        const roomExist = roomList.has(roomId);
        const roomCount = roomList.size;

        const allowRoomAccess =
            (!hostCfg.protected && !OIDC.enabled) || // Ana bilgisayar koruması yok ve OIDC modu etkin (varsayılan)
            OIDCUserAuthenticated || // Kullanıcının kimliği OIDC aracılığıyla doğrulandı
            hostUserAuthenticated || // Kullanıcının Oturum Açma yoluyla kimliği doğrulandı
            ((OIDCUserAuthenticated || hostUserAuthenticated) && roomCount === 0) || // Kullanıcı kimliği doğrulanmış ilk odaya katılır
            roomExist; // Kullanıcı veya Misafir mevcut bir Odaya katılır

        log.debug(logMessage, {
            OIDCUserEnabled: OIDC.enabled,
            OIDCUserAuthenticated: OIDCUserAuthenticated,
            hostUserAuthenticated: hostUserAuthenticated,
            hostProtected: hostCfg.protected,
            hostAuthenticated: hostCfg.authenticated,
            roomActive: roomActive,
            roomExist: roomExist,
            roomCount: roomCount,
            roomId: roomId,
            allowRoomAccess: allowRoomAccess,
        });

        return allowRoomAccess;
    }

    function isRoomAllowedForUser(message, username, room) {
        log.debug('isRoomAllowedForUser ------>', { message, username, room });

        if (hostCfg.protected || hostCfg.user_auth) {
            const isInPresenterLists = config.presenters.list.includes(username);

            if (isInPresenterLists) {
                log.debug('isRoomAllowedForUser - sunumcu listesi odasındaki kullanıcıya izin verildi', room);
                return true;
            }

            const user = hostCfg.users.find((user) => user.username === username);

            if (!user) {
                log.debug('isRoomAllowedForUser - kullanıcı bulunamadı', username);
                return false;
            }

            if (!user.allowed_rooms || user.allowed_rooms.includes('*') || user.allowed_rooms.includes(room)) {
                log.debug('isRoomAllowedForUser - kullanıcı odasına izin verildi', room);
                return true;
            }

            log.debug('isRoomAllowedForUser - kullanıcı odasına izin verilmedi', room);
            return false;
        }

        log.debug('isRoomAllowedForUser - Ana bilgisayar korumalı veya user_auth etkin değil, kullanıcı odasına izin verildi', room);
        return true;
    }

    async function getPeerGeoLocation(ip) {
        const endpoint = config.IPLookup.getEndpoint(ip);
        log.debug('Katılımcı coğrafi konumunu al', { ip: ip, endpoint: endpoint });
        return axios
            .get(endpoint)
            .then((response) => response.data)
            .catch((error) => log.error(error));
    }

    function getIP(req) {
        return req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'] || req.socket.remoteAddress || req.ip;
    }

    function getIpSocket(socket) {
        return (
            socket.handshake.headers['x-forwarded-for'] ||
            socket.handshake.headers['X-Forwarded-For'] ||
            socket.handshake.address
        );
    }

    function allowedIP(ip) {
        const authorizedIPs = authHost.getAuthorizedIPs();
        const authorizedIP = authHost.isAuthorizedIP(ip);
        const isRoomActive = authHost.isRoomActive();
        log.info('İzin verilen IP ler', {
            ip: ip,
            authorizedIP: authorizedIP,
            authorizedIPs: authorizedIPs,
            isRoomActive: isRoomActive,
        });
        return authHost != null && authorizedIP;
    }

    function removeIP(socket) {
        if (hostCfg.protected) {
            const ip = getIpSocket(socket);
            if (ip && allowedIP(ip)) {
                authHost.deleteIP(ip);
                hostCfg.authenticated = false;
                log.info('IP yi kimlik doğrulamasından kaldır', {
                    ip: ip,
                    authorizedIps: authHost.getAuthorizedIPs(),
                    roomActive: authHost.isRoomActive(),
                });
            }
        }
    }
}
