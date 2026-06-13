'use strict';

const nodeCrypto = require('crypto');

let Queue;
let Job;
try {
    ({ Queue, Job } = require('bullmq'));
} catch (_err) {
    Queue = null;
    Job = null;
}

const IORedis = require('ioredis');

const QUEUE_NAME = String(process.env.MEDIA_TRANSCODE_QUEUE_NAME || 'media-transcode').trim();
const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const REQUIRE_QUEUE = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.MEDIA_TRANSCODE_REQUIRE_QUEUE || '').trim().toLowerCase(),
);
const HEARTBEAT_PREFIX = `${QUEUE_NAME}:worker:heartbeat:`;
const HEARTBEAT_TTL_SEC = (() => {
    const parsed = parseInt(process.env.MEDIA_TRANSCODE_HEARTBEAT_TTL_SEC, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 45;
})();
const HEARTBEAT_STALE_MS = (() => {
    const parsed = parseInt(process.env.MEDIA_TRANSCODE_HEALTH_STALE_MS, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 1000;
})();

let queue = null;
let queueConnection = null;

function isQueueEnabled() {
    return Boolean(Queue && Job && REDIS_URL);
}

function isQueueRequired() {
    return REQUIRE_QUEUE;
}

function canFallbackToMemory() {
    return !REQUIRE_QUEUE;
}

function getQueueConnection() {
    if (!isQueueEnabled()) {
        return null;
    }
    if (!queueConnection) {
        queueConnection = new IORedis(REDIS_URL, {
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            lazyConnect: false,
        });
        queueConnection.on('error', (err) => {
            console.error('[media-queue] redis error:', err && err.message);
        });
    }
    return queueConnection;
}

function getQueueAvailability() {
    return {
        enabled: isQueueEnabled(),
        required: isQueueRequired(),
        fallbackAllowed: canFallbackToMemory(),
        redisConfigured: Boolean(REDIS_URL),
        queueName: QUEUE_NAME,
    };
}

function assertQueueAvailable() {
    if (!isQueueEnabled() && isQueueRequired()) {
        const err = new Error('media_transcode_queue_required');
        err.code = 'media_transcode_queue_required';
        throw err;
    }
}

function getQueue() {
    if (!isQueueEnabled()) {
        return null;
    }
    if (!queue) {
        queue = new Queue(QUEUE_NAME, {
            connection: getQueueConnection(),
            defaultJobOptions: {
                removeOnComplete: false,
                removeOnFail: false,
                attempts: 2,
                backoff: {
                    type: 'exponential',
                    delay: 3000,
                },
            },
        });
    }
    return queue;
}

function newJobId() {
    return typeof nodeCrypto.randomUUID === 'function'
        ? nodeCrypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function enqueueTranscodeJob(name, payload, opts = {}) {
    assertQueueAvailable();
    const queueRef = getQueue();
    if (!queueRef) {
        return null;
    }
    const jobId = opts.jobId || newJobId();
    const job = await queueRef.add(name, payload, {
        jobId,
        removeOnComplete: false,
        removeOnFail: false,
    });
    return job;
}

function mapStateToStatus(state) {
    if (state === 'completed') return 'done';
    if (state === 'failed') return 'failed';
    if (state === 'active') return 'processing';
    if (state === 'waiting' || state === 'waiting-children' || state === 'delayed' || state === 'prioritized') {
        return 'queued';
    }
    return state || 'unknown';
}

async function getTranscodeJobStatus(jobId) {
    const queueRef = getQueue();
    if (!queueRef || !jobId) {
        return null;
    }
    const job = await Job.fromId(queueRef, jobId);
    if (!job) {
        return null;
    }
    const state = await job.getState();
    const progressValue = job.progress;
    const progress =
        typeof progressValue === 'number'
            ? { percent: progressValue }
            : (progressValue && typeof progressValue === 'object' ? progressValue : undefined);

    return {
        id: job.id,
        name: job.name,
        status: mapStateToStatus(state),
        createdAt: job.timestamp || null,
        startedAt: job.processedOn || null,
        finishedAt: job.finishedOn || null,
        progress,
        result: state === 'completed' ? job.returnvalue : undefined,
        error: state === 'failed' ? (job.failedReason || 'job_failed') : undefined,
        queue: 'bullmq',
    };
}

function getWorkerHeartbeatKey(workerId) {
    return `${HEARTBEAT_PREFIX}${workerId}`;
}

async function writeWorkerHeartbeat(workerId, payload = {}) {
    const connection = getQueueConnection();
    if (!connection || !workerId) {
        return false;
    }
    const value = JSON.stringify({
        workerId,
        queueName: QUEUE_NAME,
        ts: Date.now(),
        ...payload,
    });
    await connection.set(getWorkerHeartbeatKey(workerId), value, 'EX', HEARTBEAT_TTL_SEC);
    return true;
}

async function clearWorkerHeartbeat(workerId) {
    const connection = getQueueConnection();
    if (!connection || !workerId) {
        return false;
    }
    await connection.del(getWorkerHeartbeatKey(workerId));
    return true;
}

async function getWorkerHealth() {
    const availability = getQueueAvailability();
    if (!availability.enabled) {
        return {
            status: availability.required ? 'unhealthy' : 'disabled',
            workers: [],
            workerCount: 0,
            ...availability,
        };
    }

    const connection = getQueueConnection();
    const now = Date.now();
    const workers = [];
    let cursor = '0';

    do {
        const reply = await connection.scan(cursor, 'MATCH', `${HEARTBEAT_PREFIX}*`, 'COUNT', 100);
        cursor = reply[0];
        const keys = reply[1] || [];
        if (keys.length > 0) {
            const values = await connection.mget(keys);
            values.forEach((raw) => {
                if (!raw) return;
                try {
                    const parsed = JSON.parse(raw);
                    const ageMs = now - Number(parsed.ts || 0);
                    workers.push({
                        workerId: parsed.workerId || 'unknown',
                        pid: parsed.pid || null,
                        host: parsed.host || null,
                        ts: parsed.ts || null,
                        ageMs,
                        status: ageMs <= HEARTBEAT_STALE_MS ? 'healthy' : 'stale',
                    });
                } catch (_err) {}
            });
        }
    } while (cursor !== '0');

    workers.sort((a, b) => (a.ageMs || 0) - (b.ageMs || 0));
    const healthyCount = workers.filter((worker) => worker.status === 'healthy').length;

    return {
        status: healthyCount > 0 ? 'healthy' : 'unhealthy',
        workers,
        workerCount: workers.length,
        healthyCount,
        staleThresholdMs: HEARTBEAT_STALE_MS,
        ...availability,
    };
}

module.exports = {
    QUEUE_NAME,
    assertQueueAvailable,
    canFallbackToMemory,
    clearWorkerHeartbeat,
    getQueueConnection,
    getQueueAvailability,
    enqueueTranscodeJob,
    getTranscodeJobStatus,
    getWorkerHealth,
    getWorkerHeartbeatKey,
    isQueueEnabled,
    isQueueRequired,
    writeWorkerHeartbeat,
};
