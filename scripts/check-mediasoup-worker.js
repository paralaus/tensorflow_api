#!/usr/bin/env node
'use strict';

/**
 * Standalone preflight for the mediasoup SFU worker.
 *
 * `node scripts/check-mediasoup-worker.js` spawns one worker exactly the way
 * Server.js / ConferenceSocket.js do, with mediasoup's own logging forced on,
 * so the worker's stderr — normally swallowed by the `debug` module — ends up
 * in the output. Use it inside the container when the logs only show
 * `Error: [pid:NN, code:40, signal:null]`.
 *
 * Exit status: 0 when a worker starts, 1 when it does not.
 */

// Must be set BEFORE mediasoup is required: `debug` decides whether a
// namespace is enabled at the moment the namespace is created, and mediasoup
// creates its loggers at module load.
if (!process.env.DEBUG) {
  process.env.DEBUG = 'mediasoup*';
}

const fs = require('fs');
const os = require('os');
const mediasoup = require('mediasoup');
const { describeWorkerFailure } = require('../src/mediasoupWorkerError');

// Present in the worker binary only when DepLibUring.cpp was compiled in,
// i.e. when the worker was built (or downloaded prebuilt) with liburing
// support. Such a binary aborts with exit code 40 under Docker's default
// seccomp profile, which blocks the io_uring syscalls.
const LIBURING_MARKER = 'io_uring_queue_init() failed';

function workerHasLiburing(binPath) {
  try {
    return fs.readFileSync(binPath).includes(LIBURING_MARKER);
  } catch (err) {
    return null;
  }
}

async function main() {
  const minPort = parseInt(process.env.MEDIASOUP_MIN_PORT, 10) || 40000;
  const maxPort = parseInt(process.env.MEDIASOUP_MAX_PORT, 10) || 40100;
  const binPath = mediasoup.workerBin;
  const hasLiburing = workerHasLiburing(binPath);

  console.log('--- mediasoup worker preflight ---');
  console.log(`node            : ${process.version}`);
  console.log(`kernel          : ${os.release()} (liburing is enabled by the worker on kernel >= 6)`);
  console.log(`mediasoup       : ${mediasoup.version}`);
  console.log(`worker binary   : ${binPath}`);
  console.log(`  exists        : ${fs.existsSync(binPath)}`);
  console.log(`  liburing      : ${hasLiburing === null ? 'unknown (binary unreadable)' : hasLiburing}`);
  console.log(`rtc port range  : ${minPort}-${maxPort}`);
  console.log('----------------------------------');

  if (hasLiburing && parseInt(os.release(), 10) >= 6) {
    console.warn(
      '\nWARNING: this worker binary was built WITH liburing and the kernel is >= 6,\n' +
        'so it will try io_uring at startup. Under Docker\'s default seccomp profile\n' +
        'that fails and the worker exits with code 40. Rebuild the image with\n' +
        'MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true and\n' +
        'MESON_ARGS="-Dms_disable_liburing=true", or run the container with\n' +
        '--security-opt seccomp=unconfined.\n'
    );
  }

  let worker;

  try {
    worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: minPort,
      rtcMaxPort: maxPort,
    });
  } catch (err) {
    console.error(`\nFAILED: createWorker() rejected: ${err && err.message}`);
    console.error(`\n${describeWorkerFailure(err)}`);
    process.exit(1);
  }

  console.log(`\nOK: worker started [pid:${worker.pid}]`);

  // A router exercises the parts that only fail once the worker is running
  // (DTLS certificate, codec setup), so a green preflight means more than
  // "the process did not die instantly".
  const router = await worker.createRouter({
    mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
  });

  console.log(`OK: router created [id:${router.id}]`);

  worker.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFAILED:', err && err.stack ? err.stack : err);
  console.error(`\n${describeWorkerFailure(err)}`);
  process.exit(1);
});
