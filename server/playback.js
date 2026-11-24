'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomToken, HttpError, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } = require('./util');

const execFileAsync = promisify(execFile);
const SEGMENT_SECONDS = 4;
const audioStreams = item => JSON.parse(item.streams || '[]').filter(stream => stream.type === 'audio');

class PlaybackManager {
  constructor({ store, ffmpegDir, logger }) {
    this.store = store;
    this.db = store.db;
    this.ffmpegDir = ffmpegDir || '';
    this.logger = logger;
    this.sessions = new Map();
    this.semaphore = 0;
    this.waiting = [];
    this.encoders = null;
    this.ffmpeg = path.join(this.ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    this.cacheRoot = path.join(store.dataDir, 'cache', 'transcodes');
    fs.mkdirSync(this.cacheRoot, { recursive: true });
    this.cleanupTimer = setInterval(() => this.cleanup(), 30 * 60000);
    this.cleanupTimer.unref();
  }

  binary(name) {
    return path.join(this.ffmpegDir, process.platform === 'win32' ? `${name}.exe` : name);
  }

  async canEncode(encoder) {
    try {
      await execFileAsync(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'color=c=black:s=320x180:r=10:d=0.1', '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-'],
        { timeout: 12000, windowsHide: true });
      return true;
    } catch (error) {
      this.logger.warn(`Hardware encoder is advertised but not usable: ${encoder}`, { message: error.message.slice(0, 300) });
      return false;
    }
  }

