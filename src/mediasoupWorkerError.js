'use strict';

/**
 * mediasoup runs its SFU in a separate native child process ("worker"). When
 * that process dies before it signals "running", the Node side only reports
 *
 *     Error: [pid:34, code:40, signal:null]
 *
 * The real reason is written by the worker to its stderr, which mediasoup
 * routes through the `debug` module (namespace `mediasoup:ERROR:Worker`).
 * `debug` is silent unless DEBUG is set, so on a plain production container
 * that explanation is thrown away and only the opaque exit code survives.
 *
 * This module maps those exit codes back to something actionable. The codes
 * are defined by the worker itself (mediasoup/worker/src/lib.cpp and
 * main.cpp):
 *
 *   40 -> "unknown error": a C++ exception escaped worker init or the run
 *         loop (DepLibUring / DepOpenSSL / DtlsTransport::ClassInit ...).
 *   41 -> the MEDIASOUP_VERSION env var was missing, i.e. the binary was
 *         started by something other than the mediasoup Node library.
 *   42 -> "settings error": the worker rejected its command line arguments
 *         (bad --rtcMinPort / --rtcMaxPort / --logLevel / --logTag ...).
 */

const DEBUG_HINT =
  'Run the process with DEBUG="mediasoup*" (or at least ' +
  'DEBUG="mediasoup:ERROR*,mediasoup:WARN*") to see the worker stderr line ' +
  'that states the real cause, and `node scripts/check-mediasoup-worker.js` ' +
  'inside the container for a standalone check.';

const EXIT_CODE_HINTS = {
  40: [
    'mediasoup-worker exited with code 40 ("unknown error"): it threw while',
    'initialising. In a container the usual cause is io_uring: the worker',
    'enables liburing whenever the running kernel is >= 6, but Docker\'s',
    'default seccomp profile blocks the io_uring_setup syscall, so',
    'io_uring_queue_init() fails with EPERM and the worker aborts.',
    '',
    'Fixes, in order of preference:',
    '  1. Build the worker without liburing (what this repo\'s Dockerfile',
    '     does): MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true and',
    '     MESON_ARGS="-Dms_disable_liburing=true" before `npm install`.',
    '     Rebuild the image without cache if it predates those lines, and',
    '     remember that mediasoup prebuilt binaries ship WITH liburing.',
    '  2. Or let the container use io_uring:',
    '     docker run --security-opt seccomp=unconfined ...',
    '',
    'Other possible code-40 causes: OpenSSL cannot generate the DTLS',
    'certificate (FIPS mode or a policy that forbids SHA1 signatures), or a',
    'libsrtp/usrsctp init failure.',
  ].join('\n'),
  41: [
    'mediasoup-worker exited with code 41: the MEDIASOUP_VERSION environment',
    'variable was missing. The worker binary was launched outside the',
    'mediasoup Node library — check MEDIASOUP_WORKER_BIN and any wrapper',
    'script that strips the environment.',
  ].join('\n'),
  42: [
    'mediasoup-worker exited with code 42 ("settings error"): the arguments',
    'passed to createWorker() were rejected. Check rtcMinPort / rtcMaxPort',
    '(they must be real numbers, min < max, inside 1024-65535), logLevel and',
    'logTags.',
  ].join('\n'),
};

/**
 * Pull the exit code out of the `[pid:34, code:40, signal:null]` message
 * mediasoup builds for worker failures. Returns null when the error is not
 * one of those (e.g. ENOENT because the worker binary is missing).
 */
function parseWorkerExitCode(err) {
  const message = err && err.message ? String(err.message) : String(err || '');
  const match = /code:(\d+)/.exec(message);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Human readable explanation for a failed createWorker() call, ready to be
 * printed next to the raw error.
 */
function describeWorkerFailure(err) {
  const code = parseWorkerExitCode(err);
  const hint = code !== null ? EXIT_CODE_HINTS[code] : null;

  if (hint) {
    return `${hint}\n\n${DEBUG_HINT}`;
  }

  if (err && err.code === 'ENOENT') {
    return (
      'mediasoup-worker binary could not be executed (ENOENT). Either the ' +
      'postinstall build never ran or MEDIASOUP_WORKER_BIN points at a file ' +
      `that does not exist.\n\n${DEBUG_HINT}`
    );
  }

  return (
    `mediasoup worker could not be spawned${code !== null ? ` (exit code ${code})` : ''}. ` +
    `\n\n${DEBUG_HINT}`
  );
}

module.exports = { describeWorkerFailure, parseWorkerExitCode, EXIT_CODE_HINTS };
