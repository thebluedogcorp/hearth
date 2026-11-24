'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.mov', '.avi', '.wmv', '.webm', '.mpg', '.mpeg', '.ts', '.m2ts', '.m4v', '.flv', '.3gp', '.ogv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.aac', '.alac', '.ogg', '.opus', '.wma', '.m4a', '.aiff', '.ape', '.mka']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt']);
const MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...SUBTITLE_EXTENSIONS]);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.flv': 'video/x-flv', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.opus': 'audio/opus', '.wma': 'audio/x-ms-wma', '.m4a': 'audio/mp4', '.aiff': 'audio/aiff', '.ape': 'audio/x-ape',
  '.mka': 'audio/x-matroska', '.srt': 'text/x-ssa; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/x-ssa; charset=utf-8', '.ssa': 'text/x-ssa; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function assert(condition, status, message, code) {
  if (!condition) throw new HttpError(status || 400, message || 'Invalid request', code);
}

function json(value, status = 200, headers = {}) {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }, body: JSON.stringify(value) };
}

function text(body, status = 200, headers = {}) {
  return { status, headers, body };
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function passwordHash(password) {
  const normalized = password.normalize('NFKC');
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(normalized, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function passwordVerify(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, salt, expected] = parts;
    const actual = crypto.scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), 64, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024
    });
    const expectedBuffer = Buffer.from(expected, 'base64url');
    return expectedBuffer.length === actual.length && crypto.timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

