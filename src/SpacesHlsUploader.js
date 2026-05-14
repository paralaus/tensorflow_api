'use strict';

/**
 * SpacesHlsUploader
 * -----------------
 * Watches a local HLS output directory (where FFmpeg writes init.mp4 / seg_NNNNN.m4s /
 * index.m3u8) and mirrors every change to DigitalOcean Spaces (or any S3-compatible
 * bucket) so that downstream viewers can fetch segments from the CDN instead of the
 * droplet. This keeps the droplet bandwidth flat regardless of viewer count.
 *
 * Design notes:
 *  - `fs.watch` is used (no extra deps). It fires multiple events per write because
 *    FFmpeg uses `temp_file` + rename. We coalesce per-file via a small debounce.
 *  - One in-flight upload per file is enforced via a Map; if the file changes again
 *    while a PUT is in flight, we mark it dirty and re-upload after the PUT finishes.
 *    This is critical for `index.m3u8`, which rewrites every segment.
 *  - Playlists get short Cache-Control; segments are immutable and cached for a year.
 *  - Failures are logged but never throw — the local pipeline keeps running. If
 *    Spaces is down, viewers see CDN 404 but the droplet itself stays healthy.
 */

const fs = require('fs');
const path = require('path');
const { PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

const DEBOUNCE_MS = 150;
// Files we care about. Everything else (lock files, *.tmp, etc.) is ignored.
const TRACKED_EXT = new Set(['.m3u8', '.m4s', '.mp4', '.ts', '.vtt']);

function contentTypeFor(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (lower.endsWith('.m4s')) return 'video/iso.segment';
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.ts')) return 'video/mp2t';
    if (lower.endsWith('.vtt')) return 'text/vtt';
    return 'application/octet-stream';
}

function cacheControlFor(filename) {
    // Playlists must be re-fetched every cycle. Segments are content-addressed
    // (filename includes sequence number) and never rewritten, so we can let the
    // CDN cache them aggressively.
    if (filename.toLowerCase().endsWith('.m3u8')) {
        return 'public, max-age=1, stale-while-revalidate=2';
    }
    return 'public, max-age=31536000, immutable';
}

/**
 * @param {object} opts
 * @param {import('@aws-sdk/client-s3').S3} opts.s3       S3 client (already configured)
 * @param {string} opts.bucket                            Bucket name (e.g. 'hissechat')
 * @param {string} opts.localDir                          Directory FFmpeg writes into
 * @param {string} opts.keyPrefix                         e.g. 'live/<roomId>' (no trailing slash)
 * @param {(msg:string, meta?:any)=>void} [opts.logInfo]
 * @param {(msg:string, meta?:any)=>void} [opts.logError]
 */
function createSpacesHlsUploader(opts) {
    const { s3, bucket, localDir, keyPrefix } = opts;
    const logInfo = opts.logInfo || (() => {});
    const logError = opts.logError || (() => {});

    if (!s3 || !bucket || !localDir || !keyPrefix) {
        throw new Error('SpacesHlsUploader: missing required option');
    }

    const debounceTimers = new Map(); // filename -> Timeout
    const inFlight = new Map();       // filename -> Promise
    const dirty = new Set();          // filenames awaiting re-upload after current PUT
    let watcher = null;
    let stopped = false;
    let stats = { uploaded: 0, failed: 0, bytes: 0 };

    function keyFor(filename) {
        return `${keyPrefix.replace(/\/+$/, '')}/${filename}`;
    }

    async function uploadOnce(filename) {
        const absPath = path.join(localDir, filename);
        let body;
        try {
            body = await fs.promises.readFile(absPath);
        } catch (err) {
            // File deleted between debounce schedule and read — that's fine; FFmpeg
            // rolls old segments out of the playlist window. Don't log every miss.
            if (err.code !== 'ENOENT') {
                logError(`uploader read failed ${filename}: ${err.message}`);
            }
            return;
        }

        const cmd = new PutObjectCommand({
            Bucket: bucket,
            Key: keyFor(filename),
            Body: body,
            ContentType: contentTypeFor(filename),
            CacheControl: cacheControlFor(filename),
            ACL: 'public-read',
        });

        try {
            await s3.send(cmd);
            stats.uploaded += 1;
            stats.bytes += body.length;
        } catch (err) {
            stats.failed += 1;
            logError(`uploader PUT failed ${keyFor(filename)}: ${err.message}`);
        }
    }

    function scheduleUpload(filename) {
        if (stopped) return;
        const ext = path.extname(filename).toLowerCase();
        if (!TRACKED_EXT.has(ext)) return;

        const existingTimer = debounceTimers.get(filename);
        if (existingTimer) clearTimeout(existingTimer);

        const t = setTimeout(() => {
            debounceTimers.delete(filename);
            // If a PUT is already running for this file, just mark it dirty.
            if (inFlight.has(filename)) {
                dirty.add(filename);
                return;
            }
            const p = uploadOnce(filename).finally(() => {
                inFlight.delete(filename);
                if (dirty.delete(filename) && !stopped) {
                    // File changed again while we were uploading — redo.
                    scheduleUpload(filename);
                }
            });
            inFlight.set(filename, p);
        }, DEBOUNCE_MS);
        debounceTimers.set(filename, t);
    }

    function start() {
        try {
            watcher = fs.watch(localDir, { persistent: true }, (_event, filename) => {
                if (!filename) return;
                scheduleUpload(filename);
            });
            watcher.on('error', (err) => {
                logError(`uploader watcher error: ${err.message}`);
            });
            logInfo(`uploader started for ${localDir} -> s3://${bucket}/${keyPrefix}/`);
        } catch (err) {
            logError(`uploader start failed: ${err.message}`);
        }
    }

    async function stop() {
        if (stopped) return;
        stopped = true;
        try { if (watcher) watcher.close(); } catch (_) {}
        // Cancel pending debounces; they would race with stop.
        for (const t of debounceTimers.values()) clearTimeout(t);
        debounceTimers.clear();
        // Wait for in-flight PUTs to drain so we don't leak sockets.
        const pending = Array.from(inFlight.values());
        if (pending.length) {
            await Promise.allSettled(pending);
        }
        logInfo(`uploader stopped (uploaded=${stats.uploaded}, failed=${stats.failed}, bytes=${stats.bytes})`);
    }

    /** Delete every object under the room prefix. Use after a grace period so
     *  late viewers can finish playing the tail of the recording. */
    async function deleteRemote() {
        let ContinuationToken;
        let removed = 0;
        try {
            do {
                const list = await s3.send(new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: `${keyPrefix.replace(/\/+$/, '')}/`,
                    ContinuationToken,
                }));
                const objs = (list.Contents || []).map((o) => ({ Key: o.Key }));
                if (objs.length) {
                    await s3.send(new DeleteObjectsCommand({
                        Bucket: bucket,
                        Delete: { Objects: objs, Quiet: true },
                    }));
                    removed += objs.length;
                }
                ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
            } while (ContinuationToken);
            logInfo(`uploader remote cleanup done (removed=${removed})`);
        } catch (err) {
            logError(`uploader remote cleanup failed: ${err.message}`);
        }
    }

    start();
    return { stop, deleteRemote, getStats: () => ({ ...stats }) };
}

module.exports = { createSpacesHlsUploader };
