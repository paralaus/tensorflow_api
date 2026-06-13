'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { S3 } = require('@aws-sdk/client-s3');

function parseBooleanEnv(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseIntegerEnv(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT;
const SPACES_KEY = process.env.SPACES_KEY;
const SPACES_SECRET = process.env.SPACES_SECRET;
const SPACES_BUCKET = process.env.SPACES_BUCKET;
const SPACES_REGION = process.env.SPACES_REGION;

const HLS_SEGMENT_DURATION_SECONDS = parseIntegerEnv(process.env.HLS_SEGMENT_DURATION_SECONDS, 6);
const HLS_ENABLE_ABR = parseBooleanEnv(process.env.HLS_ENABLE_ABR, false);
const HLS_GENERATE_THUMBNAIL = parseBooleanEnv(process.env.HLS_GENERATE_THUMBNAIL, true);
const HLS_SEGMENT_TYPE =
    String(process.env.HLS_SEGMENT_TYPE || 'mpegts').trim().toLowerCase() === 'fmp4'
        ? 'fmp4'
        : 'mpegts';

let spacesClient = null;

function ensureDirectory(dirPath) {
    return fs.promises.mkdir(dirPath, { recursive: true });
}

function createTempDirectory(prefix) {
    const dirPath = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    return ensureDirectory(dirPath).then(() => dirPath);
}

function downloadFile(url, destinationPath) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const fileStream = fs.createWriteStream(destinationPath);

        const request = client.get(url, (response) => {
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

async function uploadFileToSpaces(filePath, key, contentType, cacheControl) {
    const client = getSpacesClient();
    if (!client) {
        throw new Error('Spaces configuration is missing');
    }
    const body = await fs.promises.readFile(filePath);
    const putParams = {
        Bucket: SPACES_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType || 'application/octet-stream',
        ACL: 'public-read',
    };
    if (cacheControl) {
        putParams.CacheControl = cacheControl;
    }
    await client.putObject(putParams);
    return getSpacesUrl(key);
}

async function listFilesRecursively(rootDir, currentDir = rootDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            const nestedFiles = await listFilesRecursively(rootDir, fullPath);
            files.push(...nestedFiles);
        } else if (entry.isFile()) {
            const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
            files.push({ fullPath, relativePath });
        }
    }
    return files;
}

function getHlsContentMetadata(relativePath) {
    const ext = path.extname(relativePath).toLowerCase();
    let contentType = 'application/octet-stream';
    let cacheControl = 'public, max-age=31536000, immutable';

    if (ext === '.m3u8') {
        contentType = 'application/vnd.apple.mpegurl';
        cacheControl = 'public, max-age=60';
    } else if (ext === '.ts') {
        contentType = 'video/MP2T';
    } else if (ext === '.m4s') {
        contentType = 'video/iso.segment';
    } else if (ext === '.mp4') {
        contentType = 'video/mp4';
    } else if (ext === '.jpg' || ext === '.jpeg') {
        contentType = 'image/jpeg';
    }

    return { contentType, cacheControl };
}

async function uploadHlsDirectoryToSpaces(dir, keyPrefix, artifact = {}) {
    const files = await listFilesRecursively(dir);
    const fileUrlMap = new Map();

    await Promise.all(
        files.map(async ({ fullPath, relativePath }) => {
            const { contentType, cacheControl } = getHlsContentMetadata(relativePath);
            const key = `${keyPrefix}/${relativePath}`;
            const fileUrl = await uploadFileToSpaces(fullPath, key, contentType, cacheControl);
            fileUrlMap.set(relativePath, fileUrl);
        }),
    );

    const playlistRelativePath = artifact.playlistRelativePath || 'index.m3u8';
    const masterPlaylistRelativePath = artifact.masterPlaylistRelativePath || null;
    const fallbackPlaylistRelativePath = artifact.fallbackPlaylistRelativePath || 'index.m3u8';
    const thumbnailRelativePath = artifact.thumbnailRelativePath || 'thumb.jpg';

    return {
        playlistUrl: fileUrlMap.get(playlistRelativePath) || null,
        masterPlaylistUrl: masterPlaylistRelativePath
            ? (fileUrlMap.get(masterPlaylistRelativePath) || null)
            : null,
        fallbackPlaylistUrl: fileUrlMap.get(fallbackPlaylistRelativePath) || null,
        thumbnailUrl: fileUrlMap.get(thumbnailRelativePath) || null,
    };
}

function parseFfmpegDuration(stderr) {
    if (!stderr) return null;
    const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (!match) return null;
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseFloat(match[3]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
        return null;
    }
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    return Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : null;
}

function runFfmpegHls(inputPath, outputDir, options = {}) {
    return new Promise((resolve, reject) => {
        const segmentDurationSeconds = Math.max(
            2,
            parseIntegerEnv(options.segmentDurationSeconds, HLS_SEGMENT_DURATION_SECONDS),
        );
        const forceKeyFramesExpr = `expr:gte(t,n_forced*${segmentDurationSeconds})`;
        const segmentType = options.segmentType === 'fmp4' ? 'fmp4' : 'mpegts';
        const enableAbr = Boolean(options.enableAbr);
        const segmentExt = segmentType === 'fmp4' ? 'm4s' : 'ts';
        let stderrBuffer = '';
        let args;
        let artifact;

        if (enableAbr) {
            // Named renditions in var_stream_map are written under v480p/v720p/v1080p.
            // Pre-create them so ffmpeg can write init/segment files immediately.
            for (const renditionName of ['480p', '720p', '1080p']) {
                fs.mkdirSync(path.join(outputDir, `v${renditionName}`), { recursive: true });
            }

            args = [
                '-y',
                '-i',
                inputPath,
                '-map',
                '0:v:0',
                '-map',
                '0:a:0',
                '-map',
                '0:v:0',
                '-map',
                '0:a:0',
                '-map',
                '0:v:0',
                '-map',
                '0:a:0',
                '-c:v',
                'libx264',
                '-preset',
                'veryfast',
                '-profile:v',
                'main',
                '-level',
                '4.0',
                '-pix_fmt',
                'yuv420p',
                '-sc_threshold',
                '0',
                '-force_key_frames',
                forceKeyFramesExpr,
                '-g',
                '48',
                '-keyint_min',
                '48',
                '-c:a',
                'aac',
                '-b:a',
                '128k',
                '-ac',
                '2',
                '-filter:v:0',
                'scale=-2:480',
                '-filter:v:1',
                'scale=-2:720',
                '-filter:v:2',
                'scale=-2:1080',
                '-b:v:0',
                '1000k',
                '-maxrate:v:0',
                '1070k',
                '-bufsize:v:0',
                '1500k',
                '-b:v:1',
                '2800k',
                '-maxrate:v:1',
                '2996k',
                '-bufsize:v:1',
                '4200k',
                '-b:v:2',
                '5000k',
                '-maxrate:v:2',
                '5350k',
                '-bufsize:v:2',
                '7500k',
                '-var_stream_map',
                'v:0,a:0,name:480p v:1,a:1,name:720p v:2,a:2,name:1080p',
                '-master_pl_name',
                'master.m3u8',
                '-hls_time',
                String(segmentDurationSeconds),
                '-hls_list_size',
                '0',
                '-hls_playlist_type',
                'vod',
                '-hls_flags',
                'independent_segments',
            ];

            if (segmentType === 'fmp4') {
                args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4');
            }

            args.push(
                '-hls_segment_filename',
                path.join(outputDir, 'v%v', `segment_%06d.${segmentExt}`),
                '-f',
                'hls',
                path.join(outputDir, 'v%v', 'index.m3u8'),
            );

            artifact = {
                playlistRelativePath: 'master.m3u8',
                masterPlaylistRelativePath: 'master.m3u8',
                fallbackPlaylistRelativePath: 'v0/index.m3u8',
                renditions: ['480p', '720p', '1080p'],
            };
        } else {
            args = [
                '-y',
                '-i',
                inputPath,
                '-c:v',
                'libx264',
                '-profile:v',
                'main',
                '-level',
                '4.0',
                '-preset',
                'veryfast',
                '-crf',
                '23',
                '-pix_fmt',
                'yuv420p',
                '-sc_threshold',
                '0',
                '-force_key_frames',
                forceKeyFramesExpr,
                '-c:a',
                'aac',
                '-b:a',
                '128k',
                '-ac',
                '2',
                '-movflags',
                '+faststart',
                '-start_number',
                '0',
                '-hls_time',
                String(segmentDurationSeconds),
                '-hls_list_size',
                '0',
                '-hls_playlist_type',
                'vod',
                '-hls_flags',
                'independent_segments',
            ];

            if (segmentType === 'fmp4') {
                args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4');
            }

            args.push(
                '-hls_segment_filename',
                path.join(outputDir, `segment_%06d.${segmentExt}`),
                '-f',
                'hls',
                path.join(outputDir, 'index.m3u8'),
            );

            artifact = {
                playlistRelativePath: 'index.m3u8',
                masterPlaylistRelativePath: null,
                fallbackPlaylistRelativePath: 'index.m3u8',
                renditions: ['single'],
            };
        }

        const ffmpeg = spawn('ffmpeg', args);

        ffmpeg.stderr.on('data', (data) => {
            stderrBuffer += data.toString();
        });

        ffmpeg.on('error', reject);

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                const durationSeconds = parseFfmpegDuration(stderrBuffer);
                resolve({
                    durationSeconds,
                    ...artifact,
                    segmentType,
                    abrEnabled: enableAbr,
                });
            } else {
                const trimmedStderr = String(stderrBuffer || '').trim();
                reject(new Error(`ffmpeg exited with code ${code}${trimmedStderr ? `: ${trimmedStderr}` : ''}`));
            }
        });
    });
}

