'use strict';

/**
 * AiConferencePeer
 * ----------------
 * A server-side "fake" mediasoup peer that joins a REAL /conference room
 * (see ConferenceSocket.js) as an audio participant: it listens to a human's
 * audio, transcribes it, gets an LLM reply, synthesizes speech, and produces
 * that audio back into the room as its own producer — indistinguishable to
 * other peers from a normal participant's audio track.
 *
 * This is Phase 1 (audio-only, no video track). It reuses the exact
 * PlainTransport.consume() pattern already proven in Server.js's live-HLS
 * pipeline for the LISTEN side, and adds a new PlainTransport.produce()
 * pattern (validated in isolation against a real mediasoup worker before
 * being wired in here) for the SPEAK side, which has no prior example
 * anywhere in this codebase.
 *
 * Turn-taking: no VAD library dependency. FFmpeg's own `silencedetect` audio
 * filter (applied to the same RTP the AI is listening to) marks turn
 * boundaries; each turn's audio is captured to a fresh WAV file by
 * respawning the receiver process per turn (simpler and more robust than
 * trying to dynamically re-cut a single long-running ffmpeg process).
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const AI_SERVICE_INTERNAL_URL = (process.env.AI_SERVICE_INTERNAL_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
// terapi_ai/server (separate domain/host from this service - see
// terapi_ai/mobile/src/api/client.ts's API_URL) owns the persisted
// AIConversationMessage history, leveling and profile-summary that the
// text/voice AI Psikolog screens already share. Routing turns through it
// (when the caller supplies the user's own JWT) makes video-call turns join
// that same shared memory instead of a call-scoped, in-memory-only history.
const TERAPI_AI_BACKEND_URL = (process.env.TERAPI_AI_BACKEND_URL || 'https://acarlarkuyumculuk.xyz/terapi-api/v1').replace(/\/$/, '');
const TMP_DIR = process.env.AI_PEER_TMP_DIR || path.join(os.tmpdir(), 'ai-conference-peer');
// /transcribe, /chat, /speak use @_require_auth (app.py/security.py), which is
// open/warn-mode when API_KEYS is unset on the Flask process - matching
// today's setup (mobile's voice.ts also sends no key). If API_KEYS is ever
// configured, set AI_PEER_API_KEY to one of those keys so these internal
// server-to-server calls keep working.
const AI_PEER_API_KEY = process.env.AI_PEER_API_KEY || '';
function aiServiceHeaders(extra) {
  const headers = { ...extra };
  if (AI_PEER_API_KEY) headers['X-API-Key'] = AI_PEER_API_KEY;
  return headers;
}

// Silence-based turn segmentation. Tuned for spoken conversation: 1.2s of
// sub-threshold audio is treated as "the human stopped talking", short pauses
// mid-sentence (breaths, "um") are shorter than this and don't cut the turn.
const SILENCE_NOISE_DB = process.env.AI_PEER_SILENCE_DB || '-35dB';
const SILENCE_MIN_SEC = parseFloat(process.env.AI_PEER_SILENCE_SEC || '1.2');
// Ignore a silence_end that fires before this many seconds of process
// runtime - that's just "nobody has spoken yet since the last turn started",
// not a real end-of-turn.
const MIN_TURN_SEC = 0.6;
// Hard cap so a stuck/very long monologue doesn't record forever.
const MAX_TURN_SEC = 25;

// RTP port pool for this module's PlainTransports. Deliberately a separate
// range from Server.js's live-HLS pool (60000-60400) and the main mediasoup
// worker RTC port range, to avoid any collision.
const RTP_PORT_BASE = parseInt(process.env.AI_PEER_RTP_PORT_BASE, 10) || 61000;
const RTP_PORT_MAX = parseInt(process.env.AI_PEER_RTP_PORT_MAX, 10) || 61400;
const portsInUse = new Set();

function allocPort() {
  for (let p = RTP_PORT_BASE; p <= RTP_PORT_MAX; p++) {
    if (!portsInUse.has(p)) {
      portsInUse.add(p);
      return p;
    }
  }
  throw new Error('ai_peer_no_rtp_port_available');
}

function freePort(p) {
  if (p) portsInUse.delete(p);
}

function findHumanAudioProducer(room) {
  // room.peers is a Map<socketId, { producers: Array<Producer>, ... }>
  // (ConferenceSocket.js shape). Picks the first open, non-AI audio
  // producer. Multi-human rooms: only the first speaker found is heard -
  // a documented Phase 1 limitation, not a bug.
  for (const peer of room.peers.values()) {
    if (peer.isAiPeer) continue;
    for (const producer of peer.producers || []) {
      if (producer && !producer.closed && producer.kind === 'audio') return producer;
    }
  }
  return null;
}

function buildConsumeSdp({ port, payloadType, mimeSubtype = 'opus', clockRate = 48000, channels = 2 }) {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=ai-conference-peer-listen',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${port} RTP/AVP ${payloadType}`,
    'a=rtcp-mux',
    `a=rtpmap:${payloadType} ${mimeSubtype}/${clockRate}${channels > 1 ? `/${channels}` : ''}`,
    'a=recvonly',
    '',
  ].join('\n');
}

function findHumanVideoProducer(room) {
  // Duygu-ipucu ozelligi icin: insanin kamerasi acik/varsa video producer'ini
  // bulur. Yoksa (kamera kapali/hic yoksa) null doner - ozellik tamamen
  // best-effort, bu durumda emotion-hint sessizce devre disi kalir.
  for (const peer of room.peers.values()) {
    if (peer.isAiPeer) continue;
    for (const producer of peer.producers || []) {
      if (producer && !producer.closed && producer.kind === 'video') return producer;
    }
  }
  return null;
}

function buildVideoConsumeSdp({ port, payloadType, mimeSubtype = 'VP8', clockRate = 90000 }) {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=ai-conference-peer-listen-video',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=video ${port} RTP/AVP ${payloadType}`,
    'a=rtcp-mux',
    `a=rtpmap:${payloadType} ${mimeSubtype}/${clockRate}`,
    'a=recvonly',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------
// Basit "konusan avatar" videosu (Faz 2 - lite). Gercek viseme/fonem
// eslemesi ya da GPU'lu bir lip-sync modeli YOK; bunun yerine TTS
// sesinin kisa pencereli RMS zarfini olcup 3 sabit agiz karesi
// (kapali/yari-acik/acik) arasinda gecis yapiyoruz. Izole testle
// dogrulandi: mediasoup gercekten bu VP8 RTP'yi kabul edip consumer'a
// iletiyor (producer/consumer.getStats() ile olculdu).
// ---------------------------------------------------------------------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-800)}`))));
    p.on('error', reject);
  });
}

const AVATAR_FRAME_DIR = path.join(TMP_DIR, 'avatar-frames');
const AVATAR_SIZE = 320;
const AVATAR_BG_COLOR = '0x6BCBFF'; // mobile theme.colors.primary
const FRAME_WINDOW_SEC = 0.12;
const FRAME_FILES = { closed: 'mouth_closed.png', half: 'mouth_half.png', open: 'mouth_open.png' };
let avatarFramesReady = null;

// 3 durumluk agiz karesini bir kere uretip diske onbelleklerz (ayni process
// icinde tekrar tekrar cagirilsa da tek seferlik ffmpeg maliyeti).
function ensureAvatarFrames() {
  if (!avatarFramesReady) {
    avatarFramesReady = (async () => {
      await fs.promises.mkdir(AVATAR_FRAME_DIR, { recursive: true });
      const specs = [
        { key: 'closed', mouthY: 224, mouthH: 8 },
        { key: 'half', mouthY: 206, mouthH: 26 },
        { key: 'open', mouthY: 186, mouthH: 46 },
      ];
      for (const spec of specs) {
        const outPath = path.join(AVATAR_FRAME_DIR, FRAME_FILES[spec.key]);
        if (fs.existsSync(outPath)) continue;
        const vf = [
          'drawbox=x=70:y=90:w=60:h=16:color=white:t=fill',
          'drawbox=x=190:y=90:w=60:h=16:color=white:t=fill',
          `drawbox=x=110:y=${spec.mouthY}:w=100:h=${spec.mouthH}:color=white:t=fill`,
        ].join(',');
        await run('ffmpeg', [
          '-y', '-f', 'lavfi', '-i', `color=c=${AVATAR_BG_COLOR}:s=${AVATAR_SIZE}x${AVATAR_SIZE}`,
          '-vf', vf, '-frames:v', '1', '-update', '1', outPath,
        ]);
      }
    })();
  }
  return avatarFramesReady;
}

function decodePcm16(mp3Path, sampleRate) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-i', mp3Path, '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`pcm decode exited ${code}: ${stderr.slice(-400)}`))));
    ff.on('error', reject);
  });
}

// Ses zarfini (RMS, 120ms pencereler) o utterance'in kendi tepe degerine
// gore 3 kovaya (kapali/yari-acik/acik) esler - sabit dB esigi yerine
// adaptif oran kullaniyoruz cunku TTS ciktilarinin genel ses seviyesi
// degisebiliyor.
function buildMouthFrameSequence(pcm) {
  const sampleRate = 16000;
  const samplesPerWindow = Math.round(sampleRate * FRAME_WINDOW_SEC);
  const totalSamples = Math.floor(pcm.length / 2);
  const windows = [];
  let peak = 1;
  for (let start = 0; start < totalSamples; start += samplesPerWindow) {
    const end = Math.min(start + samplesPerWindow, totalSamples);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const sample = pcm.readInt16LE(i * 2);
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    windows.push(rms);
    if (rms > peak) peak = rms;
  }
  if (!windows.length) return ['closed'];
  return windows.map((rms) => {
    const ratio = rms / peak;
    if (ratio < 0.12) return 'closed';
    if (ratio < 0.45) return 'half';
    return 'open';
  });
}

// Kare dizisini ffmpeg'in concat demuxer'iyla gercek zamanli (-re) VP8 RTP'ye
// encode edip gonderir - ayri bir ara video dosyasi olmadan tek adimda.
async function sendTalkingVideoRtp(frameKeys, port, payloadType, ssrc) {
  const listPath = path.join(TMP_DIR, `speak-video-list-${crypto.randomUUID()}.txt`);
  const toUri = (key) => path.join(AVATAR_FRAME_DIR, FRAME_FILES[key]).replace(/\\/g, '/');
  const lines = [];
  for (const key of frameKeys) {
    lines.push(`file '${toUri(key)}'`);
    lines.push(`duration ${FRAME_WINDOW_SEC}`);
  }
  lines.push(`file '${toUri(frameKeys[frameKeys.length - 1])}'`);
  await fs.promises.writeFile(listPath, lines.join('\n'), 'utf8');
  try {
    await run('ffmpeg', [
      '-y', '-re', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vsync', 'vfr', '-pix_fmt', 'yuv420p',
      '-c:v', 'libvpx', '-b:v', '300k', '-cpu-used', '4', '-deadline', 'realtime',
      '-payload_type', String(payloadType),
      '-ssrc', String(ssrc),
      '-f', 'rtp', `rtp://127.0.0.1:${port}`,
    ]);
  } finally {
    fs.promises.unlink(listPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------
// Duygu ipucu (dusuk riskli MVP): her turda TEK bir video karesi + o turun
// ses enerjisi ozeti tensorflow_api'nin /psychology/emotion-hint'ine
// gonderilir. Tamamen best-effort - kamera kapaliysa, DeepFace kurulu
// degilse ya da herhangi bir adim basarisiz/gec kalirsa sessizce atlanir,
// ana sohbet akisini ASLA bloklamaz (bkz. handleTurn'deki cagirim yeri).
// ---------------------------------------------------------------------
async function captureVideoFrame(peerState) {
  if (!peerState.listenVideoSdpPath) return null;
  const outPath = path.join(TMP_DIR, `frame-${peerState.roomId}-${Date.now()}.jpg`);
  try {
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y', '-protocol_whitelist', 'file,udp,rtp',
        '-i', peerState.listenVideoSdpPath,
        '-frames:v', '1', '-q:v', '4',
        outPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); });
      // Bir sonraki keyframe gelene kadar bekleyebilir (uzak ucun keyframe
      // araligina bagli) - bu yuzden makul bir ust sinir var; asilirsa
      // sessizce iptal edilir (ipucu bu tur icin atlanir).
      const hardTimeout = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (_) {} }, 4000);
      ff.on('close', (code) => {
        clearTimeout(hardTimeout);
        if (code === 0) resolve(); else reject(new Error(`frame grab exited ${code}: ${stderr.slice(-300)}`));
      });
      ff.on('error', (e) => { clearTimeout(hardTimeout); reject(e); });
    });
    const buf = await fs.promises.readFile(outPath);
    return buf.toString('base64');
  } catch (e) {
    return null;
  } finally {
    fs.promises.unlink(outPath).catch(() => {});
  }
}

function computeAudioEnergyStats(pcm, sampleRate = 16000, windowSec = 0.2) {
  const samplesPerWindow = Math.round(sampleRate * windowSec);
  const totalSamples = Math.floor(pcm.length / 2);
  const windows = [];
  for (let start = 0; start < totalSamples; start += samplesPerWindow) {
    const end = Math.min(start + samplesPerWindow, totalSamples);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const sample = pcm.readInt16LE(i * 2);
      sumSq += sample * sample;
    }
    windows.push(Math.sqrt(sumSq / Math.max(1, end - start)));
  }
  if (!windows.length) return { mean: 0, variance: 0 };
  const mean = windows.reduce((a, b) => a + b, 0) / windows.length;
  const variance = windows.reduce((a, b) => a + (b - mean) ** 2, 0) / windows.length;
  return { mean, variance };
}

async function gatherEmotionHint(peerState, wavPath) {
  const [frameB64, pcm] = await Promise.all([
    captureVideoFrame(peerState).catch(() => null),
    decodePcm16(wavPath, 16000).catch(() => null),
  ]);
  const energy = pcm ? computeAudioEnergyStats(pcm) : null;
  if (!frameB64 && !energy) return null;
  try {
    const res = await axios.post(`${AI_SERVICE_INTERNAL_URL}/psychology/emotion-hint`, {
      ...(frameB64 ? { imageBase64: frameB64 } : {}),
      ...(energy ? { audioEnergyMean: energy.mean, audioEnergyVariance: energy.variance } : {}),
    }, { timeout: 4000, headers: aiServiceHeaders() });
    return (res.data && res.data.hint) || null;
  } catch (_e) {
    return null;
  }
}

module.exports = function initAiConferencePeer(io, { rooms, logInfo, logError }) {
  const conferenceNsp = io.of('/conference');
  const log = {
    info: logInfo || ((...a) => console.log('[ai-peer]', ...a)),
    error: logError || ((...a) => console.error('[ai-peer]', ...a)),
  };

  fs.mkdirSync(TMP_DIR, { recursive: true });

  const activePeers = new Map(); // roomId -> peerState

  // Bir PlainTransport(comedia:true) + produce() cifti olusturur. comedia:true
  // ILK gelen paketin kaynak ip:port'una kilitlenir ve SONRASINDA BASKA
  // kaynaktan gelen paketleri sessizce reddeder (izole testle dogrulandi: iki
  // ayri ffmpeg process'i - iki farkli efemer local port - kullanildiginda
  // ikinci utterance mediasoup tarafindan hicbir zaman kabul edilmiyordu).
  // Bu yuzden HER utterance icin TAZE bir transport+producer olusturuyoruz -
  // "sabit local port zorlama" denemesi de basarisiz oldu (ilk utterance bile
  // kayboldu), bu yaklasim iki kez izole olarak dogrulandi ve guvenilir.
  async function createSpeakProducer(router) {
    const transport = await router.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: true,
      comedia: true,
    });
    const opusCap = router.rtpCapabilities.codecs.find((c) => c.mimeType.toLowerCase() === 'audio/opus');
    if (!opusCap) throw new Error('router_has_no_opus_codec');
    const ssrc = crypto.randomInt(1, 0xfffffffe);
    const producer = await transport.produce({
      kind: 'audio',
      rtpParameters: {
        codecs: [{
          mimeType: 'audio/opus',
          payloadType: opusCap.preferredPayloadType,
          clockRate: 48000,
          channels: 2,
          parameters: {},
          rtcpFeedback: [],
        }],
        encodings: [{ ssrc }],
      },
      appData: { producerOdaId: 'ai-peer', mediaType: 'audio', isAiPeer: true },
    });
    return { transport, producer, port: transport.tuple.localPort, payloadType: opusCap.preferredPayloadType, ssrc };
  }

  // createSpeakProducer'in video karsiligi: konusan-avatar animasyonu icin
  // AYNI "her utterance icin taze producer" deseni (yukaridaki yorum) - VP8
  // secildi cunku ffmpeg'in libvpx encoder'i H264 profil/seviye uyusmazligi
  // riski olmadan dogrudan calisiyor.
  async function createSpeakVideoProducer(router) {
    const transport = await router.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: true,
      comedia: true,
    });
    const vp8Cap = router.rtpCapabilities.codecs.find((c) => c.mimeType.toLowerCase() === 'video/vp8');
    if (!vp8Cap) throw new Error('router_has_no_vp8_codec');
    const ssrc = crypto.randomInt(1, 0xfffffffe);
    const producer = await transport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [{
          mimeType: 'video/VP8',
          payloadType: vp8Cap.preferredPayloadType,
          clockRate: 90000,
          parameters: {},
          rtcpFeedback: [],
        }],
        encodings: [{ ssrc }],
      },
      appData: { producerOdaId: 'ai-peer', mediaType: 'video', isAiPeer: true },
    });
    return { transport, producer, port: transport.tuple.localPort, payloadType: vp8Cap.preferredPayloadType, ssrc };
  }

  function announceAiProducer(roomId, producer, fakeSocketId) {
    conferenceNsp.to(roomId).emit('sfu:new-producer', {
      producerId: producer.id,
      producerSocketId: fakeSocketId,
      socketId: fakeSocketId,
      userId: 'ai-peer',
      kind: producer.kind,
      appData: producer.appData,
    });
    conferenceNsp.to(roomId).emit('newProducer', {
      producerId: producer.id,
      socketId: fakeSocketId,
      kind: producer.kind,
    });
  }

  // ---------------------------------------------------------------------
  // SPEAK side: encode a TTS audio buffer to RTP and send it through a FRESH
  // producer for this utterance (see createSpeakProducer for why fresh, not
  // reused). The previous utterance's producer/transport are closed first.
  // Alongside the audio, also generates+sends a simple RMS-driven "talking
  // avatar" video track (see createSpeakVideoProducer / sendTalkingVideoRtp)
  // - best-effort: any failure there is logged and swallowed so audio never
  // depends on video working.
  // ---------------------------------------------------------------------
  async function speak(peerState, audioBuffer) {
    const { roomId, room } = peerState;
    const inputPath = path.join(TMP_DIR, `speak-in-${roomId}-${Date.now()}.mp3`);
    await fs.promises.writeFile(inputPath, audioBuffer);

    peerState.state = 'speaking';
    let fresh = null;
    let freshVideo = null;
    let frameKeys = null;
    try {
      fresh = await createSpeakProducer(room.router);

      // Eski utterance'in producer/transport'unu kapat, yenisiyle degistir.
      const oldProducer = peerState.speakProducer;
      const oldTransport = peerState.speakTransport;
      peerState.speakTransport = fresh.transport;
      peerState.speakProducer = fresh.producer;
      peerState.speakPort = fresh.port;
      peerState.speakPayloadType = fresh.payloadType;
      peerState.speakSsrc = fresh.ssrc;

      try {
        await ensureAvatarFrames();
        const pcm = await decodePcm16(inputPath, 16000);
        frameKeys = buildMouthFrameSequence(pcm);
        freshVideo = await createSpeakVideoProducer(room.router);
      } catch (videoErr) {
        log.error(`[${roomId}] dudak animasyonu hazirlanamadi, sadece ses ile devam: ${videoErr.message}`);
        freshVideo = null;
      }

      const oldVideoProducer = peerState.speakVideoProducer;
      const oldVideoTransport = peerState.speakVideoTransport;
      if (freshVideo) {
        peerState.speakVideoProducer = freshVideo.producer;
        peerState.speakVideoTransport = freshVideo.transport;
      }

      const fakePeerEntry = room.peers.get(peerState.fakeSocketId);
      if (fakePeerEntry) {
        const producers = [fresh.producer];
        const transports = [peerState.listenTransport, fresh.transport];
        if (freshVideo) {
          producers.push(freshVideo.producer);
          transports.push(freshVideo.transport);
        }
        fakePeerEntry.producers = producers;
        fakePeerEntry.transports = transports;
      }

      announceAiProducer(roomId, fresh.producer, peerState.fakeSocketId);
      if (freshVideo) announceAiProducer(roomId, freshVideo.producer, peerState.fakeSocketId);

      try { oldProducer && oldProducer.close(); } catch (_) {}
      try { oldTransport && oldTransport.close(); } catch (_) {}
      try { oldVideoProducer && oldVideoProducer.close(); } catch (_) {}
      try { oldVideoTransport && oldVideoTransport.close(); } catch (_) {}

      const sendAudio = new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-y', '-re', '-i', inputPath,
          '-c:a', 'libopus', '-ar', '48000', '-ac', '2',
          '-payload_type', String(fresh.payloadType),
          '-ssrc', String(fresh.ssrc),
          '-f', 'rtp', `rtp://127.0.0.1:${fresh.port}`,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        ff.stderr.on('data', (d) => { stderr += d.toString(); });
        ff.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`speak ffmpeg exited ${code}: ${stderr.slice(-500)}`));
        });
        ff.on('error', reject);
      });

      const sendVideo = freshVideo
        ? sendTalkingVideoRtp(frameKeys, freshVideo.port, freshVideo.payloadType, freshVideo.ssrc)
            .catch((e) => log.error(`[${roomId}] dudak animasyonu gonderilemedi: ${e.message}`))
        : Promise.resolve();

      await Promise.all([sendAudio, sendVideo]);
    } catch (e) {
      log.error(`[${roomId}] speak() failed: ${e.message}`);
    } finally {
      fs.promises.unlink(inputPath).catch(() => {});
      if (!peerState.stopped) peerState.state = 'listening';
    }
  }

  // ---------------------------------------------------------------------
  // Turn pipeline: WAV segment -> Whisper -> LLM -> TTS -> speak().
  // ---------------------------------------------------------------------
  async function handleTurn(peerState, wavPath) {
    const { roomId } = peerState;
    try {
      const stat = await fs.promises.stat(wavPath).catch(() => null);
      if (!stat || stat.size < 8000) return; // near-empty segment, skip (no real speech)

      peerState.state = 'transcribing';
      const form = new (require('form-data'))();
      form.append('file', fs.createReadStream(wavPath), { filename: 'turn.wav' });
      form.append('language', 'tr');
      const transcribePromise = axios.post(`${AI_SERVICE_INTERNAL_URL}/transcribe`, form, {
        headers: aiServiceHeaders(form.getHeaders()),
        timeout: 30000,
      });
      // Duygu ipucu, transkripsiyonla AYNI ANDA hazirlaniyor (ek gecikme
      // eklememek icin) - kisa bir zaman siniri var, yetismezse sessizce
      // atlanir, ana yanit akisini asla bekletmez/engellemez.
      const emotionHintPromise = gatherEmotionHint(peerState, wavPath).catch(() => null);

      const transcribeRes = await transcribePromise;
      const text = (transcribeRes.data && transcribeRes.data.text || '').trim();
      if (!text) {
        peerState.state = 'listening';
        return;
      }
      log.info(`[${roomId}] duyulan: "${text}"`);

      peerState.state = 'thinking';
      const emotionHint = await Promise.race([
        emotionHintPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 500)),
      ]);

      let answer = '';
      if (peerState.authToken) {
        // Bu katilimci "AI Psikolog" ekraninin Goruntulu butonundan baslatildi
        // ve kullanicinin kendi JWT'si var - terapi_ai/server'in
        // /ai-psychologist/chat'ini cagirarak metin/sesli sohbetle AYNI
        // gecmisi (AIConversationMessage), seviyeyi ve profil ozetini
        // kullaniyoruz, boylece bu gorusme de kalici hafizaya isleniyor.
        const chatRes = await axios.post(`${TERAPI_AI_BACKEND_URL}/ai-psychologist/chat`, {
          message: text,
          ...(emotionHint ? { emotionHint } : {}),
        }, { timeout: 30000, headers: { Authorization: `Bearer ${peerState.authToken}` } });
        answer = (chatRes.data && chatRes.data.answer || '').trim();
      } else {
        // authToken yoksa (eski/kimliksiz cagri) eski davranisa geri don:
        // tensorflow_api'nin kendi /psychology/chat'i, sadece bu gorusme
        // suresince yasayan bellek-ici gecmisle.
        const chatRes = await axios.post(`${AI_SERVICE_INTERNAL_URL}/psychology/chat`, {
          message: text,
          history: peerState.history.slice(-10),
          level: 1,
          ...(emotionHint ? { emotionHint } : {}),
        }, { timeout: 30000, headers: aiServiceHeaders() });
        answer = (chatRes.data && chatRes.data.answer || '').trim();
        peerState.history.push({ text, isUser: true });
        peerState.history.push({ text: answer, isUser: false });
      }
      if (!answer) {
        peerState.state = 'listening';
        return;
      }
      log.info(`[${roomId}] cevap: "${answer.slice(0, 120)}"`);

      const speakRes = await axios.post(`${AI_SERVICE_INTERNAL_URL}/speak`, {
        text: answer,
        format: 'mp3',
      }, { timeout: 30000, responseType: 'arraybuffer', headers: aiServiceHeaders() });

      if (peerState.stopped) return;
      await speak(peerState, Buffer.from(speakRes.data));
    } catch (e) {
      log.error(`[${roomId}] handleTurn hatasi: ${e.message}`);
      if (!peerState.stopped) peerState.state = 'listening';
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------
  // LISTEN side: spawn one ffmpeg receiver per turn. It records the human's
  // audio to a WAV file AND watches its own stderr for silencedetect
  // boundaries to know when the turn is over.
  // ---------------------------------------------------------------------
  function startListenTurn(peerState) {
    if (peerState.stopped) return;
    if (peerState.state === 'speaking' || peerState.state === 'thinking' || peerState.state === 'transcribing') {
      // Don't start listening for a new turn while we're mid-response;
      // re-check shortly. Keeps us from racing our own reply.
      peerState.listenRetryTimer = setTimeout(() => startListenTurn(peerState), 500);
      return;
    }
    peerState.state = 'listening';

    const wavPath = path.join(TMP_DIR, `turn-${peerState.roomId}-${Date.now()}.wav`);
    const ff = spawn('ffmpeg', [
      '-y', '-protocol_whitelist', 'file,udp,rtp',
      '-i', peerState.listenSdpPath,
      '-af', `silencedetect=noise=${SILENCE_NOISE_DB}:d=${SILENCE_MIN_SEC}`,
      '-ar', '16000', '-ac', '1',
      '-t', String(MAX_TURN_SEC),
      wavPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    peerState.listenProcess = ff;
    let sawSpeechBeforeSilence = false;
    let stderrTail = '';

    ff.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail += text;
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);

      const startMatch = text.match(/silence_start:\s*([\d.]+)/);
      if (startMatch && parseFloat(startMatch[1]) >= MIN_TURN_SEC) {
        sawSpeechBeforeSilence = true;
      }
      const endMatch = text.match(/silence_end:\s*([\d.]+)/);
      if (endMatch && sawSpeechBeforeSilence) {
        // Real end-of-turn: stop this receiver early, hand the WAV off.
        sawSpeechBeforeSilence = false; // avoid double-trigger from buffered output
        try { ff.kill('SIGINT'); } catch (_) {}
      }
    });

    ff.on('close', () => {
      if (peerState.listenProcess === ff) peerState.listenProcess = null;
      if (peerState.stopped) {
        fs.promises.unlink(wavPath).catch(() => {});
        return;
      }
      handleTurn(peerState, wavPath).catch((e) => log.error(`[${peerState.roomId}] handleTurn: ${e.message}`));
      // Next turn's receiver starts once this one has fully closed - the
      // mediasoup consumer itself never stops, so no RTP is lost between
      // receivers beyond the brief process-spawn gap.
      startListenTurn(peerState);
    });
    ff.on('error', (e) => {
      log.error(`[${peerState.roomId}] listen ffmpeg error: ${e.message}`);
    });
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  async function joinRoom(roomId, { authToken } = {}) {
    if (activePeers.has(roomId)) return { alreadyJoined: true, roomId };

    // The caller (e.g. a mobile client) typically triggers this right after
    // its own 'room-joined' event, which can fire slightly before its audio
    // producer is actually registered server-side. Poll briefly instead of
    // failing on that race - up to ~10s for both the room and a human
    // producer to show up.
    let room = null;
    let humanProducer = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      room = rooms.get(roomId);
      if (room) {
        humanProducer = findHumanAudioProducer(room);
        if (humanProducer) break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!room) throw new Error(`room_not_found:${roomId}`);
    if (!humanProducer) throw new Error('no_human_audio_producer_in_room');
    const router = room.router;

    const fakeSocketId = `ai-peer-${crypto.randomUUID()}`;
    const peerState = {
      roomId,
      room,
      fakeSocketId,
      state: 'idle',
      stopped: false,
      history: [],
      authToken: authToken || '',
      listenProcess: null,
      listenRetryTimer: null,
    };

    // --- Listen transport: mirrors the live-HLS PlainTransport.consume()
    // pattern exactly (Server.js startLiveHlsForRoom) - proven, low risk.
    const listenTransport = await router.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: true,
      comedia: false,
    });
    const listenPort = allocPort();
    await listenTransport.connect({ ip: '127.0.0.1', port: listenPort });
    const listenConsumer = await listenTransport.consume({
      producerId: humanProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });
    const listenCodec = listenConsumer.rtpParameters.codecs[0];
    const listenSdpPath = path.join(TMP_DIR, `listen-${roomId}.sdp`);
    await fs.promises.writeFile(
      listenSdpPath,
      buildConsumeSdp({
        port: listenPort,
        payloadType: listenCodec.payloadType,
        clockRate: listenCodec.clockRate,
        channels: listenCodec.channels || 2,
      }),
      'utf8'
    );
    await listenConsumer.resume();

    // --- (opsiyonel) Video listen transport: goruntulu gorusmede insanin
    // kamerasi JOIN ANINDA aciksa, turn basina tek kare yakalayip duygu-ipucu
    // icin kullaniyoruz. Audio'nun aksine burada agresif bir polling/retry
    // YOK - kamera join anindan sonra acilirsa bu oturumda ipucu ozelligi
    // devre disi kalir (dusuk riskli MVP icin kabul edilebilir bir sinirlama,
    // AI'nin cekirdek islevi - dinleme/cevap - buna baglii degil).
    let listenVideoTransport = null;
    let listenVideoConsumer = null;
    let listenVideoSdpPath = null;
    let listenVideoPort = null;
    try {
      const humanVideoProducer = findHumanVideoProducer(room);
      if (humanVideoProducer) {
        listenVideoTransport = await router.createPlainTransport({
          listenIp: { ip: '127.0.0.1', announcedIp: null },
          rtcpMux: true,
          comedia: false,
        });
        listenVideoPort = allocPort();
        await listenVideoTransport.connect({ ip: '127.0.0.1', port: listenVideoPort });
        listenVideoConsumer = await listenVideoTransport.consume({
          producerId: humanVideoProducer.id,
          rtpCapabilities: router.rtpCapabilities,
          paused: true,
        });
        const videoCodec = listenVideoConsumer.rtpParameters.codecs[0];
        listenVideoSdpPath = path.join(TMP_DIR, `listen-video-${roomId}.sdp`);
        await fs.promises.writeFile(
          listenVideoSdpPath,
          buildVideoConsumeSdp({
            port: listenVideoPort,
            payloadType: videoCodec.payloadType,
            mimeSubtype: videoCodec.mimeType.split('/')[1],
            clockRate: videoCodec.clockRate,
          }),
          'utf8'
        );
        await listenVideoConsumer.resume();
      }
    } catch (videoListenErr) {
      log.error(`[${roomId}] video listen kurulamadi, duygu ipucu bu oturumda devre disi: ${videoListenErr.message}`);
      try { listenVideoConsumer && listenVideoConsumer.close(); } catch (_) {}
      try { listenVideoTransport && listenVideoTransport.close(); } catch (_) {}
      if (listenVideoPort) { freePort(listenVideoPort); listenVideoPort = null; }
      listenVideoTransport = null;
      listenVideoConsumer = null;
      listenVideoSdpPath = null;
    }

    // --- Speak transport: fresh producer via the shared helper (see
    // createSpeakProducer's comment - a new producer per utterance is
    // required, comedia:true only ever accepts one source lifetime).
    const speak0 = await createSpeakProducer(router);

    peerState.listenTransport = listenTransport;
    peerState.listenConsumer = listenConsumer;
    peerState.listenSdpPath = listenSdpPath;
    peerState.listenPort = listenPort;
    peerState.listenVideoTransport = listenVideoTransport;
    peerState.listenVideoConsumer = listenVideoConsumer;
    peerState.listenVideoSdpPath = listenVideoSdpPath;
    peerState.listenVideoPort = listenVideoPort;
    peerState.speakTransport = speak0.transport;
    peerState.speakProducer = speak0.producer;
    peerState.speakPort = speak0.port;
    peerState.speakPayloadType = speak0.payloadType;
    peerState.speakSsrc = speak0.ssrc;

    // Register as a discoverable fake peer so peers who join AFTER the AI
    // see it via the normal getProducers() flow (ConferenceSocket.js).
    room.peers.set(fakeSocketId, {
      socket: null,
      isAiPeer: true,
      userId: 'ai-peer',
      socketId: fakeSocketId,
      userName: 'AI Katilimci',
      userAvatar: null,
      isAdmin: false,
      transports: [listenTransport, speak0.transport],
      producers: [speak0.producer],
      consumers: [listenConsumer],
    });

    // Announce to peers already in the room (mirrors ConferenceSocket.js's
    // produce() broadcast, using conferenceNsp since we have no real socket
    // to call socket.to() from).
    announceAiProducer(roomId, speak0.producer, fakeSocketId);

    activePeers.set(roomId, peerState);
    log.info(`[${roomId}] AI peer odaya katildi (listenPort=${listenPort}, speakPort=${peerState.speakPort})`);

    startListenTurn(peerState);

    return { ok: true, roomId, producerId: speak0.producer.id };
  }

  async function leaveRoom(roomId) {
    const peerState = activePeers.get(roomId);
    if (!peerState) return { ok: true, roomId, wasActive: false };

    peerState.stopped = true;
    if (peerState.listenRetryTimer) clearTimeout(peerState.listenRetryTimer);
    if (peerState.listenProcess) {
      try { peerState.listenProcess.kill('SIGKILL'); } catch (_) {}
    }

    try { peerState.listenConsumer && peerState.listenConsumer.close(); } catch (_) {}
    try { peerState.speakProducer && peerState.speakProducer.close(); } catch (_) {}
    try { peerState.listenTransport && peerState.listenTransport.close(); } catch (_) {}
    try { peerState.speakTransport && peerState.speakTransport.close(); } catch (_) {}
    try { peerState.speakVideoProducer && peerState.speakVideoProducer.close(); } catch (_) {}
    try { peerState.speakVideoTransport && peerState.speakVideoTransport.close(); } catch (_) {}
    try { peerState.listenVideoConsumer && peerState.listenVideoConsumer.close(); } catch (_) {}
    try { peerState.listenVideoTransport && peerState.listenVideoTransport.close(); } catch (_) {}
    freePort(peerState.listenPort);
    if (peerState.listenVideoPort) freePort(peerState.listenVideoPort);

    fs.promises.unlink(peerState.listenSdpPath).catch(() => {});
    if (peerState.listenVideoSdpPath) fs.promises.unlink(peerState.listenVideoSdpPath).catch(() => {});

    const room = rooms.get(roomId);
    if (room) room.peers.delete(peerState.fakeSocketId);

    activePeers.delete(roomId);
    log.info(`[${roomId}] AI peer odadan ayrildi`);
    return { ok: true, roomId, wasActive: true };
  }

  function isActive(roomId) {
    return activePeers.has(roomId);
  }

  return { joinRoom, leaveRoom, isActive };
};
