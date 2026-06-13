'use strict';

require('dotenv').config();

const { Worker } = require('bullmq');
const os = require('os');
const {
    QUEUE_NAME,
    clearWorkerHeartbeat,
    getQueueConnection,
    isQueueEnabled,
    writeWorkerHeartbeat,
} = require('./src/jobs/mediaTranscodeQueue');
const {
    convertUrlToHls,
    transcodeAudioFromUrl,
} = require('./src/jobs/mediaTranscodeProcessor');

const concurrencyRaw = parseInt(process.env.MEDIA_TRANSCODE_WORKER_CONCURRENCY, 10);
const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? concurrencyRaw : 2;
const heartbeatIntervalMsRaw = parseInt(process.env.MEDIA_TRANSCODE_HEARTBEAT_INTERVAL_MS, 10);
const heartbeatIntervalMs = Number.isFinite(heartbeatIntervalMsRaw) && heartbeatIntervalMsRaw > 0
    ? heartbeatIntervalMsRaw
    : 15000;
const workerId = `${os.hostname()}:${process.pid}`;

if (!isQueueEnabled()) {
    console.error('[media-worker] REDIS_URL tanimli degil veya BullMQ yuklenemedi. Worker baslatilmadi.');
    process.exit(1);
}

const connection = getQueueConnection();
let heartbeatTimer = null;

async function heartbeat(extra = {}) {
    try {
        await writeWorkerHeartbeat(workerId, {
            pid: process.pid,
            host: os.hostname(),
            concurrency,
            ...extra,
        });
    } catch (err) {
        console.error('[media-worker] heartbeat error:', err && err.message ? err.message : err);
    }
}

const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
        await job.updateProgress({ stage: 'started', percent: 5 });

        if (job.name === 'hls-from-url') {
            await job.updateProgress({ stage: 'download-and-transcode', percent: 25 });
            const result = await convertUrlToHls(job.data || {});
            await job.updateProgress({ stage: 'uploaded', percent: 100 });
            return result;
        }

        if (job.name === 'audio-transcode-from-url') {
            await job.updateProgress({ stage: 'download-and-transcode', percent: 25 });
            const result = await transcodeAudioFromUrl(job.data || {});
            await job.updateProgress({ stage: 'uploaded', percent: 100 });
            return result;
        }

        throw new Error(`unknown_job:${job.name}`);
    },
    {
        connection,
        concurrency,
    },
);

worker.on('ready', () => {
    console.log(`[media-worker] ready queue=${QUEUE_NAME} concurrency=${concurrency}`);
    heartbeat({ state: 'ready' });
    heartbeatTimer = setInterval(() => {
        heartbeat({ state: 'running' });
    }, heartbeatIntervalMs);
});

worker.on('completed', (job) => {
    console.log(`[media-worker] completed job=${job.id} name=${job.name}`);
});

worker.on('failed', (job, err) => {
    console.error(
        `[media-worker] failed job=${job && job.id ? job.id : 'unknown'} name=${job && job.name ? job.name : 'unknown'}:`,
        err && err.message ? err.message : err,
    );
});

worker.on('error', (err) => {
    console.error('[media-worker] worker error:', err && err.message ? err.message : err);
});

async function shutdown(signal) {
    console.log(`[media-worker] shutting down (${signal})`);
    try {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        await clearWorkerHeartbeat(workerId);
    } catch (err) {
        console.error('[media-worker] heartbeat cleanup error:', err && err.message ? err.message : err);
    }
    try {
        await worker.close();
    } catch (err) {
        console.error('[media-worker] close error:', err && err.message ? err.message : err);
    }
    try {
        if (connection) {
            await connection.quit();
        }
    } catch (err) {
        console.error('[media-worker] redis quit error:', err && err.message ? err.message : err);
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
