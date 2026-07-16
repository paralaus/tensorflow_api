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

module.exports = function initAiConferencePeer(io, { rooms, logInfo, logError }) {
  const conferenceNsp = io.of('/conference');
  const log = {
    info: logInfo || ((...a) => console.log('[ai-peer]', ...a)),
    error: logError || ((...a) => console.error('[ai-peer]', ...a)),
  };

  fs.mkdirSync(TMP_DIR, { recursive: true });

  const activePeers = new Map(); // roomId -> peerState

  // ---------------------------------------------------------------------
  // SPEAK side: encode a TTS audio buffer to RTP and send it through the
  // AI's already-registered producer. One short-lived ffmpeg sender per
  // utterance; the mediasoup producer/transport persist across turns.
  // ---------------------------------------------------------------------
  async function speak(peerState, audioBuffer) {
    const { speakPort, speakPayloadType, speakSsrc, roomId } = peerState;
    const inputPath = path.join(TMP_DIR, `speak-in-${roomId}-${Date.now()}.mp3`);
    await fs.promises.writeFile(inputPath, audioBuffer);

    peerState.state = 'speaking';
    try {
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-y', '-re', '-i', inputPath,
          '-c:a', 'libopus', '-ar', '48000', '-ac', '2',
          '-payload_type', String(speakPayloadType),
          '-ssrc', String(speakSsrc),
          '-f', 'rtp', `rtp://127.0.0.1:${speakPort}`,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        ff.stderr.on('data', (d) => { stderr += d.toString(); });
        ff.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`speak ffmpeg exited ${code}: ${stderr.slice(-500)}`));
        });
        ff.on('error', reject);
      });
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
      const transcribeRes = await axios.post(`${AI_SERVICE_INTERNAL_URL}/transcribe`, form, {
        headers: aiServiceHeaders(form.getHeaders()),
        timeout: 30000,
      });
      const text = (transcribeRes.data && transcribeRes.data.text || '').trim();
      if (!text) {
        peerState.state = 'listening';
        return;
      }
      log.info(`[${roomId}] duyulan: "${text}"`);

      peerState.state = 'thinking';
      const chatRes = await axios.post(`${AI_SERVICE_INTERNAL_URL}/chat`, {
        question: text,
        history: peerState.history.slice(-10),
        detailLevel: 'brief',
        context: {
          channelName: 'Canli konferans (sesli katilimci)',
        },
      }, { timeout: 30000, headers: aiServiceHeaders() });
      const answer = (chatRes.data && (chatRes.data.answer || chatRes.data.text) || '').trim();
      if (!answer) {
        peerState.state = 'listening';
        return;
      }
      peerState.history.push({ text, isUser: true });
      peerState.history.push({ text: answer, isUser: false });
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
  async function joinRoom(roomId) {
    if (activePeers.has(roomId)) return { alreadyJoined: true, roomId };

    const room = rooms.get(roomId);
    if (!room) throw new Error(`room_not_found:${roomId}`);
    const router = room.router;

    const humanProducer = findHumanAudioProducer(room);
    if (!humanProducer) throw new Error('no_human_audio_producer_in_room');

    const fakeSocketId = `ai-peer-${crypto.randomUUID()}`;
    const peerState = {
      roomId,
      fakeSocketId,
      state: 'idle',
      stopped: false,
      history: [],
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

    // --- Speak transport: NEW pattern (validated standalone before this
    // integration) - PlainTransport.produce(), comedia so we don't need to
    // pre-know ffmpeg's outbound source port.
    const speakTransport = await router.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: true,
      comedia: true,
    });
    const opusCap = router.rtpCapabilities.codecs.find((c) => c.mimeType.toLowerCase() === 'audio/opus');
    if (!opusCap) throw new Error('router_has_no_opus_codec');
    const speakSsrc = crypto.randomInt(1, 0xfffffffe);
    const speakProducer = await speakTransport.produce({
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
        encodings: [{ ssrc: speakSsrc }],
      },
      appData: { producerOdaId: 'ai-peer', mediaType: 'audio', isAiPeer: true },
    });

    peerState.listenTransport = listenTransport;
    peerState.listenConsumer = listenConsumer;
    peerState.listenSdpPath = listenSdpPath;
    peerState.listenPort = listenPort;
    peerState.speakTransport = speakTransport;
    peerState.speakProducer = speakProducer;
    peerState.speakPort = speakTransport.tuple.localPort;
    peerState.speakPayloadType = opusCap.preferredPayloadType;
    peerState.speakSsrc = speakSsrc;

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
      transports: [listenTransport, speakTransport],
      producers: [speakProducer],
      consumers: [listenConsumer],
    });

    // Announce to peers already in the room (mirrors ConferenceSocket.js's
    // produce() broadcast, using conferenceNsp since we have no real socket
    // to call socket.to() from).
    conferenceNsp.to(roomId).emit('sfu:new-producer', {
      producerId: speakProducer.id,
      producerSocketId: fakeSocketId,
      socketId: fakeSocketId,
      userId: 'ai-peer',
      kind: 'audio',
      appData: speakProducer.appData,
    });
    conferenceNsp.to(roomId).emit('newProducer', {
      producerId: speakProducer.id,
      socketId: fakeSocketId,
      kind: 'audio',
    });

    activePeers.set(roomId, peerState);
    log.info(`[${roomId}] AI peer odaya katildi (listenPort=${listenPort}, speakPort=${peerState.speakPort})`);

    startListenTurn(peerState);

    return { ok: true, roomId, producerId: speakProducer.id };
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
    freePort(peerState.listenPort);

    fs.promises.unlink(peerState.listenSdpPath).catch(() => {});

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