function cleanTitle(value) {
  return String(value || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripReleaseTags(value) {
  const spaced = String(value || '').replace(/[._]+/g, ' ');
  return cleanTitle(spaced.replace(/\s*(?:19|20)\d{2}.*$/g, '').replace(/\b(?:480p|720p|1080p|2160p|4k|x264|x265|h264|h265|hevc|bluray|web[- ]?dl|webrip|brrip|dvdrip|remux|extended|unrated|imax|proper|repack|audio|subtitles?)\b.*$/gi, ''));
}

function parseMediaName(filePath, libraryType) {
  const original = path.basename(filePath, path.extname(filePath));
  if (libraryType === 'music') {
    const track = original.match(/^(\d{1,3})[\s._-]+(.+)$/);
    const artist = cleanTitle(path.basename(path.dirname(path.dirname(filePath))));
    const album = cleanTitle(path.basename(path.dirname(filePath)));
    return { title: cleanTitle(track ? track[2] : original), artist, album, albumArtist: artist, track: track ? Number(track[1]) : null };
  }
  if (libraryType === 'tv') {
    const match = original.match(/^(.*?)[\s._-]+(?:S|Season)[\s._-]*(\d{1,2})[\s._-]*(?:E|Episode|X)[\s._-]*(\d{1,3})(?:[\s._-]+(.*))?$/i);
    if (match) {
      const year = original.match(/\(?((?:19|20)\d{2})\)?/);
      return {
        title: cleanTitle(match[1]), seasonNumber: Number(match[2]), episodeNumber: Number(match[3]),
        episodeTitle: cleanTitle(match[4] || ''), year: year ? Number(year[1]) : null
      };
    }
  }
  const yearMatches = [...original.matchAll(/(?:^|[\s(\[-])((?:19|20)\d{2})(?=[)\]\s._-]|$)/g)];
  const yearMatch = yearMatches.at(-1);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  let title;
  if (yearMatch) {
    title = yearMatch.index === 0
      ? stripReleaseTags(original.slice(yearMatch[0].length))
      : stripReleaseTags(original.slice(0, yearMatch.index));
    title = title.replace(/[\s(\[-]+$/, '');
  } else {
    title = stripReleaseTags(original);
  }
  return { title: title || cleanTitle(original), year };
}

function safeJoin(root, requested = '') {
  assert(typeof requested === 'string' && !requested.includes('\0'), 400, 'Invalid path');
  if (path.isAbsolute(requested) || /^[A-Za-z]:/.test(requested)) throw new HttpError(400, 'Absolute paths are not allowed');
  if (process.platform === 'win32' && /:/.test(requested)) throw new HttpError(400, 'Invalid path');
  const rootResolved = path.resolve(root);
  const candidate = path.resolve(rootResolved, requested);
  const relative = path.relative(rootResolved, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new HttpError(403, 'Path is outside the configured library');
  }
  return candidate;
}

async function assertRealPath(root, requested) {
  const candidate = safeJoin(root, requested);
  const [realRoot, realCandidate] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(candidate)]);
  const relative = path.relative(realRoot, realCandidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new HttpError(403, 'Path resolves outside the configured library');
  }
  return { candidate, realCandidate, realRoot };
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'JSON object required');
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=/`, `HttpOnly`, 'SameSite=Strict'];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function clientAddress(req) {
  let address = req.socket.remoteAddress || 'unknown';
  if (isLoopback(address) && req.headers['x-forwarded-for']) {
    address = String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return address;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function parseRange(header, size) {
  if (!header || size === 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header));
  if (!match || (!match[1] && !match[2])) throw new HttpError(416, 'Invalid byte range');
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1]) {
    const suffix = Number(match[2]);
    start = size - suffix;
    end = size - 1;
  }
  if (!Number.isFinite(start) || start < 0 || start >= size || end < start) {
    const error = new HttpError(416, 'Requested range is not satisfiable');
    error.headers = { 'Content-Range': `bytes */${size}` };
    throw error;
  }
  end = Math.min(end, size - 1);
  return { start, end };
}

function contentType(filePath) {
  return MIME_TYPES[String(path.extname(filePath)).toLowerCase()] || 'application/octet-stream';
}

function sendFile(res, filePath, req, options = {}) {
  const stat = options.stat || fs.statSync(filePath);
  const type = options.contentType || contentType(filePath);
  const range = parseRange(req.headers.range, stat.size);
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl || 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ...(options.headers || {})
  };
  if (range) {
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(options.head ? 200 : 200, { ...headers, 'Content-Length': stat.size });
  }
  if (req.method === 'HEAD' || options.head) {
    res.end();
    return;
  }
  if (stat.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', error => {
    if (!res.destroyed) res.destroy(error);
  });
  stream.pipe(res);
  res.on('close', () => stream.destroy());
}

function safeName(value, fallback = 'media') {
  return String(value || fallback).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 160);
}

function encodePathSegments(value) {
  return value.split(path.sep).map(encodeURIComponent).join('/');
}

function normalizePath(filePath) {
  return path.resolve(filePath);
}

function isoNow() {
  return new Date().toISOString();
}

function publicUser(user) {
  return {
    id: user.id, username: user.username, role: user.role,
    allowedLibraries: JSON.parse(user.allowedLibraries || '[]'),
    canDownload: Boolean(user.canDownload), disabled: Boolean(user.disabled),
    createdAt: user.createdAt, lastLoginAt: user.lastLoginAt || null
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Timeout')), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function fetchJson(url, options = {}, ms = 20000) {
  const guard = timeoutSignal(ms);
  try {
    const response = await fetch(url, { ...options, signal: guard.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Upstream request failed (${response.status})`);
    return await response.json();
  } finally {
    guard.done();
  }
}

function sqlLike(value) {
  return `%${String(value).replace(/[%_\\]/g, '\\$&')}%`;
}

function decodeCursor(value) {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

module.exports = {
  VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, SUBTITLE_EXTENSIONS, MEDIA_EXTENSIONS, IMAGE_EXTENSIONS, MIME_TYPES,
  HttpError, assert, json, text, randomToken, hashToken, passwordHash, passwordVerify,
  cleanTitle, parseMediaName, safeJoin, assertRealPath, readJsonBody, parseCookies, cookie,
  clientAddress, isLoopback, parseRange, contentType, sendFile, safeName, encodePathSegments,
  normalizePath, isoNow, publicUser, parseJsonArray, timeoutSignal, fetchJson, sqlLike, decodeCursor
};
