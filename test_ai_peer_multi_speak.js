// Izole test: "speak" tarafinin GERCEK production davranisini simule eder -
// AYNI producer'a, AYRI AYRI FFmpeg process'leriyle (her biri farkli/rastgele
// local port'tan) birden fazla kez RTP gonderme. comedia:true kullanirsak
// ikinci/ucuncu utterance kayboluyor mu, comedia:false + sabit local port
// kullanirsak hepsi geciyor mu - ikisini de olcuyoruz.
const mediasoup = require('mediasoup');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKDIR = __dirname;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1000)}`))));
    p.on('error', reject);
  });
}

async function makeTestTone(freq, outPath) {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`, '-ar', '48000', '-ac', '2', outPath]);
}

async function recordConsumerOutput(consumePort, consumerCodec, outPath, seconds) {
  const sdp = [
    'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=test', 'c=IN IP4 127.0.0.1', 't=0 0',
    `m=audio ${consumePort} RTP/AVP ${consumerCodec.payloadType}`,
    'a=rtcp-mux', `a=rtpmap:${consumerCodec.payloadType} opus/48000/2`, 'a=recvonly', '',
  ].join('\n');
  const sdpPath = path.join(WORKDIR, 'multi_speak_consume.sdp');
  fs.writeFileSync(sdpPath, sdp, 'utf8');
  const recorder = spawn('ffmpeg', ['-y', '-protocol_whitelist', 'file,udp,rtp', '-i', sdpPath, '-t', String(seconds), outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve) => recorder.on('close', resolve));
}

async function scenario(label, useComedia) {
  console.log(`\n=== SENARYO: ${label} (comedia=${useComedia}) ===`);
  const worker = await mediasoup.createWorker();
  const router = await worker.createRouter({
    mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
  });

  const produceTransport = await router.createPlainTransport({
    listenIp: { ip: '127.0.0.1', announcedIp: null },
    rtcpMux: true,
    comedia: useComedia,
  });

  let fixedLocalPort = null;
  if (!useComedia) {
    // Sabit bir local port sec, mediasoup'a "sadece buradan kabul et" de,
    // ve HER ffmpeg cagrisinda AYNI local porttan gondermeye zorla.
    fixedLocalPort = 45000 + Math.floor(Math.random() * 500);
    await produceTransport.connect({ ip: '127.0.0.1', port: fixedLocalPort });
  }

  const producePort = produceTransport.tuple.localPort;
  const payloadType = router.rtpCapabilities.codecs[0].preferredPayloadType;
  const ssrc = crypto.randomInt(1, 0xfffffffe);

  const producer = await produceTransport.produce({
    kind: 'audio',
    rtpParameters: {
      codecs: [{ mimeType: 'audio/opus', payloadType, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }],
      encodings: [{ ssrc }],
    },
  });

  const consumeTransport = await router.createPlainTransport({
    listenIp: { ip: '127.0.0.1', announcedIp: null }, rtcpMux: true, comedia: false,
  });
  const consumePort = 43000 + Math.floor(Math.random() * 500);
  await consumeTransport.connect({ ip: '127.0.0.1', port: consumePort });
  const consumer = await consumeTransport.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities, paused: true });
  await consumer.resume();

  // Iki FARKLI "utterance": iki ayri ton, iki ayri ffmpeg process'i (SIRAYLA, tipki gercek speak() gibi).
  const tone1 = path.join(WORKDIR, 'tone1.wav');
  const tone2 = path.join(WORKDIR, 'tone2.wav');
  await makeTestTone(300, tone1);
  await makeTestTone(900, tone2);

  async function sendUtterance(inputPath) {
    const args = [
      '-y', '-re', '-i', inputPath,
      '-c:a', 'libopus', '-ar', '48000', '-ac', '2',
      '-payload_type', String(payloadType),
      '-ssrc', String(ssrc),
    ];
    const url = fixedLocalPort
      ? `rtp://127.0.0.1:${producePort}?localrtpport=${fixedLocalPort}`
      : `rtp://127.0.0.1:${producePort}`;
    args.push('-f', 'rtp', url);
    await run('ffmpeg', args);
  }

  // Utterance 1 gonderilirken ayni anda kaydediciyi baslat.
  const out1 = path.join(WORKDIR, `out1_${label}.wav`);
  const rec1 = recordConsumerOutput(consumePort, consumer.rtpParameters.codecs[0], out1, 3);
  await new Promise((r) => setTimeout(r, 300));
  await sendUtterance(tone1);
  await rec1;

  await new Promise((r) => setTimeout(r, 500));

  // Utterance 2: YENI bir ffmpeg process (farkli ephemeral local port, fixedLocalPort disinda).
  const out2 = path.join(WORKDIR, `out2_${label}.wav`);
  const rec2 = recordConsumerOutput(consumePort, consumer.rtpParameters.codecs[0], out2, 3);
  await new Promise((r) => setTimeout(r, 300));
  await sendUtterance(tone2);
  await rec2;

  worker.close();

  const size1 = fs.existsSync(out1) ? fs.statSync(out1).size : 0;
  const size2 = fs.existsSync(out2) ? fs.statSync(out2).size : 0;
  console.log(`utterance1 kayit boyutu: ${size1} bytes ${size1 > 20000 ? '(SES VAR)' : '(SESSIZ/BOS)'}`);
  console.log(`utterance2 kayit boyutu: ${size2} bytes ${size2 > 20000 ? '(SES VAR)' : '(SESSIZ/BOS)'}`);

  [tone1, tone2, out1, out2].forEach((f) => fs.existsSync(f) && fs.unlinkSync(f));
  return { size1, size2 };
}

async function main() {
  const comediaResult = await scenario('comedia-true', true);
  const fixedResult = await scenario('comedia-false-fixed-port', false);

  console.log('\n=== SONUC ===');
  console.log('comedia:true  -> utterance1:', comediaResult.size1 > 20000 ? 'OK' : 'KAYIP', ' utterance2:', comediaResult.size2 > 20000 ? 'OK' : 'KAYIP');
  console.log('comedia:false -> utterance1:', fixedResult.size1 > 20000 ? 'OK' : 'KAYIP', ' utterance2:', fixedResult.size2 > 20000 ? 'OK' : 'KAYIP');
}

main().catch((e) => { console.error('TEST HATASI:', e); process.exit(1); });
