'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseMediaName, cleanTitle, parseJsonArray, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } = require('./util');

const execFileAsync = promisify(execFile);

async function probeFile(filePath, ffmpegDir) {
  const ffprobe = path.join(ffmpegDir || '', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], {
    timeout: 30000, maxBuffer: 12 * 1024 * 1024, windowsHide: true
  });
  const data = JSON.parse(stdout);
  const streams = (data.streams || []).map(stream => ({
    index: stream.index, codec: stream.codec_name, type: stream.codec_type, language: stream.tags?.language || '',
    title: stream.tags?.title || '', channels: stream.channels, sampleRate: stream.sample_rate,
    width: stream.width, height: stream.height, bitRate: Number(stream.bit_rate) || null,
    disposition: stream.disposition || {}, codecLongName: stream.codec_long_name || ''
  }));
  const video = streams.find(stream => stream.type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find(stream => stream.type === 'audio');
  const format = data.format || {};
  return {
    streams,
    runtimeMs: Math.round((Number(format.duration) || 0) * 1000),
    width: video?.width || null, height: video?.height || null,
    videoCodec: video?.codec || null, audioCodec: audio?.codec || null,
    container: path.extname(filePath).slice(1).toLowerCase(),
    fileBytes: Number(format.size) || null
  };
}

function mediaId(libraryId, relativePath) {
  return crypto.createHash('sha1').update(`${libraryId}:${relativePath}`).digest('hex').slice(0, 24);
}

function findSidecars(filePath, basename = path.basename(filePath, path.extname(filePath))) {
  const directory = path.dirname(filePath);
  const subtitles = [];
  const images = { poster: null, backdrop: null };
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return { subtitles, images }; }
  const names = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
  for (const extension of ['.srt', '.ass', '.ssa', '.vtt']) {
    const candidate = `${basename}${extension}`;
    if (names.has(candidate)) subtitles.push({ index: 10000 + subtitles.length, type: 'subtitle', codec: extension.slice(1), language: '', sidecar: candidate, title: `External ${extension.slice(1).toUpperCase()}` });
  }
  const posterNames = [`${basename}-poster.jpg`, `${basename}.jpg`, 'poster.jpg', 'poster.png', 'folder.jpg', 'cover.jpg', 'cover.png'];
  const backdropNames = [`${basename}-fanart.jpg`, `${basename}-backdrop.jpg`, 'fanart.jpg', 'backdrop.jpg', 'background.jpg'];
  const existing = candidates => candidates.find(name => names.has(name));
  const poster = existing(posterNames);
  const backdrop = existing(backdropNames);
  if (poster) images.poster = path.join(directory, poster);
  if (backdrop) images.backdrop = path.join(directory, backdrop);
  return { subtitles, images };
}

class LibraryScanner {
  constructor({ store, ffmpegDir, metadata, logger }) {
    this.store = store;
    this.db = store.db;
    this.ffmpegDir = ffmpegDir;
    this.metadata = metadata;
    this.logger = logger;
    this.progress = { running: false, libraryId: null, processed: 0, discovered: 0, added: 0, updated: 0, removed: 0, errors: 0, startedAt: null };
    this.queue = Promise.resolve();
    this.thumbnailQueue = Promise.resolve();
  }

  enqueue(libraryId, options = {}) {
    const run = this.queue.then(() => this.scanLibrary(libraryId, options));
    this.queue = run.catch(error => this.logger.error('Scan queue task failed', { message: error.message }));
    return run;
  }

  enqueueThumbnail(item) {
    const run = this.thumbnailQueue.then(() => this.generateThumbnail(item)).catch(error => {
      this.logger.warn('Thumbnail generation failed', { item: item.title, message: error.message });
    });
    this.thumbnailQueue = run;
    return run;
  }