  async availableEncoders() {
    if (this.encoders) return this.encoders;
    try {
      const { stdout } = await execFileAsync(this.ffmpeg, ['-hide_banner', '-encoders'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      const output = stdout.toLowerCase();
      const listed = {
        nvenc: output.includes('h264_nvenc'), qsv: output.includes('h264_qsv'), amf: output.includes('h264_amf'),
        software: output.includes('libx264')
      };
      const usable = {};
      for (const [name, encoder] of [['nvenc', 'h264_nvenc'], ['qsv', 'h264_qsv'], ['amf', 'h264_amf']]) {
        usable[name] = listed[name] ? await this.canEncode(encoder) : false;
      }
      usable.software = listed.software;
      this.encoders = usable;
    } catch (error) {
      this.logger.warn('Could not enumerate FFmpeg encoders', { message: error.message });
      this.encoders = { nvenc: false, qsv: false, amf: false, software: false };
    }
    return this.encoders;
  }

  async selectEncoder() {
    const settings = this.store.settings();
    const available = await this.availableEncoders();
    if (!settings.allowHardwareTranscoding || settings.transcodeMode === 'software') return { encoder: 'libx264', hardware: false };
    if (settings.hardwareEncoder && available[settings.hardwareEncoder]) return { encoder: `h264_${settings.hardwareEncoder}`, hardware: true };
    for (const name of ['nvenc', 'qsv', 'amf']) {
      if (available[name]) return { encoder: `h264_${name}`, hardware: true };
    }
    return { encoder: 'libx264', hardware: false };
  }

  directPlayDecision(item, profile = {}) {
    const codecs = new Set(profile.codecs || ['h264', 'aac', 'mp3']);
    const containers = new Set(profile.containers || ['mp4', 'm4v', 'mov', 'webm', 'mp3', 'flac', 'wav', 'ogg', 'opus', 'm4a']);
    const isAudio = item.type === 'song';
    const videoCompatible = isAudio || !item.videoCodec || codecs.has(String(item.videoCodec).toLowerCase());
    const audioCompatible = !item.audioCodec || codecs.has(String(item.audioCodec).toLowerCase());
    const containerCompatible = containers.has(item.container) || (item.container === 'm4a' && containers.has('mp4'));
    return { direct: videoCompatible && audioCompatible && containerCompatible, videoCompatible, audioCompatible, containerCompatible };
  }

  createSession(item, user, profile = {}) {
    const isAudio = item.type === 'song';
    const decision = this.directPlayDecision(item, profile);
    const streams = JSON.parse(item.streams || '[]');
    const audioStreams = streams.filter(stream => stream.type === 'audio');
    const requestedAudio = Number.isInteger(profile.audioStream) ? profile.audioStream : audioStreams[0]?.index;
    const audio = audioStreams.find(stream => stream.index === requestedAudio) || audioStreams[0];
    const audioRelative = audio ? audioStreams.indexOf(audio) : 0;
    const hlsRemuxSafe = (isAudio || item.videoCodec === 'h264') && (!item.audioCodec || ['aac', 'mp3', 'ac3'].includes(item.audioCodec));
    const directStream = !decision.direct && decision.videoCompatible && decision.audioCompatible && hlsRemuxSafe;
    const session = {
      id: randomToken(24), itemId: item.id, userId: user.id, profile, audioStream: audio?.index ?? null, audioRelative,
      direct: decision.direct, directStream,
      durationMs: item.runtimeMs, createdAt: Date.now(), lastAccess: Date.now(), reason: decision.direct ? 'Direct Play' :
        (!decision.videoCompatible ? 'Video codec is not supported by this browser' : !decision.audioCompatible ? 'Audio codec is not supported by this browser' : 'Container requires remuxing'),
      transcoded: !decision.direct && !directStream
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, 'Playback session has expired');
    session.lastAccess = Date.now();
    return session;
  }

  variants(session, item) {
    const audioOnly = item.type === 'song';
    if (audioOnly) return [{ name: 'audio', bandwidth: 192000, audioOnly: true, directStream: session.directStream }];
    if (session.directStream) return [{ name: 'source', bandwidth: Math.max(1000000, Math.round((item.fileBytes || 400000000) * 8 / Math.max(1, item.runtimeMs / 1000))), height: item.height || 720, directStream: true }];
    const maxHeight = item.height || 1080;
    const all = [
      { name: '1080', bandwidth: 8000000, height: 1080 },
      { name: '720', bandwidth: 4000000, height: 720 },
      { name: '480', bandwidth: 2000000, height: 480 },
      { name: '360', bandwidth: 1000000, height: 360 }
    ];
    const available = all.filter(variant => variant.height <= maxHeight);
    return (available.length ? available : [all[all.length - 1]]).map(variant => ({ ...variant }));
  }

  masterPlaylist(session, item) {
    const variants = this.variants(session, item);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const variant of variants) {
      const videoCodec = variant.audioOnly ? null : variant.directStream ? (item.videoCodec === 'h264' ? 'avc1.640028' : item.videoCodec === 'hevc' ? 'hvc1.1.6.L120.90' : item.videoCodec === 'vp9' ? 'vp09.00.31.08' : item.videoCodec) : 'avc1.640028';
      const audioCodec = variant.audioOnly || item.audioCodec ? (item.audioCodec === 'aac' ? 'mp4a.40.2' : item.audioCodec === 'mp3' ? 'mp3' : item.audioCodec) : null;
      const codecs = [videoCodec, audioCodec].filter(Boolean).join(',');
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth}${variant.audioOnly ? '' : `,RESOLUTION=${Math.round(variant.height * 16 / 9)}x${variant.height}`},CODECS="${codecs}"`);
      lines.push(`${variant.name}.m3u8`);
    }
    return lines.join('\n') + '\n';
  }

  variantPlaylist(session, item, quality) {
    const variant = this.variants(session, item).find(entry => entry.name === quality);
    if (!variant) throw new HttpError(404, 'Unknown quality variant');
    const duration = Math.max(0.1, (item.runtimeMs || 4000) / 1000);
    const count = Math.ceil(duration / SEGMENT_SECONDS);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-INDEPENDENT-SEGMENTS`];
    for (let index = 0; index < count; index++) {
      const remaining = duration - index * SEGMENT_SECONDS;
      lines.push(`#EXTINF:${Math.min(SEGMENT_SECONDS, remaining).toFixed(3)},`);
      lines.push(`${quality}/${index}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }

  async acquireSlot() {
    const max = Math.max(1, Number(this.store.settings().maxConcurrentTranscodes) || 2);
    if (this.semaphore < max) {
      this.semaphore++;
      return;
    }
    await new Promise(resolve => this.waiting.push(resolve));
  }

  releaseSlot() {
    const next = this.waiting.shift();
    if (next) next.resolve();
    else this.semaphore = Math.max(0, this.semaphore - 1);
  }

  segmentPath(session, quality, index) {
    return path.join(this.cacheRoot, session.id, quality, `${String(index).padStart(6, '0')}.ts`);
  }

  async segment(session, item, quality, index, userId) {
    const duration = (item.runtimeMs || 0) / 1000;
    if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(duration / SEGMENT_SECONDS)) throw new HttpError(404, 'Segment does not exist');
    const target = this.segmentPath(session, quality, index);
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await this.acquireSlot();
    let handle;
    try {
      const encoder = await this.selectEncoder();
      const variant = this.variants(session, item).find(entry => entry.name === quality);
      if (!variant) throw new HttpError(404, 'Unknown quality variant');
      const start = index * SEGMENT_SECONDS;
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(start), '-i', item.path, '-t', String(Math.min(SEGMENT_SECONDS, duration - start))];
      if (variant?.audioOnly) {
        args.push('-vn', '-map', `0:a:${session.audioRelative}`);
        if (variant.directStream) args.push('-c', 'copy');
        else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
      } else {
        args.push('-map', '0:v:0', '-map', `0:a:${session.audioRelative}${audioStreams(item).length ? '' : '?'}`);
      }
      if (variant?.directStream) {
        args.push('-c', 'copy');
      } else if (variant?.audioOnly) {
        args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
      } else {
        args.push('-c:v', encoder.encoder,
          ...(encoder.encoder === 'h264_amf' ? [] : ['-preset', encoder.hardware ? (encoder.encoder === 'h264_qsv' ? 'veryfast' : 'p4') : 'veryfast']),
          '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p', '-b:v', `${Math.round(variant.bandwidth * 0.88 / 1000)}k`,
          '-maxrate', `${Math.round(variant.bandwidth * 0.95 / 1000)}k`, '-bufsize', `${Math.round(variant.bandwidth * 1.8 / 1000)}k`,
          '-vf', `scale=force_original_aspect_ratio=decrease:w=${Math.round(variant.height * 16 / 9)}:h=${variant.height}:force_divisible_by=2`, '-g', '48', '-keyint_min', '24', '-sc_threshold', '0',
          '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
      }
      if (encoder.encoder === 'h264_nvenc') args.splice(args.indexOf('-c:v') + 2, 0, '-tune', 'hq');
      if (encoder.encoder === 'h264_amf') args.splice(args.indexOf('-c:v') + 2, 0, '-quality', 'speed');
      if (encoder.encoder === 'h264_qsv') args.splice(args.indexOf('-c:v') + 2, 0, '-look_ahead', '0');      args.push('-f', 'mpegts', '-y', temporary);
      handle = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      handle.stderr.on('data', chunk => { stderr += chunk.toString().slice(0, 8192); });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { handle.kill(); reject(new HttpError(504, 'Transcoding segment timed out')); }, 180000);
        handle.once('error', error => { clearTimeout(timer); reject(error); });
        handle.once('exit', code => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new HttpError(500, `FFmpeg could not decode this segment: ${stderr.slice(0, 300)}`));
        });
      });
      if (!fs.existsSync(temporary) || fs.statSync(temporary).size === 0) throw new HttpError(500, 'FFmpeg produced an empty segment');
      fs.renameSync(temporary, target);
      return target;
    } finally {
      if (handle && handle.exitCode === null) handle.kill();
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
      this.releaseSlot();
    }
  }

  async subtitle(item, streamIndex) {
    const streams = JSON.parse(item.streams || '[]');
    const stream = streams.find(entry => entry.type === 'subtitle' && String(entry.index) === String(streamIndex));
    if (!stream) throw new HttpError(404, 'Subtitle track not found');
    if (['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvdsub', 'pgssub'].includes(stream.codec)) throw new HttpError(415, 'This subtitle track is image-based and cannot be rendered as browser text');
    const key = `${item.id}-${streamIndex}-${stream.sidecar || 'embedded'}`;
    const target = path.join(this.store.dataDir, 'cache', 'subtitles', `${crypto.createHash('sha1').update(key).digest('hex')}.vtt`);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const input = stream.sidecar ? path.join(path.dirname(item.path), stream.sidecar) : item.path;
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-map', `0:s:${streams.filter(entry => entry.type === 'subtitle').indexOf(stream)}`, '-c:s', 'webvtt', '-f', 'webvtt', '-y', target];
      try {
        await execFileAsync(this.ffmpeg, args, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
      } catch (error) {
        try { fs.unlinkSync(target); } catch { /* ignore */ }
        throw new HttpError(422, 'This subtitle track could not be converted to WebVTT');
      }
    }
    return target;
  }

  async preview(item, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > (item.runtimeMs || 0) / 1000) throw new HttpError(400, 'Invalid preview position');
    const rounded = Math.round(seconds);
    const target = path.join(this.store.dataDir, 'cache', `${item.id}-preview-${rounded}.jpg`);
    if (fs.existsSync(target)) return target;
    await execFileAsync(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(rounded), '-i', item.path,
      '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', '-y', target], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    return target;
  }

  activeSessions() {
    let active = 0;
    for (const session of this.sessions.values()) if (Date.now() - session.lastAccess < 90000) active++;
    return active;
  }

  heartbeat(id) {
    const session = this.getSession(id);
    session.lastAccess = Date.now();
    return session;
  }

  async cleanup(force = false) {
    const cutoff = Date.now() - (force ? 0 : 6 * 3600000);
    for (const [id, session] of this.sessions) {
      if (session.lastAccess < cutoff) this.sessions.delete(id);
    }
    const limit = Math.max(0.5, Number(this.store.settings().transcodeCacheGB) || 2) * 1024 ** 3;
    const files = [];
    const walk = directory => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile()) {
          try { files.push({ path: fullPath, time: fs.statSync(fullPath).mtimeMs, size: fs.statSync(fullPath).size }); } catch { /* concurrent cleanup */ }
        }
      }
    };
    walk(this.cacheRoot);
    files.sort((a, b) => a.time - b.time);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= limit && file.time >= cutoff) continue;
      try { fs.unlinkSync(file.path); total -= file.size; } catch { /* in-use on Windows */ }
    }
    for (const session of this.sessions.keys()) {
      if (fs.existsSync(path.join(this.cacheRoot, session))) continue;
      this.sessions.delete(session);
    }
  }
}

module.exports = { PlaybackManager, SEGMENT_SECONDS };