function runFfmpegThumbnail(inputPath, outputPath, seekSeconds = 1) {
    return new Promise((resolve, reject) => {
        const args = [
            '-y',
            '-ss',
            String(Math.max(0, seekSeconds)),
            '-i',
            inputPath,
            '-frames:v',
            '1',
            '-q:v',
            '2',
            outputPath,
        ];

        const ffmpeg = spawn('ffmpeg', args);
        let stderrBuffer = '';

        ffmpeg.stderr.on('data', (data) => {
            stderrBuffer += data.toString();
        });

        ffmpeg.on('error', reject);
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve(true);
            } else {
                reject(new Error(`thumbnail ffmpeg exited with code ${code}: ${stderrBuffer}`));
            }
        });
    });
}

function runFfmpegAudioTranscode(inputPath, outputPath, bitrateKbps = 64) {
    return new Promise((resolve, reject) => {
        let stderrBuffer = '';
        const args = [
            '-y',
            '-i',
            inputPath,
            '-vn',
            '-c:a',
            'aac',
            '-b:a',
            `${bitrateKbps}k`,
            '-ac',
            '1',
            '-ar',
            '44100',
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            outputPath,
        ];

        const ffmpeg = spawn('ffmpeg', args);

        ffmpeg.stderr.on('data', (data) => {
            stderrBuffer += data.toString();
        });

        ffmpeg.on('error', reject);
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve({ durationSeconds: parseFfmpegDuration(stderrBuffer) });
            } else {
                reject(new Error(`ffmpeg exited with code ${code}`));
            }
        });
    });
}