  async scanLibrary(libraryId, { full = false } = {}) {
    const library = this.db.prepare('SELECT * FROM libraries WHERE id = ?').get(libraryId);
    if (!library) throw new Error('Library not found');
    if (this.progress.running) throw new Error('Another scan is already running');
    const root = path.resolve(library.path);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      this.store.activity('error', `Library folder is unavailable: ${library.name}`, { path: root });
      throw new Error(`Library folder is unavailable: ${root}`);
    }
    Object.assign(this.progress, { running: true, libraryId: Number(libraryId), processed: 0, discovered: 0, added: 0, updated: 0, removed: 0, errors: 0, startedAt: new Date().toISOString() });
    this.store.activity('info', `Scan started: ${library.name}`, { libraryId: Number(libraryId), full });
    const seen = new Set();
    const pendingThumbnails = [];
    let batch = 0;
    try {
      const walk = async directory => {
        let entries;
        try { entries = await fs.promises.opendir(directory); } catch (error) {
          this.progress.errors++;
          this.logger.warn('Cannot read folder during scan', { path: directory, message: error.message });
          return;
        }
        for await (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const filePath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            await walk(filePath);
            continue;
          }
          if (!entry.isFile()) continue;
          if (entry.name.startsWith('.')) continue;
          const extension = path.extname(entry.name).toLowerCase();
          const isSubtitle = ['.srt', '.ass', '.ssa', '.vtt'].includes(extension);
          if (library.type !== 'files' && !isSubtitle && !this.extensionSupported(extension, library.type)) continue;
          if (library.type !== 'files' && isSubtitle) continue;
          const relativePath = path.relative(root, filePath);
          seen.add(relativePath);
          this.progress.discovered++;
          try {
            const result = await this.indexFile({ library, root, filePath, relativePath, full });
            if (result === 'added') this.progress.added++;
            else if (result === 'updated') this.progress.updated++;
            pendingThumbnails.push(result);
            this.progress.processed++;
            batch++;
            if (batch >= 20) {
              this.store.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
              batch = 0;
            }
          } catch (error) {
            this.progress.errors++;
            this.logger.warn('Could not index media file', { path: relativePath, message: error.message });
          }
        }
      };
      await walk(root);
      const missing = this.db.prepare('SELECT id, relativePath FROM media_items WHERE libraryId = ? AND missing = 0')
        .all(libraryId).filter(item => !seen.has(item.relativePath));
      if (missing.length) {
        const update = this.db.prepare('UPDATE media_items SET missing = 1, updatedAt = ? WHERE id = ?');
        const now = new Date().toISOString();
        this.store.transaction(() => missing.forEach(item => update.run(now, item.id)));
        this.progress.removed = missing.length;
        this.store.activity('warning', `${missing.length} missing file(s) detected in ${library.name}`, { libraryId: Number(libraryId) });
      }
      const now = new Date().toISOString();
      this.db.prepare('UPDATE libraries SET lastScanAt = ?, updatedAt = ? WHERE id = ?').run(now, now, libraryId);
      this.store.activity(this.progress.errors ? 'warning' : 'info', `Scan completed: ${library.name}`, {
        discovered: this.progress.discovered, added: this.progress.added, updated: this.progress.updated,
        missing: missing.length, errors: this.progress.errors
      });
    } catch (error) {
      this.store.activity('error', `Scan failed: ${library.name}`, { message: error.message });
      throw error;
    } finally {
      this.progress.running = false;
    }
    return { ...this.progress };
  }

  extensionSupported(extension, type) {
    if (type === 'movies') return VIDEO_EXTENSIONS.has(extension);
    if (type === 'tv') return VIDEO_EXTENSIONS.has(extension);
    if (type === 'music') return AUDIO_EXTENSIONS.has(extension) || extension === '.mka';
    return false;
  }

  async indexFile({ library, root, filePath, relativePath, full }) {
    const stat = await fs.promises.stat(filePath);
    const existing = this.db.prepare('SELECT * FROM media_items WHERE path = ?').get(filePath);
    if (existing && !full && !existing.missing && Number(existing.modifiedTime) === Math.trunc(stat.mtimeMs) && Number(existing.fileBytes) === stat.size) {
      this.db.prepare('UPDATE media_items SET lastScannedAt = ?, missing = 0 WHERE id = ?').run(new Date().toISOString(), existing.id);
      return 'unchanged';
    }
    const probed = library.type === 'files' ? {
      streams: [], runtimeMs: null, width: null, height: null, videoCodec: null, audioCodec: null,
      container: path.extname(filePath).slice(1).toLowerCase(), fileBytes: stat.size
    } : await probeFile(filePath, this.ffmpegDir);
    if (library.type !== 'files' && (!probed.runtimeMs || (!probed.videoCodec && !probed.audioCodec))) throw new Error('No decodable media streams found');
    const sidecars = library.type === 'files' ? { subtitles: [], images: {} } : findSidecars(filePath);
    const streams = [...probed.streams, ...sidecars.subtitles];
    const parsed = library.type === 'files' ? { title: cleanTitle(path.basename(filePath, path.extname(filePath))), year: null } : parseMediaName(filePath, library.type);
    const id = existing?.id || mediaId(library.id, relativePath);
    const now = new Date().toISOString();
    const showId = library.type === 'tv' ? crypto.createHash('sha1').update(`${library.id}:show:${parsed.title.toLowerCase()}`).digest('hex').slice(0, 24) : null;
    const values = {
      id, libraryId: library.id, type: library.type === 'tv' ? 'episode' : library.type === 'music' ? 'song' : library.type === 'files' ? 'file' : 'movie',
      path: filePath, relativePath, title: parsed.episodeTitle || parsed.title || cleanTitle(path.basename(filePath, path.extname(filePath))),
      sortTitle: (parsed.title || '').toLowerCase(), originalTitle: null, artist: parsed.artist || null, albumArtist: parsed.albumArtist || null,
      album: parsed.album || null, track: parsed.track || null, disc: parsed.disc || 1, year: parsed.year || null, overview: '',
      genres: '[]', tagline: '', rating: null, ratingCount: null, runtimeMs: probed.runtimeMs, width: probed.width, height: probed.height,
      videoCodec: probed.videoCodec, audioCodec: probed.audioCodec, container: probed.container, fileBytes: stat.size,
      modifiedTime: Math.trunc(stat.mtimeMs), streams: JSON.stringify(streams), externalId: existing?.externalId || null,
      metadataSource: existing?.metadataSource || 'filename', metadataJson: existing?.metadataJson || null,
      posterPath: sidecars.images.poster || existing?.posterPath || null, backdropPath: sidecars.images.backdrop || existing?.backdropPath || null,
      thumbPath: existing?.thumbPath || null, showId, showTitle: parsed.title || null, seasonNumber: parsed.seasonNumber || null,
      episodeNumber: parsed.episodeNumber || null, episodeTitle: parsed.episodeTitle || '', director: '', cast: '[]', studios: '[]',
      missing: 0, createdAt: existing?.createdAt || now, updatedAt: now, lastScannedAt: now
    };
    const columns = Object.keys(values);
    const update = columns.map(column => `${column} = excluded.${column}`).join(', ');
    this.db.prepare(`INSERT INTO media_items(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})
      ON CONFLICT(path) DO UPDATE SET ${update}`).run(...columns.map(column => values[column]));
    if (library.type === 'tv') {
      this.db.prepare(`INSERT INTO shows(id, libraryId, title, sortTitle, year, genres, createdAt, updatedAt)
        VALUES(?, ?, ?, ?, ?, '[]', ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, sortTitle = excluded.sortTitle, updatedAt = excluded.updatedAt`)
        .run(showId, library.id, parsed.title, parsed.title.toLowerCase(), parsed.year || null, now, now);
    }
    if (library.type === 'music') this.metadata.queueMusic(itemFromValues(values));
    else if (library.type !== 'files') this.metadata.queueVideo(itemFromValues(values));
    if (library.type !== 'music' && library.type !== 'files') pendingThumbnailsLocal(this, itemFromValues(values));
    return existing ? 'updated' : 'added';
  }

  async generateThumbnail(item) {
    if (!item?.path || !VIDEO_EXTENSIONS.has(path.extname(item.path).toLowerCase())) return;
    const cachePath = path.join(this.store.dataDir, 'cache', `${item.id}-thumb-v1.jpg`);
    if (fs.existsSync(cachePath) && item.thumbPath === cachePath) return;
    const seconds = Math.max(0, Math.min(10, (item.runtimeMs || 600000) / 1000 * 0.08));
    const ffmpeg = path.join(this.ffmpegDir || '', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', item.path,
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-y', cachePath], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
    this.db.prepare('UPDATE media_items SET thumbPath = ? WHERE id = ?').run(cachePath, item.id);
  }
}

function itemFromValues(values) {
  return { ...values, genres: parseJsonArray(values.genres), cast: [], studios: [] };
}

function pendingThumbnailsLocal(scanner, item) {
  scanner.enqueueThumbnail(item);
}

module.exports = { LibraryScanner, probeFile, findSidecars };