async function convertUrlToHls({ url, channelId, messageId }) {
    const workDir = await createTempDirectory('hissechat-hls');
    const sourcePath = path.join(workDir, 'source.mp4');

    await downloadFile(url, sourcePath);

    const hlsDir = path.join(workDir, 'hls');
    await ensureDirectory(hlsDir);

    const hlsArtifact = await runFfmpegHls(sourcePath, hlsDir, {
        segmentDurationSeconds: HLS_SEGMENT_DURATION_SECONDS,
        segmentType: HLS_SEGMENT_TYPE,
        enableAbr: HLS_ENABLE_ABR,
    });

    if (HLS_GENERATE_THUMBNAIL) {
        try {
            await runFfmpegThumbnail(sourcePath, path.join(hlsDir, 'thumb.jpg'), 1);
            hlsArtifact.thumbnailRelativePath = 'thumb.jpg';
        } catch (_thumbErr) {}
    }

    const baseKey =
        channelId && messageId
            ? `hls/channel/${channelId}/${messageId}`
            : `hls/misc/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
        const uploadResult = await uploadHlsDirectoryToSpaces(hlsDir, baseKey, hlsArtifact);
        if (!uploadResult || !uploadResult.playlistUrl) {
            const err = new Error('hls_upload_failed');
            err.code = 'hls_upload_failed';
            throw err;
        }
        return {
            playlistUrl: uploadResult.playlistUrl,
            masterPlaylistUrl: uploadResult.masterPlaylistUrl,
            fallbackPlaylistUrl: uploadResult.fallbackPlaylistUrl,
            thumbnailUrl: uploadResult.thumbnailUrl,
            durationSeconds: hlsArtifact.durationSeconds,
            abrEnabled: hlsArtifact.abrEnabled,
            segmentType: hlsArtifact.segmentType,
            renditions: hlsArtifact.renditions,
        };
    } finally {
        try {
            await fs.promises.rm(workDir, { recursive: true, force: true });
        } catch (_cleanupError) {}
    }
}

async function transcodeAudioFromUrl({
    url,
    channelId,
    messageId,
    minDurationSeconds,
    minSizeBytes,
    bitrateKbps,
}) {
    let workDir;
    try {
        workDir = await createTempDirectory('hissechat-audio');
        const sourcePath = path.join(workDir, 'source.bin');
        const outputPath = path.join(workDir, 'out.m4a');

        await downloadFile(url, sourcePath);

        const sourceStat = await fs.promises.stat(sourcePath);
        const minDuration =
            typeof minDurationSeconds === 'number' && minDurationSeconds >= 0 ? minDurationSeconds : 30;
        const minSize =
            typeof minSizeBytes === 'number' && minSizeBytes >= 0 ? minSizeBytes : 256 * 1024;
        const bitrate =
            typeof bitrateKbps === 'number' && bitrateKbps >= 16 && bitrateKbps <= 320 ? bitrateKbps : 64;

        let originalDuration = null;
        try {
            const probeStderr = await new Promise((resolve, reject) => {
                const ff = spawn('ffmpeg', ['-i', sourcePath, '-f', 'null', '-']);
                let buf = '';
                ff.stderr.on('data', (d) => {
                    buf += d.toString();
                });
                ff.on('error', reject);
                ff.on('close', () => resolve(buf));
            });
            originalDuration = parseFfmpegDuration(probeStderr);
        } catch (_probeErr) {}

        if ((originalDuration !== null && originalDuration < minDuration) || sourceStat.size < minSize) {
            return {
                skipped: true,
                reason: 'below_threshold',
                durationSeconds: originalDuration,
                originalSize: sourceStat.size,
            };
        }

        const { durationSeconds } = await runFfmpegAudioTranscode(sourcePath, outputPath, bitrate);
        const outStat = await fs.promises.stat(outputPath);

        if (outStat.size >= sourceStat.size * 0.95) {
            return {
                skipped: true,
                reason: 'no_size_gain',
                durationSeconds: durationSeconds || originalDuration,
                originalSize: sourceStat.size,
                transcodedSize: outStat.size,
            };
        }

        const baseKey =
            channelId && messageId
                ? `audio/channel/${channelId}/${messageId}.m4a`
                : `audio/misc/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`;

        const newUrl = await uploadFileToSpaces(outputPath, baseKey, 'audio/mp4');

        return {
            skipped: false,
            url: newUrl,
            durationSeconds: durationSeconds || originalDuration,
            originalSize: sourceStat.size,
            transcodedSize: outStat.size,
        };
    } finally {
        if (workDir) {
            try {
                await fs.promises.rm(workDir, { recursive: true, force: true });
            } catch (_cleanupError) {}
        }
    }
}

module.exports = {
    convertUrlToHls,
    transcodeAudioFromUrl,
};
