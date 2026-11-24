'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Store } = require('./store');
const { Logger } = require('./logger');
const { MetadataService } = require('./metadata');
const { LibraryScanner } = require('./scanner');
const { PlaybackManager } = require('./playback');
const { RemoteAccess } = require('./remote');
const { streamZip, collect } = require('./zip');
const {
  HttpError, assert, json, text, randomToken, hashToken, passwordHash, passwordVerify, safeJoin, assertRealPath,
  readJsonBody, parseCookies, cookie, clientAddress, isLoopback, sendFile, contentType, isoNow,
  publicUser, parseJsonArray, sqlLike, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, safeName
} = require('./util');

const execFileAsync = promisify(execFile);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = '1.0.2';
const LIBRARY_TYPES = new Set(['movies', 'tv', 'music', 'files']);
const STATIC_FILES = new Set(['index.html', 'app.js', 'app.css', 'player.js', 'hls.min.js', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png']);

class HearthServer {
  constructor({ dataDir, ffmpegDir = '', cloudflared = '', setupToken }) {
    this.dataDir = dataDir;
    this.ffmpegDir = ffmpegDir;
    this.cloudflared = cloudflared;
    this.setupToken = setupToken;
    this.instanceId = randomToken(12);
    this.logger = new Logger(dataDir);
    this.store = new Store(dataDir, this.logger);
    this.metadata = new MetadataService({ store: this.store, logger: this.logger });
    this.scanner = new LibraryScanner({ store: this.store, ffmpegDir, metadata: this.metadata, logger: this.logger });
    this.playback = new PlaybackManager({ store: this.store, ffmpegDir, logger: this.logger });
    this.remote = new RemoteAccess({ store: this.store, logger: this.logger, cloudflared, portProvider: () => this.store.settings().port, instanceId: this.instanceId });
    this.rateBuckets = new Map();
    this.bytesPerSecond = 0;
    this.lastBytes = 0;
    this.lastCpu = os.cpus().map(cpu => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }));
    this.systemCpu = 0;
    this.startedAt = Date.now();
    this.bytesWritten = 0;
    this.dummyHash = passwordHash(randomToken(24));
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.requestTimeout = 300000;
    this.server.headersTimeout = 30000;
    this.server.keepAliveTimeout = 65000;
    this.server.on('clientError', (error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
    this.monitor = setInterval(() => this.monitorSystem(), 2000);
    this.monitor.unref();
  }

  async listen() {
    const settings = this.store.settings();
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(settings.port, settings.bindAddress, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.store.activity('info', 'Hearth server started', { address: settings.bindAddress, port: settings.port });
    await this.remote.initialize();
    if (this.store.isConfigured()) {
      setTimeout(() => this.autoScan(), 3000);
    }
    return this.server.address();
  }

  async autoScan() {
    const settings = this.store.settings();
    if (!settings.scanOnStartup) return;
    for (const library of this.store.db.prepare('SELECT * FROM libraries WHERE enabled = 1').all()) {
      if (!library.lastScanAt || Date.now() - new Date(library.lastScanAt).getTime() > 86400000) {
        this.scanner.enqueue(library.id).catch(error => this.logger.warn('Automatic scan failed', { message: error.message }));
      }
    }
  }

  monitorSystem() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    cpus.forEach((cpu, index) => {
      const previous = this.lastCpu[index] || { idle: 0, total: 0 };
      const currentTotal = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      idle += cpu.times.idle - previous.idle;
      total += currentTotal - previous.total;
      this.lastCpu[index] = { idle: cpu.times.idle, total: currentTotal };
    });
    if (total > 0) this.systemCpu = Math.max(0, Math.min(100, (1 - idle / total) * 100));
    const now = Date.now();
    const seconds = Math.max(0.25, (now - (this.lastMonitorAt || now - 2000)) / 1000);
    const current = this.bytesWritten;
    this.bytesPerSecond = Math.max(0, (current - this.lastBytes) / seconds);
    this.lastMonitorAt = now;
    this.lastBytes = current;
    if (this.rateBuckets.size > 10000) {
      for (const [key, bucket] of this.rateBuckets) if (bucket.reset < now) this.rateBuckets.delete(key);
    }
  }

  async handle(req, res) {
    this.bytesWritten = this.bytesWritten || 0;
    const originalWrite = res.write.bind(res);
    res.write = (chunk, ...args) => {
      if (chunk) this.bytesWritten += Buffer.byteLength(chunk);
      return originalWrite(chunk, ...args);
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204); res.end(); return;
      }
      const url = new URL(req.url, 'http://hearth.local');
      let body = {};
      if (['POST', 'PATCH', 'PUT'].includes(req.method) && !url.pathname.startsWith('/api/play/') || ['POST', 'PATCH', 'PUT'].includes(req.method) && ['/api/playback/'].some(prefix => url.pathname.startsWith(prefix))) {
        body = await readJsonBody(req);
      }
      const handled = await this.route(req, res, url, body);
      if (handled && !res.writableEnded) {
        if (handled.file) {
          sendFile(res, handled.file, req, handled.options || {});
        } else {
          const headers = { ...handled.headers };
          const responseBody = Buffer.isBuffer(handled.body) ? handled.body : String(handled.body ?? '');
          if (!headers['Content-Type'] && typeof handled.body === 'string') headers['Content-Type'] = 'text/plain; charset=utf-8';
          res.writeHead(handled.status || 200, { ...headers, 'Content-Length': responseBody.length });
          if (req.method === 'HEAD') res.end(); else res.end(responseBody);
        }
      }
    } catch (error) {
      if (res.destroyed) return;
      const status = error instanceof HttpError ? error.status : error.code === 'ENOENT' ? 404 : 500;
      if (status >= 500) this.logger.error('Request failed', { url: req.url, message: error.message, stack: error.stack });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const response = json({ error: error.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'), message: status >= 500 && !(error instanceof HttpError) ? 'The server could not complete this request' : error.message }, status, error.headers || {});
      res.writeHead(status, response.headers);
      res.end(req.method === 'HEAD' ? undefined : response.body);
    }
  }

  isSecureRequest(req) {
    if (req.socket.encrypted) return true;
    return isLoopback(req.socket.remoteAddress || '') && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  rateLimit(req, key, max, windowMs) {
    const now = Date.now();
    const bucketKey = `${clientAddress(req)}:${key}`;
    let bucket = this.rateBuckets.get(bucketKey);
    if (!bucket || bucket.reset < now) {
      bucket = { count: 0, reset: now + windowMs };
      this.rateBuckets.set(bucketKey, bucket);
    }
    bucket.count++;
    assert(bucket.count <= max, 429, 'Too many attempts. Try again later.', 'RATE_LIMITED');
  }

  authenticate(req) {
    const bearer = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{20,200})$/);
    const token = bearer ? bearer[1] : parseCookies(req).hearth_session;
    const session = this.store.getSession(token);
    if (session) {
      this.store.touchSession(session.sessionId);
      req.authBearer = Boolean(bearer);
      return session;
    }
    return null;
  }

  requireUser(req, admin = false) {
    const user = this.authenticate(req);
    assert(user, 401, 'Sign in to continue', 'UNAUTHORIZED');
    assert(!admin || user.role === 'admin', 403, 'Administrator permission required', 'FORBIDDEN');
    return user;
  }

  requireCsrf(req, user) {
    if (req.authBearer) return;
    assert(String(req.headers['x-csrf-token'] || '') === user.csrfToken, 403, 'Invalid security token; refresh and try again', 'CSRF_FAILED');
  }

  canAccessLibrary(user, libraryId) {
    return user.role === 'admin' || parseJsonArray(user.allowedLibraries).includes(Number(libraryId));
  }

  assertLibrary(user, libraryId) {
    assert(this.canAccessLibrary(user, libraryId), 403, 'You do not have access to this library', 'LIBRARY_FORBIDDEN');
  }

  visibleLibraryIds(user) {
    return user.role === 'admin' ? this.store.db.prepare('SELECT id FROM libraries').all().map(row => Number(row.id)) : parseJsonArray(user.allowedLibraries).map(Number);
  }

  inList(values) {
    return values.length ? values.join(',') : 'NULL';
  }

  async getItemForUser(id, user) {
    const item = this.store.db.prepare('SELECT * FROM media_items WHERE id = ? AND missing = 0').get(id);
    assert(item, 404, 'Title not found');
    this.assertLibrary(user, item.libraryId);
    return item;
  }

  async route(req, res, url, body) {
    const pathname = url.pathname;
    if (pathname === '/api/health') return json({ status: 'online', version: VERSION, instanceId: this.instanceId, configured: this.store.isConfigured(), serverName: this.store.settings().serverName });
    if (pathname.startsWith('/api/setup')) return this.setupRoute(req, body);
    if (pathname === '/api/auth/login' && req.method === 'POST') return this.login(req, body);
    if (pathname === '/' || pathname === '/index.html' || STATIC_FILES.has(pathname.slice(1))) return this.staticRoute(req, res, pathname);
    if (req.method === 'GET' && pathname === '/api/auth/me') {
      const user = this.requireUser(req);
      return json({ user: publicUser(user), csrfToken: user.csrfToken, preferences: parsePreferences(user.preferences) });
    }
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const user = this.requireUser(req);
      this.requireCsrf(req, user);
      this.store.db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(user.sessionId);
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('hearth_session', '', { maxAge: 0, secure: this.isSecureRequest(req) }) });
    }
    const user = this.requireUser(req);
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) this.requireCsrf(req, user);
    req.user = user;

    if (pathname.startsWith('/api/play/')) return this.playbackRoutes(req, res, url, user);
    if (pathname.startsWith('/api/items/')) return this.itemRoutes(req, res, url, user, body);
    if (pathname.startsWith('/api/playback/')) return this.playbackStateRoutes(req, url, user, body);
    if (pathname.startsWith('/api/files')) return this.fileRoutes(req, res, url, user, body);
    if (pathname.startsWith('/api/auth/')) return this.accountRoutes(req, url, user, body);
    if (pathname.startsWith('/api/admin/')) return this.adminRoutes(req, res, url, user, body);
    if (pathname.startsWith('/api/collections')) return this.collectionRoutes(req, url, user, body);
    if (pathname.startsWith('/api/')) return this.contentRoutes(req, url, user);

    if (pathname === '/favicon.ico') return this.staticRoute(req, res, '/icon-192.png');
    if (pathname.includes('.')) throw new HttpError(404, 'Not found');
    return this.staticRoute(req, res, '/index.html', { noCache: true });
  }

  async staticRoute(req, res, requested, options = {}) {
    const name = requested === '/' ? '/index.html' : requested;
    assert(['GET', 'HEAD'].includes(req.method), 405, 'Method not allowed');
    const fileName = path.basename(name);
    assert(STATIC_FILES.has(fileName), 404, 'Not found');
    const filePath = path.join(PUBLIC_DIR, fileName);
    assert(fs.existsSync(filePath), 404, 'Not found');
    const headers = {
      'Content-Type': contentType(filePath),
      'Cache-Control': options.noCache || fileName === 'sw.js' || fileName === 'index.html' ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    };
    return sendFile(res, filePath, req, { contentType: headers['Content-Type'], cacheControl: headers['Cache-Control'] });
  }

  setupKey(req) {
    assert(isLoopback(req.socket.remoteAddress || '') && req.headers['x-hearth-setup'] === this.setupToken, 403, 'Setup is only available from the Hearth desktop app', 'SETUP_FORBIDDEN');
  }

  browserSetupAllowed(req) {
    return isLoopback(req.socket.remoteAddress || '') && !this.store.isConfigured();
  }

  async setupRoute(req, body) {
    const desktopKeyed = isLoopback(req.socket.remoteAddress || '') && req.headers['x-hearth-setup'] === this.setupToken;
    if (!desktopKeyed) assert(this.browserSetupAllowed(req), 403, 'Setup is only available from the Hearth desktop app', 'SETUP_FORBIDDEN');
    if (req.method === 'GET') return json({ configured: this.store.isConfigured(), browserSetup: this.browserSetupAllowed(req), version: VERSION, dependencies: { runtime: process.version, ffmpegBundled: Boolean(this.ffmpegDir), cloudflaredBundled: Boolean(this.cloudflared) } });
    assert(req.method === 'POST', 405, 'Method not allowed');
    assert(!this.store.isConfigured(), 409, 'Hearth has already been configured');
    if (!desktopKeyed) this.rateLimit(req, 'browser-setup', 8, 15 * 60000);
    assert(body.step === 'complete', 400, 'Invalid setup stage');
    const serverName = String(body.serverName || '').trim();
    assert(serverName.length >= 1 && serverName.length <= 60, 400, 'Server name must be 1–60 characters');
    const port = Number(body.port);
    assert(Number.isInteger(port) && port >= 1024 && port <= 65535, 400, 'Choose a port between 1024 and 65535');
    const bindAddress = String(body.bindAddress || '0.0.0.0');
    assert(bindAddress === '0.0.0.0' || bindAddress === '::' || bindAddress === '127.0.0.1' || bindAddress === '::1' || /^192\.168\.\d+\.\d+$/.test(bindAddress), 400, 'Invalid bind address');
    const admin = body.admin || {};
    const username = String(admin.username || '').trim();
    const password = String(admin.password || '');
    assert(/^[A-Za-z0-9._-]{3,64}$/.test(username), 400, 'Username must be 3–64 letters, numbers, dots, underscores, or hyphens');
    assert(password.length >= 12 && password.length <= 1024, 400, 'Use an administrator password of at least 12 characters');
    const libraries = Array.isArray(body.libraries) ? body.libraries : [];
    assert(libraries.length <= 64, 400, 'Too many libraries');
    const validLibraries = [];
    const seen = new Set();
    for (const entry of libraries) {
      const name = String(entry.name || '').trim();
      const libraryPath = path.resolve(String(entry.path || ''));
      const type = String(entry.type || '');
      assert(name.length >= 1 && name.length <= 80 && LIBRARY_TYPES.has(type), 400, 'Invalid library name or category');
      assert(path.isAbsolute(String(entry.path || '')) && !seen.has(`${libraryPath}:${type}`), 400, 'Library paths must be absolute and unique');
      assert(fs.existsSync(libraryPath) && fs.statSync(libraryPath).isDirectory(), 400, `Folder is unavailable: ${libraryPath}`);
      seen.add(`${libraryPath}:${type}`);
      validLibraries.push({ name, path: libraryPath, type });
    }
    const remote = body.remote || {};
    assert(['off', 'vpn', 'tunnel', 'proxy'].includes(remote.mode), 400, 'Invalid remote access mode');
    const previousSettings = this.store.settings();
    const remotePublicUrl = String(remote.publicUrl || '').replace(/\/$/, '');
    if (remote.publicUrl) assert(remote.mode === 'proxy' && /^https:\/\/[^\s/@]+$/i.test(remote.publicUrl), 400, 'Reverse-proxy remote access requires a public HTTPS URL');
    const now = isoNow();
    this.store.setSettings({ serverName, port, bindAddress, remoteMode: remote.mode, remoteEnabled: Boolean(remote.enabled), remotePublicUrl });
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO users(username, passwordHash, role, allowedLibraries, canDownload, createdAt, updatedAt)
        VALUES(?, ?, 'admin', '[]', 1, ?, ?)`).run(username, passwordHash(password), now, now);
      const insert = this.store.db.prepare('INSERT INTO libraries(name, path, type, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?)');
      validLibraries.forEach(library => insert.run(library.name, library.path, library.type, now, now));
      if (body.metadata?.tmdbKey) this.store.setSecret('tmdbKey', String(body.metadata.tmdbKey));
      if (body.metadata?.musicBrainzToken) this.store.setSecret('musicBrainzToken', String(body.metadata.musicBrainzToken));
    });
    this.store.activity('info', 'Initial setup completed', { libraries: validLibraries.length, remoteMode: remote.mode });
    const session = this.store.createSession(this.store.db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().id, req);
    this.writeBootstrap();
    if (remote.enabled && remote.mode === 'tunnel') {
      setTimeout(() => this.remote.startTunnel().catch(error => this.logger.warn('Could not start setup tunnel', { message: error.message })), 2000);
    }
    setTimeout(() => validLibraries.forEach(library => {
      const row = this.store.db.prepare('SELECT id FROM libraries WHERE path = ? AND type = ?').get(library.path, library.type);
      if (row) this.scanner.enqueue(row.id).catch(error => this.logger.warn('Initial scan failed', { message: error.message }));
    }), 1500);
    return json({ ok: true, token: session.token, csrfToken: session.csrfToken, expiresAt: session.expiresAt, restartRequired: port !== previousSettings.port || bindAddress !== previousSettings.bindAddress }, 200, {
      'Set-Cookie': cookie('hearth_session', session.token, { maxAge: 30 * 86400, secure: this.isSecureRequest(req) })
    });
  }

  writeBootstrap() {
    const settings = this.store.settings();
    const target = path.join(this.dataDir, 'runtime', 'bootstrap.json');
    fs.writeFileSync(target, JSON.stringify({ port: settings.port, bindAddress: settings.bindAddress, serverName: settings.serverName }, null, 2));
  }

  async login(req, body) {
    this.rateLimit(req, 'login-ip', 25, 15 * 60000);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    assert(username.length <= 128 && password.length <= 1024, 400, 'Invalid credentials');
    this.rateLimit(req, `login-user:${username.toLowerCase()}`, 6, 15 * 60000);
    const user = this.store.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const valid = passwordVerify(password, user?.passwordHash || this.dummyHash);
    if (!user || user.disabled || !valid) {
      this.store.activity('warning', 'Failed sign-in attempt', { username: username.slice(0, 64) });
      throw new HttpError(401, 'Incorrect username or password', 'INVALID_CREDENTIALS');
    }
    const session = this.store.createSession(user.id, req);
    const data = { user: publicUser(user), csrfToken: session.csrfToken, expiresAt: session.expiresAt };
    if (isLoopback(req.socket.remoteAddress || '') && req.headers['x-hearth-desktop'] === '1') data.token = session.token;
    return json(data, 200, {
      'Set-Cookie': cookie('hearth_session', session.token, { maxAge: 30 * 86400, secure: this.isSecureRequest(req) })
    });
  }

  async accountRoutes(req, url, user, body) {
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/api/auth/sessions') {
      const rows = this.store.db.prepare('SELECT id, createdAt, lastSeenAt, expiresAt, userAgent, ip FROM sessions WHERE userId = ? AND revoked = 0').all(user.id);
      return json({ sessions: rows });
    }
    const match = pathname.match(/^\/api\/auth\/sessions\/(\d+)$/);
    if (req.method === 'DELETE' && match) {
      const result = this.store.db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ? AND userId = ?').run(Number(match[1]), user.id);
      assert(result.changes > 0, 404, 'Session not found');
      return json({ ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/auth/me/preferences') return json(parsePreferences(user.preferences));
    if (req.method === 'PATCH' && pathname === '/api/auth/me/preferences') {
      const preferences = parsePreferences(user.preferences);
      for (const key of ['autoplay', 'audioLanguage', 'subtitleLanguage', 'quality']) {
        if (body[key] !== undefined) {
          if (typeof preferences[key] === 'boolean') preferences[key] = Boolean(body[key]);
          else preferences[key] = String(body[key]).slice(0, 32);
        }
      }
      this.store.db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(preferences), user.id);
      return json(preferences);
    }
    if (req.method === 'POST' && pathname === '/api/auth/password') {
      assert(passwordVerify(String(body.currentPassword || ''), user.passwordHash), 400, 'Current password is incorrect');
      const password = String(body.newPassword || '');
      assert(password.length >= 12 && password.length <= 1024, 400, 'Use at least 12 characters');
      this.store.db.prepare('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?').run(passwordHash(password), isoNow(), user.id);
      this.store.db.prepare('UPDATE sessions SET revoked = 1 WHERE userId = ? AND id <> ?').run(user.id, user.id);
      this.store.activity('info', 'Account password changed', { userId: user.id });
      return json({ ok: true });
    }
    throw new HttpError(404, 'Not found');
  }

  writeJson(res, data, status = 200, headers = {}) {
    const response = json(data, status, headers);
    res.writeHead(status, response.headers);
    res.end(response.body);
  }

  contentRoutes(req, url, user) {
    assert(req.method === 'GET', 405, 'Method not allowed');
    const pathname = url.pathname;
    if (pathname === '/api/libraries') {
      const rows = this.store.db.prepare('SELECT * FROM libraries ORDER BY id').all().filter(library => this.canAccessLibrary(user, library.id));
      return json({ libraries: rows.map(library => ({ id: library.id, name: library.name, type: library.type, path: user.role === 'admin' ? library.path : undefined, lastScanAt: library.lastScanAt })) });
    }
    if (pathname === '/api/home') return this.home(user);
    if (pathname === '/api/items') return this.itemList(url, user);
    if (pathname === '/api/shows') return this.showList(url, user);
    const showMatch = pathname.match(/^\/api\/shows\/([a-f0-9]{24})(?:\/artwork\/(poster|backdrop))?$/);
    if (showMatch) return showMatch[2] ? this.showArtwork(req, showMatch[1], showMatch[2], user) : this.showDetails(showMatch[1], user);
    if (pathname === '/api/music/artists') return this.musicArtists(url, user);
    if (pathname === '/api/music/albums') return this.musicAlbums(url, user);
    if (pathname === '/api/search') return this.search(url, user);
    if (pathname === '/api/me/favorites' || pathname === '/api/me/watchlist') return this.personList(pathname, user);
    if (pathname === '/api/me/continue-watching') return this.continueWatching(user, 100);
    throw new HttpError(404, 'Not found');
  }

  serializeItem(item, state = {}) {
    const parsed = typeof item === 'object' ? item : {};
    const streams = parseJsonArray(parsed.streams);
    return {
      id: parsed.id, libraryId: parsed.libraryId, type: parsed.type, title: parsed.title, originalTitle: parsed.originalTitle,
      sortTitle: parsed.sortTitle, artist: parsed.artist, albumArtist: parsed.albumArtist, album: parsed.album, track: parsed.track,
      disc: parsed.disc, year: parsed.year, overview: parsed.overview, genres: parseJsonArray(parsed.genres), tagline: parsed.tagline,
      rating: parsed.rating, ratingCount: parsed.ratingCount, runtimeMs: parsed.runtimeMs, width: parsed.width, height: parsed.height,
      videoCodec: parsed.videoCodec, audioCodec: parsed.audioCodec, container: parsed.container, fileBytes: parsed.fileBytes,
      streams, director: parsed.director, cast: parseJsonArray(parsed.cast), studios: parseJsonArray(parsed.studios), showId: parsed.showId,
      showTitle: parsed.showTitle, seasonNumber: parsed.seasonNumber, episodeNumber: parsed.episodeNumber, episodeTitle: parsed.episodeTitle,
      posterUrl: parsed.posterPath ? `/api/items/${parsed.id}/artwork/poster` : parsed.thumbPath ? `/api/items/${parsed.id}/artwork/thumb` : null,
      backdropUrl: parsed.backdropPath ? `/api/items/${parsed.id}/artwork/backdrop` : parsed.thumbPath ? `/api/items/${parsed.id}/artwork/thumb` : null,
      playback: state.playback || null, favorite: Boolean(state.favorite), watched: Boolean(state.watchlist)
    };
  }

  statesFor(user, items) {
    const ids = [...new Set(items.map(item => item.id))];
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const playback = this.store.db.prepare(`SELECT * FROM playback_state WHERE userId = ? AND itemId IN (${placeholders})`).all(user.id, ...ids);
    const favorites = this.store.db.prepare(`SELECT itemId FROM favorites WHERE userId = ? AND itemId IN (${placeholders})`).all(user.id, ...ids);
    const watchlist = this.store.db.prepare(`SELECT itemId FROM watchlist WHERE userId = ? AND itemId IN (${placeholders})`).all(user.id, ...ids);
    const result = new Map();
    for (const id of ids) result.set(id, { playback: playback.find(row => row.itemId === id) || null, favorite: favorites.some(row => row.itemId === id), watchlist: watchlist.some(row => row.itemId === id) });
    return result;
  }

  serializeMany(user, items) {
    const states = this.statesFor(user, items);
    return items.map(item => this.serializeItem(item, states.get(item.id)));
  }

  async home(user) {
    const ids = this.visibleLibraryIds(user);
    const filter = `libraryId IN (${this.inList(ids)}) AND missing = 0`;
    const query = async (sql, ...params) => this.store.db.prepare(sql).all(...params);
    const featured = await query(`SELECT * FROM media_items WHERE ${filter} AND type IN ('movie','episode') AND backdropPath IS NOT NULL ORDER BY rating DESC LIMIT 6`);
    const recentlyAdded = await query(`SELECT * FROM media_items WHERE ${filter} AND type IN ('movie','song','episode') ORDER BY createdAt DESC LIMIT 24`);
    const trending = await query(`SELECT m.* FROM media_items m JOIN (SELECT itemId, count(*) AS plays FROM playback_state GROUP BY itemId) p ON p.itemId = m.id
      WHERE ${filter} AND m.type IN ('movie','episode') ORDER BY p.plays DESC, m.rating DESC LIMIT 20`);
    const recommended = await query(`SELECT m.* FROM media_items m LEFT JOIN playback_state p ON p.itemId = m.id AND p.userId = ?
      WHERE ${filter} AND p.itemId IS NULL AND m.type IN ('movie','episode') ORDER BY m.rating DESC LIMIT 20`, user.id);
    const recentlyPlayed = await query(`SELECT m.* FROM media_items m JOIN playback_state p ON p.itemId = m.id AND p.userId = ?
      WHERE ${filter} ORDER BY p.updatedAt DESC LIMIT 20`, user.id);
    const collections = this.store.db.prepare('SELECT * FROM collections WHERE userId = ? ORDER BY updatedAt DESC').all(user.id);
    return json({
      featured: this.serializeMany(user, featured), continueWatching: this.continueWatchingRows(user, 16),
      recentlyAdded: this.serializeMany(user, recentlyAdded), trending: this.serializeMany(user, trending),
      recommended: this.serializeMany(user, recommended), recentlyPlayed: this.serializeMany(user, recentlyPlayed),
      collections: collections.map(collection => this.serializeCollection(collection))
    });
  }

  continueWatchingRows(user, limit) {
    const rows = this.store.db.prepare(`SELECT m.*, p.positionMs, p.updatedAt AS playedAt FROM playback_state p
      JOIN media_items m ON m.id = p.itemId WHERE p.userId = ? AND m.missing = 0 AND p.completed = 0 AND p.positionMs > 30000
      AND (m.runtimeMs IS NULL OR p.positionMs < m.runtimeMs * 0.95)
      AND m.libraryId IN (${this.inList(this.visibleLibraryIds(user))}) ORDER BY p.updatedAt DESC LIMIT ?`).all(user.id, limit);
    const states = this.statesFor(user, rows);
    return rows.map(row => this.serializeItem(row, states.get(row.id)));
  }

  continueWatching(user, limit = 50) {
    return json({ items: this.continueWatchingRows(user, limit) });
  }

  itemList(url, user) {
    const type = url.searchParams.get('type');
    assert(['movie', 'episode', 'song', 'file', 'show'].includes(type || ''), 400, 'A valid media type is required');
    const libraryId = url.searchParams.get('libraryId');
    if (libraryId) this.assertLibrary(user, libraryId);
    const ids = libraryId ? [Number(libraryId)] : this.visibleLibraryIds(user);
    const conditions = [`m.libraryId IN (${this.inList(ids)})`, 'm.missing = 0'];
    const params = [];
    if (type === 'show') {
      conditions.push('m.type = ?', 'm.episodeNumber = 1');
      params.push('episode');
    } else {
      conditions.push('m.type = ?'); params.push(type);
    }
    for (const [param, column] of [['genre', 'm.genres'], ['artist', 'm.artist'], ['album', 'm.album'], ['year', 'm.year']]) {
      const value = url.searchParams.get(param);
      if (value) {
        conditions.push(param === 'genre' ? `${column} LIKE ? ESCAPE '\\'` : `${column} = ?`);
        params.push(param === 'genre' ? sqlLike(value) : param === 'year' ? Number(value) : value);
      }
    }
    const q = url.searchParams.get('q');
    if (q) { conditions.push('(m.title LIKE ? ESCAPE \'\\\' OR m.artist LIKE ? ESCAPE \'\\\' OR m.album LIKE ? ESCAPE \'\\\')'); params.push(sqlLike(q), sqlLike(q), sqlLike(q)); }
    const sort = url.searchParams.get('sort');
    const orders = { added: 'm.createdAt DESC', title: 'm.sortTitle ASC', year: 'm.year DESC', rating: 'm.rating DESC', plays: 'm.id DESC' };
    conditions.push(...(conditions.length ? [] : []));
    const where = conditions.join(' AND ');
    const total = this.store.db.prepare(`SELECT count(*) AS count FROM media_items m WHERE ${where}`).get(...params).count;
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 40));
    const offset = (page - 1) * limit;
    const rows = this.store.db.prepare(`SELECT m.* FROM media_items m WHERE ${where} ORDER BY ${orders[sort] || (type === 'song' ? 'm.albumArtist, m.album, m.disc, m.track' : 'm.createdAt DESC')} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return json({ items: this.serializeMany(user, rows), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  }

  showList(url, user) {
    const ids = this.visibleLibraryIds(user);
    const q = url.searchParams.get('q');
    const params = [];
    let extra = '';
    if (q) { extra = ' AND s.title LIKE ? ESCAPE \'\\\' ORDER BY s.sortTitle'; params.push(sqlLike(q)); }
    const rows = this.store.db.prepare(`SELECT s.*, (SELECT count(*) FROM media_items m WHERE m.showId = s.id AND m.missing = 0) AS episodeCount
      FROM shows s WHERE s.libraryId IN (${this.inList(ids)})${extra || ' ORDER BY s.sortTitle'}`).all(...params);
    return json({ shows: rows.map(show => ({ id: show.id, title: show.title, overview: show.overview, year: show.year, genres: parseJsonArray(show.genres), rating: show.rating, episodeCount: show.episodeCount,
      posterUrl: show.posterPath ? `/api/shows/${show.id}/artwork/poster` : null, backdropUrl: show.backdropPath ? `/api/shows/${show.id}/artwork/backdrop` : null })) });
  }

  showDetails(id, user) {
    const show = this.store.db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
    assert(show, 404, 'Show not found');
    this.assertLibrary(user, show.libraryId);
    const episodes = this.store.db.prepare('SELECT * FROM media_items WHERE showId = ? AND missing = 0 ORDER BY seasonNumber, episodeNumber').all(id);
    const serialized = this.serializeMany(user, episodes);
    const seasons = new Map();
    for (const episode of serialized) {
      if (!seasons.has(episode.seasonNumber)) seasons.set(episode.seasonNumber, []);
      seasons.get(episode.seasonNumber).push(episode);
    }
    let credits = {};
    try { credits = JSON.parse(show.metadataJson || '{}'); } catch { /* local metadata only */ }
    return json({ id: show.id, title: show.title, originalTitle: show.originalTitle, overview: show.overview, year: show.year,
      genres: parseJsonArray(show.genres), rating: show.rating, ratingCount: show.ratingCount, tagline: show.tagline,
      studio: show.studio, externalId: show.externalId, cast: credits.cast || credits.credits?.cast || [],
      posterUrl: show.posterPath ? `/api/shows/${show.id}/artwork/poster` : null,
      backdropUrl: show.backdropPath ? `/api/shows/${show.id}/artwork/backdrop` : null,
      seasons: [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([season, items]) => ({ season, episodes: items })),
      episodeCount: episodes.length
    });
  }

  showArtwork(req, id, requested, user) {
    const show = this.store.db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
    assert(show, 404, 'Show not found');
    this.assertLibrary(user, show.libraryId);
    assert(['poster', 'backdrop'].includes(requested), 404, 'Artwork not found');
    const source = requested === 'poster' ? show.posterPath : show.backdropPath;
    assert(source && fs.existsSync(source), 404, 'Artwork has not been generated');
    const library = this.store.db.prepare('SELECT path FROM libraries WHERE id = ?').get(show.libraryId);
    const resolved = path.resolve(source);
    const allowedRoots = [path.join(this.dataDir, 'artwork'), path.join(this.dataDir, 'cache'), ...(library ? [path.resolve(library.path)] : [])];
    assert(allowedRoots.some(root => { const relative = path.relative(root, resolved); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }), 403, 'Invalid artwork path');
    return { file: resolved, options: { contentType: contentType(resolved), cacheControl: 'private, max-age=86400' } };
  }

  musicArtists(url, user) {    const q = sqlLike(url.searchParams.get('q') || '');
    const rows = this.store.db.prepare(`SELECT artist, count(*) AS songs FROM media_items WHERE type = 'song' AND missing = 0
      AND libraryId IN (${this.inList(this.visibleLibraryIds(user))}) AND artist LIKE ? ESCAPE '\\' GROUP BY artist ORDER BY artist`).all(q);
    return json({ artists: rows });
  }

  musicAlbums(url, user) {
    const q = sqlLike(url.searchParams.get('q') || '');
    const artist = url.searchParams.get('artist');
    const params = [q];
    let artistFilter = '';
    if (artist) { artistFilter = ' AND albumArtist = ?'; params.push(artist); }
    const rows = this.store.db.prepare(`SELECT albumArtist, album, min(year) AS year, count(*) AS tracks, max(posterPath) AS posterPath,
      CASE WHEN max(posterPath) IS NULL THEN NULL ELSE max(id) END AS sampleId FROM media_items WHERE type = 'song' AND missing = 0
      AND libraryId IN (${this.inList(this.visibleLibraryIds(user))}) AND album LIKE ? ESCAPE '\\'${artistFilter} GROUP BY albumArtist, album ORDER BY albumArtist, album`).all(...params);
    return json({ albums: rows.map(row => ({ ...row, posterUrl: row.posterPath && row.sampleId ? `/api/items/${row.sampleId}/artwork/poster` : null })) });
  }

  personalList(pathname, user) {
    const table = pathname.endsWith('favorites') ? 'favorites' : 'watchlist';
    const rows = this.store.db.prepare(`SELECT m.* FROM ${table} t JOIN media_items m ON m.id = t.itemId WHERE t.userId = ? AND m.missing = 0 ORDER BY t.createdAt DESC`).all(user.id);
    return json({ items: this.serializeMany(user, rows) });
  }

  search(url, user) {
    const q = String(url.searchParams.get('q') || '').trim();
    assert(q.length >= 1 && q.length <= 200, 400, 'Enter a search query');
    const term = sqlLike(q);
    const rows = this.store.db.prepare(`SELECT * FROM media_items WHERE missing = 0 AND libraryId IN (${this.inList(this.visibleLibraryIds(user))})
      AND (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\' OR overview LIKE ? ESCAPE '\\')
      ORDER BY CASE WHEN type = 'movie' THEN 0 WHEN type = 'episode' THEN 1 ELSE 2 END, rating DESC LIMIT 60`).all(term, term, term, term);
    return json({ items: this.serializeMany(user, rows) });
  }

  serializeCollection(collection) {
    return { id: collection.id, kind: collection.kind, name: collection.name, description: collection.description, createdAt: collection.createdAt, updatedAt: collection.updatedAt };
  }

  async collectionRoutes(req, url, user, body) {
    const pathname = url.pathname;
    if (pathname === '/api/collections' && req.method === 'GET') {
      const rows = this.store.db.prepare('SELECT * FROM collections WHERE userId = ? ORDER BY updatedAt DESC').all(user.id);
      return json({ collections: rows.map(row => this.serializeCollection(row)) });
    }
    if (pathname === '/api/collections' && req.method === 'POST') {
      const kind = body.kind === 'playlist' ? 'playlist' : 'collection';
      const name = String(body.name || '').trim();
      assert(name.length >= 1 && name.length <= 100, 400, 'Enter a name up to 100 characters');
      const id = randomToken(12);
      const now = isoNow();
      this.store.db.prepare('INSERT INTO collections(id, userId, kind, name, description, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(id, user.id, kind, name, String(body.description || '').slice(0, 1000), now, now);
      if (Array.isArray(body.itemIds)) for (const itemId of body.itemIds.slice(0, 500)) await this.addItemToCollection(id, itemId, user);
      return json({ collection: this.serializeCollection(this.store.db.prepare('SELECT * FROM collections WHERE id = ?').get(id)) }, 201);
    }
    const match = pathname.match(/^\/api\/collections\/([A-Za-z0-9_-]+)(\/items\/[A-Za-z0-9_-]+)?$/);
    if (!match) throw new HttpError(404, 'Not found');
    const collection = this.store.db.prepare('SELECT * FROM collections WHERE id = ? AND userId = ?').get(match[1], user.id);
    assert(collection, 404, 'Collection not found');
    if (!match[2] && req.method === 'GET') {
      const rows = this.store.db.prepare(`SELECT m.* FROM collection_items ci JOIN media_items m ON m.id = ci.itemId
        WHERE ci.collectionId = ? AND m.missing = 0 ORDER BY ci."order", ci.addedAt`).all(collection.id);
      return json({ collection: this.serializeCollection(collection), items: this.serializeMany(user, rows) });
    }
    if (!match[2] && req.method === 'PATCH') {
      const name = body.name === undefined ? collection.name : String(body.name).trim();
      assert(name.length >= 1 && name.length <= 100, 400, 'Invalid collection name');
      this.store.db.prepare('UPDATE collections SET name = ?, description = ?, updatedAt = ? WHERE id = ?').run(name,
        body.description === undefined ? collection.description : String(body.description).slice(0, 1000), isoNow(), collection.id);
      return json({ collection: this.serializeCollection(this.store.db.prepare('SELECT * FROM collections WHERE id = ?').get(collection.id)) });
    }
    if (!match[2] && req.method === 'DELETE') {
      this.store.db.prepare('DELETE FROM collections WHERE id = ?').run(collection.id);
      return json({ ok: true });
    }
    const itemId = match[2]?.split('/items/')[1];
    if (req.method === 'POST') {
      await this.getItemForUser(itemId, user);
      const count = this.store.db.prepare('SELECT count(*) AS count FROM collection_items WHERE collectionId = ?').get(collection.id).count;
      assert(count < 5000, 400, 'Collection is full');
      this.store.db.prepare('INSERT OR IGNORE INTO collection_items(collectionId, itemId, "order", addedAt) VALUES(?, ?, ?, ?)').run(collection.id, itemId, count, isoNow());
      this.store.db.prepare('UPDATE collections SET updatedAt = ? WHERE id = ?').run(isoNow(), collection.id);
      return json({ ok: true }, 201);
    }
    if (req.method === 'DELETE') {
      this.store.db.prepare('DELETE FROM collection_items WHERE collectionId = ? AND itemId = ?').run(collection.id, itemId);
      return json({ ok: true });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  async addItemToCollection(collectionId, itemId, user) {
    await this.getItemForUser(itemId, user);
    this.store.db.prepare('INSERT OR IGNORE INTO collection_items(collectionId, itemId, "order", addedAt) VALUES(?, ?, 0, ?)').run(collectionId, itemId, isoNow());
  }

  async itemRoutes(req, res, url, user, body) {
    const match = url.pathname.match(/^\/api\/items\/([a-f0-9]{24})(?:\/(.+))?$/);
    if (!match) throw new HttpError(404, 'Item not found');
    const item = await this.getItemForUser(match[1], user);
    const action = match[2] || '';
    if (!action && req.method === 'GET') return this.itemDetails(item, user);
    if (action === 'play' && req.method === 'POST') {
      assert(['movie', 'episode', 'song'].includes(item.type), 400, 'This item cannot be played');
      const session = this.playback.createSession(item, user, body.profile || {});
      return json({ id: session.id, directPlay: session.direct, directStream: session.directStream, transcoded: session.transcoded,
        reason: session.reason, url: session.direct ? `/api/play/${session.id}/file` : `/api/play/${session.id}/master.m3u8`, audioStream: session.audioStream });
    }
    if (action.startsWith('artwork/') && req.method === 'GET') return this.artwork(req, item, action.slice(8));
    if (action.startsWith('subtitle/') && req.method === 'GET') {
      const streamIndex = action.slice(9).replace(/\.vtt$/, '');
      const file = await this.playback.subtitle(item, streamIndex);
      return { file, options: { contentType: 'text/vtt; charset=utf-8', cacheControl: 'private, max-age=86400' } };
    }
    if (action === 'preview' && req.method === 'GET') {
      const file = await this.playback.preview(item, Number(url.searchParams.get('ts')));
      return { file, options: { contentType: 'image/jpeg', cacheControl: 'private, max-age=86400' } };
    }
    if (action === 'download' && req.method === 'GET') {
      assert(user.role === 'admin' || user.canDownload, 403, 'Downloads are disabled for this account');
      return { file: item.path, options: { contentType: contentType(item.path), headers: { 'Content-Disposition': contentDisposition(item.title, path.extname(item.path)) } } };
    }
    if (action === 'favorite' && req.method === 'POST') {
      if (body.value === false) this.store.db.prepare('DELETE FROM favorites WHERE userId = ? AND itemId = ?').run(user.id, item.id);
      else this.store.db.prepare('INSERT OR IGNORE INTO favorites(userId, itemId, createdAt) VALUES(?, ?, ?)').run(user.id, item.id, isoNow());
      return json({ favorite: body.value !== false });
    }
    if (action === 'watchlist' && req.method === 'POST') {
      if (body.value === false) this.store.db.prepare('DELETE FROM watchlist WHERE userId = ? AND itemId = ?').run(user.id, item.id);
      else this.store.db.prepare('INSERT OR IGNORE INTO watchlist(userId, itemId, createdAt) VALUES(?, ?, ?)').run(user.id, item.id, isoNow());
      return json({ watchlist: body.value !== false });
    }
    throw new HttpError(404, 'Item action not found');
  }

  async itemDetails(item, user) {
    const state = this.statesFor(user, [item]).get(item.id);
    const result = this.serializeItem(item, state);
    result.metadataSource = item.metadataSource;
    result.externalId = item.externalId;
    if (item.type === 'episode') {
      result.show = this.store.db.prepare('SELECT * FROM shows WHERE id = ?').get(item.showId);
      if (result.show) {
        result.show = { id: result.show.id, title: result.show.title, originalTitle: result.show.originalTitle, overview: result.show.overview,
          year: result.show.year, genres: parseJsonArray(result.show.genres), rating: result.show.rating, ratingCount: result.show.ratingCount,
          tagline: result.show.tagline, studio: result.show.studio, externalId: result.show.externalId,
          posterUrl: result.show.posterPath ? `/api/shows/${result.show.id}/artwork/poster` : result.posterUrl,
          backdropUrl: result.show.backdropPath ? `/api/shows/${result.show.id}/artwork/backdrop` : result.backdropUrl };
      }
      const episodes = this.store.db.prepare('SELECT * FROM media_items WHERE showId = ? AND missing = 0 ORDER BY seasonNumber, episodeNumber').all(item.showId);
      result.episodes = this.serializeMany(user, episodes);
    }
    if (item.type === 'song') {
      const tracks = this.store.db.prepare("SELECT * FROM media_items WHERE type = 'song' AND albumArtist = ? AND album = ? AND missing = 0 ORDER BY disc, track").all(item.albumArtist, item.album);
      result.tracks = this.serializeMany(user, tracks);
    }
    return json(result);
  }

  async artwork(req, item, requested) {
    assert(['poster', 'backdrop', 'thumb'].includes(requested), 404, 'Artwork not found');
    let source = requested === 'poster' ? item.posterPath : requested === 'backdrop' ? item.backdropPath : item.thumbPath;
    if (!source && requested === 'poster' && item.thumbPath) source = item.thumbPath;
    if (!source && requested === 'backdrop' && item.thumbPath) source = item.thumbPath;
    if (!source && item.showId) {
      const show = this.store.db.prepare('SELECT * FROM shows WHERE id = ?').get(item.showId);
      source = requested === 'poster' ? show?.posterPath : show?.backdropPath;
    }
    assert(source, 404, 'Artwork has not been generated');
    const resolved = path.resolve(source);
    const allowedRoots = [path.join(this.dataDir, 'artwork'), path.join(this.dataDir, 'cache')];
    const library = this.store.db.prepare('SELECT path FROM libraries WHERE id = ?').get(item.libraryId);
    if (library) allowedRoots.push(path.resolve(library.path));
    assert(allowedRoots.some(root => { const relative = path.relative(root, resolved); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }), 403, 'Invalid artwork path');
    assert(fs.existsSync(resolved), 404, 'Artwork file is unavailable');
    return { file: resolved, options: { contentType: contentType(resolved), cacheControl: 'private, max-age=86400' } };
  }

  async playbackStateRoutes(req, url, user, body) {
    const match = url.pathname.match(/^\/api\/playback\/([a-f0-9]{24})$/);
    if (!match) throw new HttpError(404, 'Playback state not found');
    const item = await this.getItemForUser(match[1], user);
    if (req.method === 'GET') {
      const state = this.store.db.prepare('SELECT * FROM playback_state WHERE userId = ? AND itemId = ?').get(user.id, item.id);
      return json({ state: state || { positionMs: 0, durationMs: item.runtimeMs || 0, completed: 0 } });
    }
    assert(req.method === 'POST', 405, 'Method not allowed');
    const positionMs = Number(body.positionMs);
    const durationMs = Number(body.durationMs) || item.runtimeMs || 0;
    assert(Number.isFinite(positionMs) && positionMs >= 0 && positionMs <= Math.max(durationMs + 600000, 3600000), 400, 'Invalid playback position');
    this.store.db.prepare(`INSERT INTO playback_state(userId, itemId, positionMs, durationMs, completed, audioTrack, subtitleTrack, updatedAt)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(userId, itemId) DO UPDATE SET positionMs = excluded.positionMs,
      durationMs = excluded.durationMs, completed = excluded.completed, audioTrack = excluded.audioTrack,
      subtitleTrack = excluded.subtitleTrack, updatedAt = excluded.updatedAt`)
      .run(user.id, item.id, Math.round(positionMs), Math.round(durationMs), body.completed ? 1 : 0, body.audioTrack ?? null, body.subtitleTrack ?? null, isoNow());
    return json({ ok: true });
  }

  ownPlaybackSession(req, id, user) {
    const session = this.playback.getSession(id);
    assert(session.userId === user.id, 403, 'Playback session belongs to another user');
    return session;
  }

  async playbackRoutes(req, res, url, user) {
    const match = url.pathname.match(/^\/api\/play\/([A-Za-z0-9_-]+)(?:\/(.+))?$/);
    if (!match) throw new HttpError(404, 'Playback route not found');
    if (req.method === 'DELETE') {
      const session = this.ownPlaybackSession(req, match[1], user);
      this.playback.sessions.delete(session.id);
      return json({ ok: true });
    }
    const session = this.ownPlaybackSession(req, match[1], user);
    const item = await this.getItemForUser(session.itemId, user);
    assert(fs.existsSync(item.path), 404, 'Media file is missing');
    const action = match[2] || '';
    if (action === 'heartbeat' && req.method === 'POST') return json({ ok: true, directPlay: session.direct });
    if (action === 'file' && req.method === 'GET') {
      return { file: item.path, options: { contentType: contentType(item.path), cacheControl: 'private, max-age=0', headers: { 'Content-Disposition': 'inline' } } };
    }
    if (action === 'master.m3u8' && req.method === 'GET') return text(this.playback.masterPlaylist(session, item), 200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'private, no-store' });
    const variant = action.match(/^([a-z0-9]+)\.m3u8$/);
    if (variant && req.method === 'GET') return text(this.playback.variantPlaylist(session, item, variant[1]), 200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'private, no-store' });
    const segment = action.match(/^([a-z0-9]+)\/(\d+)\.ts$/);
    if (segment && req.method === 'GET') {
      const file = await this.playback.segment(session, item, segment[1], Number(segment[2]), user.id);
      return { file, options: { contentType: 'video/mp2t', cacheControl: 'private, max-age=3600' } };
    }
    throw new HttpError(404, 'Playback action not found');
  }

  async fileRoutes(req, res, url, user, body) {
    assert(user.role === 'admin' || user.canDownload || req.method === 'GET', 403, 'File access is disabled');
    const libraryId = Number(url.searchParams.get('libraryId'));
    assert(Number.isInteger(libraryId), 400, 'libraryId is required');
    this.assertLibrary(user, libraryId);
    const library = this.store.db.prepare("SELECT * FROM libraries WHERE id = ? AND type = 'files'").get(libraryId);
    assert(library, 404, 'File library not found');
    const requested = url.searchParams.get('path') || '';
    const { realCandidate } = await assertRealPath(library.path, requested);
    const stat = await fs.promises.stat(realCandidate);
    const action = url.pathname;
    if (action === '/api/files' && req.method === 'GET') {
      assert(stat.isDirectory(), 400, 'Path is not a folder');
      const entries = await fs.promises.readdir(realCandidate, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const entryStat = await fs.promises.stat(path.join(realCandidate, entry.name));
        const relative = path.join(requested, entry.name);
        files.push({ name: entry.name, path: relative, directory: entry.isDirectory(), size: entryStat.size, modified: entryStat.mtime.toISOString(),
          mime: entry.isDirectory() ? null : contentType(entry.name), downloadUrl: entry.isDirectory() ? null : `/api/files/download?libraryId=${libraryId}&path=${encodeURIComponent(relative)}` });
      }
      files.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      return json({ path: requested, parent: path.dirname(requested) === '.' ? '' : path.dirname(requested), files });
    }
    if (action === '/api/files/download' && req.method === 'GET') {
      assert(user.role === 'admin' || user.canDownload, 403, 'Downloads are disabled for this account');
      if (stat.isDirectory()) {
        assert(req.method === 'GET', 405, 'Method not allowed');
        const entries = await collect(library.path, requested);
        await streamZip(res, entries);
        this.store.activity('info', 'Folder downloaded', { userId: user.id, libraryId, path: requested });
        return null;
      }
      this.store.activity('info', 'File downloaded', { userId: user.id, libraryId, path: requested });
      return { file: realCandidate, options: { contentType: contentType(realCandidate), headers: { 'Content-Disposition': contentDisposition(entryName(realCandidate), path.extname(realCandidate)) }, cacheControl: 'private, no-store' } };
    }
    if (action === '/api/files/preview' && req.method === 'GET') {
      assert(user.role === 'admin' || user.canDownload, 403, 'Preview is disabled for this account');
      assert(stat.isFile(), 400, 'Preview requires a file');
      const extension = path.extname(realCandidate).toLowerCase();
      const previewable = IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension) || ['.pdf', '.txt', '.md', '.json', '.csv', '.xml'].includes(extension);
      assert(previewable, 415, 'Preview is not available for this file type');
      if (['.txt', '.md', '.json', '.csv', '.xml'].includes(extension)) {
        assert(stat.size <= 1024 * 1024, 413, 'Text preview is limited to 1 MB');
        const content = await fs.promises.readFile(realCandidate);
        return text(content.toString('utf8'), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
      }
      assert(stat.size <= 2 * 1024 ** 3, 413, 'File is too large to preview');
      return { file: realCandidate, options: { contentType: contentType(realCandidate), cacheControl: 'private, max-age=0', headers: { 'Content-Disposition': 'inline' } } };
    }
    throw new HttpError(404, 'File action not found');
  }

  async adminRoutes(req, res, url, user, body) {
    this.requireUser(req, true);
    const pathname = url.pathname;
    const db = this.store.db;
    if (pathname === '/api/admin/stats' && req.method === 'GET') return this.stats();
    if (pathname === '/api/admin/activity' && req.method === 'GET') return json({ activity: db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(Math.min(500, Number(url.searchParams.get('limit')) || 100)) });
    if (pathname === '/api/admin/notifications' && req.method === 'GET') return json({ notifications: this.notifications() });
    if (pathname === '/api/admin/storage' && req.method === 'GET') return json({ storage: await this.storage() });
    if (pathname === '/api/admin/settings' && req.method === 'GET') return json({ settings: this.publicSettings(), secrets: { tmdbKey: this.store.secretConfigured('tmdbKey'), musicBrainzToken: this.store.secretConfigured('musicBrainzToken') } });
    if (pathname === '/api/admin/settings' && req.method === 'PATCH') {
      const current = this.store.settings();
      const allowed = ['serverName', 'port', 'bindAddress', 'remoteMode', 'remoteEnabled', 'remotePublicUrl', 'transcodeMode', 'allowHardwareTranscoding', 'maxConcurrentTranscodes', 'transcodeCacheGB', 'scanOnStartup', 'hardwareEncoder'];
      const update = {};
      for (const key of allowed) if (body[key] !== undefined) update[key] = body[key];
      if (update.port !== undefined) assert(Number.isInteger(update.port) && update.port >= 1024 && update.port <= 65535, 400, 'Invalid port');
      if (update.bindAddress !== undefined) assert(['0.0.0.0', '::', '127.0.0.1', '::1'].includes(update.bindAddress), 400, 'Invalid bind address');
      if (update.serverName !== undefined) assert(String(update.serverName).length >= 1 && String(update.serverName).length <= 60, 400, 'Invalid server name');
      if (update.remoteMode !== undefined) assert(['off', 'vpn', 'tunnel', 'proxy'].includes(update.remoteMode), 400, 'Invalid remote access mode');
      if (update.remoteEnabled !== undefined) update.remoteEnabled = Boolean(update.remoteEnabled);
      if (update.remotePublicUrl) assert(/^https:\/\/[^\s/@]+$/i.test(update.remotePublicUrl), 400, 'Remote URL must use HTTPS');
      if (update.transcodeMode !== undefined) assert(['auto', 'software'].includes(update.transcodeMode), 400, 'Invalid transcoding mode');
      if (update.allowHardwareTranscoding !== undefined) update.allowHardwareTranscoding = Boolean(update.allowHardwareTranscoding);
      if (update.maxConcurrentTranscodes !== undefined) update.maxConcurrentTranscodes = Math.max(1, Math.min(8, Number(update.maxConcurrentTranscodes) || 2));
      if (update.transcodeCacheGB !== undefined) update.transcodeCacheGB = Math.max(0.5, Math.min(100, Number(update.transcodeCacheGB) || 2));
      if (update.scanOnStartup !== undefined) update.scanOnStartup = Boolean(update.scanOnStartup);
      if (update.hardwareEncoder !== undefined) assert(['', 'nvenc', 'qsv', 'amf'].includes(update.hardwareEncoder), 400, 'Invalid hardware encoder');
      this.store.setSettings(update);
      this.writeBootstrap();
      this.store.activity('info', 'Server settings updated', { keys: Object.keys(update) });
      if (current.remoteMode !== update.remoteMode || current.remoteEnabled !== update.remoteEnabled) {
        if (update.remoteEnabled && update.remoteMode === 'tunnel') await this.remote.startTunnel(); else await this.remote.stopTunnel();
      }
      return json({ settings: this.publicSettings(), restartRequired: update.port !== undefined && update.port !== current.port || update.bindAddress !== undefined && update.bindAddress !== current.bindAddress });
    }
    if (pathname === '/api/admin/settings/secrets' && req.method === 'POST') {
      for (const [key, secret] of Object.entries({ tmdbKey: 'tmdbKey', musicBrainzToken: 'musicBrainzToken' })) {
        if (body[key] !== undefined) {
          if (body[key] === '') db.prepare('DELETE FROM secrets WHERE name = ?').run(secret);
          else { assert(String(body[key]).length >= 8 && String(body[key]).length <= 1024, 400, 'Invalid API credential'); this.store.setSecret(secret, String(body[key])); }
        }
      }
      db.prepare('DELETE FROM metadata_cache').run();
      this.store.activity('info', 'Metadata provider credentials updated');
      return json({ ok: true });
    }
    if (pathname === '/api/admin/libraries' && req.method === 'POST') {
      const name = String(body.name || '').trim();
      const type = String(body.type || '');
      const libraryPath = path.resolve(String(body.path || ''));
      assert(name.length >= 1 && name.length <= 80 && LIBRARY_TYPES.has(type), 400, 'Invalid library name or category');
      assert(path.isAbsolute(String(body.path || '')) && fs.existsSync(libraryPath) && fs.statSync(libraryPath).isDirectory(), 400, 'Choose an existing absolute folder path');
      const now = isoNow();
      const result = db.prepare('INSERT INTO libraries(name, path, type, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?)').run(name, libraryPath, type, now, now);
      const id = Number(result.lastInsertRowid);
      this.store.activity('info', `Library added: ${name}`, { libraryId: id });
      this.scanner.enqueue(id).catch(error => this.logger.warn('Library scan failed', { message: error.message }));
      return json({ library: db.prepare('SELECT * FROM libraries WHERE id = ?').get(id) }, 201);
    }
    const libraryMatch = pathname.match(/^\/api\/admin\/libraries\/(\d+)(?:\/(scan))?$/);
    if (libraryMatch) {
      const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(libraryMatch[1]));
      assert(library, 404, 'Library not found');
      if (libraryMatch[2] === 'scan' && req.method === 'POST') return json({ scan: await this.scanner.enqueue(library.id, { full: Boolean(body.full) }) });
      if (!libraryMatch[2] && req.method === 'PATCH') {
        const name = body.name === undefined ? library.name : String(body.name).trim();
        const enabled = body.enabled === undefined ? library.enabled : Boolean(body.enabled);
        assert(name.length >= 1 && name.length <= 80, 400, 'Invalid library name');
        db.prepare('UPDATE libraries SET name = ?, enabled = ?, updatedAt = ? WHERE id = ?').run(name, enabled, isoNow(), library.id);
        return json({ library: db.prepare('SELECT * FROM libraries WHERE id = ?').get(library.id) });
      }
      if (!libraryMatch[2] && req.method === 'DELETE') {
        assert(db.prepare('SELECT count(*) AS count FROM libraries').get().count > 0, 400, 'Cannot delete library');
        db.prepare('DELETE FROM libraries WHERE id = ?').run(library.id);
        db.prepare('DELETE FROM playback_state WHERE itemId NOT IN (SELECT id FROM media_items)').run();
        db.prepare('DELETE FROM favorites WHERE itemId NOT IN (SELECT id FROM media_items)').run();
        db.prepare('DELETE FROM watchlist WHERE itemId NOT IN (SELECT id FROM media_items)').run();
        db.prepare('DELETE FROM collection_items WHERE itemId NOT IN (SELECT id FROM media_items)').run();
        db.prepare('DELETE FROM collections WHERE id NOT IN (SELECT DISTINCT collectionId FROM collection_items)').run();
        this.store.activity('info', `Library removed: ${library.name}`, { libraryId: library.id });
        return json({ ok: true });
      }
    }
    if (pathname === '/api/admin/scan' && req.method === 'POST') {
      const libraries = db.prepare('SELECT id FROM libraries WHERE enabled = 1').all();
      const failed = [];
      for (const library of libraries) {
        try { await this.scanner.enqueue(library.id, { full: Boolean(body.full) }); }
        catch (error) { failed.push({ libraryId: library.id, message: error.message }); }
      }
      return json({ ok: failed.length === 0, libraries: libraries.length, failed });
    }
    if (pathname === '/api/admin/scan' && req.method === 'GET') return json({ scan: { ...this.scanner.progress, metadataPending: this.metadata.pending }, sessions: this.playback.activeSessions() });
    if (pathname === '/api/admin/users' && req.method === 'GET') return json({ users: db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser) });
    if (pathname === '/api/admin/users' && req.method === 'POST') return this.saveUser(body);
    const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)(?:\/(revoke))?$/);
    if (userMatch) return this.modifyUser(req, userMatch, body);
    if (pathname === '/api/admin/diagnostics' && req.method === 'GET') return this.diagnostics();
    if (pathname === '/api/admin/logs' && req.method === 'GET') {
      const day = new Date().toISOString().slice(0, 10);
      const logPath = path.join(this.dataDir, 'logs', `server-${day}.log`);
      const logs = fs.existsSync(logPath) ? (await fs.promises.readFile(logPath, 'utf8')).split('\n').slice(-Number(url.searchParams.get('lines')) || -300).join('\n') : '';
      return text(logs, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    if (pathname === '/api/admin/backups' && req.method === 'GET') {
      const files = await fs.promises.readdir(path.join(this.dataDir, 'backups')).catch(() => []);
      return json({ backups: files.filter(name => /^\d{4}-\d{2}-\d{2}T[\d.-]+\.hearthbackup$/.test(name)).sort().reverse().map(name => ({ name, created: name.slice(0, 19).replace('T', ' ') })) });
    }
    if (pathname === '/api/admin/backups' && req.method === 'POST') {
      const name = `${new Date().toISOString().replace(/:/g, '-')}.hearthbackup`;
      const target = path.join(this.dataDir, 'backups', name).replace(/'/g, "''");
      db.exec(`VACUUM INTO '${target}'`);
      this.store.activity('info', 'Library backup created', { name });
      return json({ backup: { name } }, 201);
    }
    const backupMatch = pathname.match(/^\/api\/admin\/backups\/([A-Za-z0-9.-]+\.hearthbackup)\/download$/);
    if (backupMatch && req.method === 'GET') {
      assert(backupMatch[1].includes('T') && !backupMatch[1].includes('..'), 400, 'Invalid backup name');
      const file = path.join(this.dataDir, 'backups', backupMatch[1]);
      assert(fs.existsSync(file), 404, 'Backup not found');
      return { file, options: { contentType: 'application/octet-stream', headers: { 'Content-Disposition': `attachment; filename="${backupMatch[1]}"` } } };
    }
    if (pathname === '/api/admin/remote/test' && req.method === 'POST') return json(await this.remote.test());
    if (pathname === '/api/admin/remote/tunnel/start' && req.method === 'POST') {
      this.store.setSettings({ remoteMode: 'tunnel', remoteEnabled: true });
      await this.remote.startTunnel();
      return json(await this.remote.status());
    }
    if (pathname === '/api/admin/remote/tunnel/stop' && req.method === 'POST') {
      await this.remote.stopTunnel();
      this.store.setSettings({ remoteEnabled: false });
      return json(await this.remote.status());
    }
    if (pathname === '/api/admin/metadata/search' && req.method === 'GET') return json({ results: await this.metadata.search(url.searchParams.get('itemId'), url.searchParams.get('q')) });
    if (pathname === '/api/admin/metadata/apply' && req.method === 'POST') {
      assert(/^[a-f0-9]{24}$/.test(body.itemId || ''), 400, 'Invalid item');
      await this.metadata.apply(body.itemId, body.externalId);
      return json({ ok: true });
    }
    const itemEdit = pathname.match(/^\/api\/admin\/items\/([a-f0-9]{24})$/);
    if (itemEdit && req.method === 'PATCH') {
      const item = await this.getItemForUser(itemEdit[1], user);
      const fields = ['title', 'overview', 'year', 'genres', 'artist', 'album', 'albumArtist', 'track', 'disc', 'rating', 'director', 'cast', 'studios', 'tagline'];
      const updates = [];
      const params = [];
      for (const field of fields) {
        if (body[field] === undefined) continue;
        if (['genres', 'cast', 'studios'].includes(field)) { assert(Array.isArray(body[field]) && body[field].length <= 100, 400, `${field} must be an array`); updates.push(`${field} = ?`); params.push(JSON.stringify(body[field])); }
        else if (['year', 'track', 'disc'].includes(field)) { const value = body[field] === null || body[field] === '' ? null : Number(body[field]); assert(value === null || Number.isFinite(value), 400, `Invalid ${field}`); updates.push(`${field} = ?`); params.push(value); }
        else if (field === 'rating') { const value = body[field] === null || body[field] === '' ? null : Number(body[field]); assert(value === null || value >= 0 && value <= 10, 400, 'Rating must be between 0 and 10'); updates.push('rating = ?'); params.push(value); }
        else { updates.push(`${field} = ?`); params.push(String(body[field]).slice(0, field === 'overview' ? 10000 : 500)); }
      }
      if (updates.length) {
        updates.push('metadataSource = ?', 'updatedAt = ?'); params.push('manual', isoNow());
        db.prepare(`UPDATE media_items SET ${updates.join(', ')} WHERE id = ?`).run(...params, item.id);
        db.prepare('UPDATE media_items SET sortTitle = lower(title) WHERE id = ?').run(item.id);
        this.store.activity('info', `Metadata edited: ${item.title}`, { itemId: item.id });
      }
      return json({ ok: true });
    }
    throw new HttpError(404, 'Admin action not found');
  }

  saveUser(body) {
    const db = this.store.db;
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    assert(/^[A-Za-z0-9._-]{3,64}$/.test(username), 400, 'Username must be 3–64 valid characters');
    assert(password.length >= 12 && password.length <= 1024, 400, 'Use at least 12 characters');
    const allowedLibraries = this.validateLibraryPermissions(body.allowedLibraries);
    const role = body.role === 'admin' ? 'admin' : 'user';
    const now = isoNow();
    const result = db.prepare(`INSERT INTO users(username, passwordHash, role, allowedLibraries, canDownload, createdAt, updatedAt)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(username, passwordHash(password), role, JSON.stringify(allowedLibraries), body.canDownload === false ? 0 : 1, now, now);
    this.store.activity('info', `Account created: ${username}`, { userId: Number(result.lastInsertRowid) });
    return json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid))) }, 201);
  }

  validateLibraryPermissions(value) {
    if (!Array.isArray(value)) return [];
    const ids = value.map(Number).filter(Number.isInteger);
    for (const id of ids) assert(this.store.db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(id), 400, 'Library permission contains an unknown library');
    return [...new Set(ids)];
  }

  async modifyUser(req, match, body) {
    const db = this.store.db;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(match[1]));
    assert(user, 404, 'User not found');
    if (match[2] === 'revoke' && req.method === 'POST') {
      db.prepare('UPDATE sessions SET revoked = 1 WHERE userId = ?').run(user.id);
      return json({ ok: true });
    }
    if (req.method === 'DELETE') {
      assert(user.role !== 'admin' || db.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin'").get().count > 1, 400, 'Cannot delete the last administrator');
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      this.store.activity('info', `Account deleted: ${user.username}`, { userId: user.id });
      return json({ ok: true });
    }
    assert(req.method === 'PATCH', 405, 'Method not allowed');
    const updates = [];
    const params = [];
    if (body.username !== undefined) {
      const username = String(body.username).trim();
      assert(/^[A-Za-z0-9._-]{3,64}$/.test(username), 400, 'Invalid username');
      updates.push('username = ?'); params.push(username);
    }
    if (body.password !== undefined && body.password !== '') {
      assert(String(body.password).length >= 12 && String(body.password).length <= 1024, 400, 'Use at least 12 characters');
      updates.push('passwordHash = ?'); params.push(passwordHash(String(body.password)));
      db.prepare('UPDATE sessions SET revoked = 1 WHERE userId = ?').run(user.id);
    }
    if (body.allowedLibraries !== undefined) {
      updates.push('allowedLibraries = ?'); params.push(JSON.stringify(this.validateLibraryPermissions(body.allowedLibraries)));
    }
    if (body.canDownload !== undefined) { updates.push('canDownload = ?'); params.push(body.canDownload ? 1 : 0); }
    if (body.disabled !== undefined) {
      assert(user.role !== 'admin' || !body.disabled || db.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin'").get().count > 1, 400, 'Cannot disable the last administrator');
      updates.push('disabled = ?'); params.push(body.disabled ? 1 : 0);
      if (body.disabled) db.prepare('UPDATE sessions SET revoked = 1 WHERE userId = ?').run(user.id);
    }
    if (body.role !== undefined) {
      assert(['admin', 'user'].includes(body.role), 400, 'Invalid role');
      assert(user.role !== 'admin' || body.role === 'admin' || db.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin'").get().count > 1, 400, 'Cannot demote the last administrator');
      updates.push('role = ?'); params.push(body.role);
    }
    if (updates.length) {
      updates.push('updatedAt = ?'); params.push(isoNow(), user.id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      this.store.activity('info', `Account updated: ${user.username}`, { userId: user.id });
    }
    return json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
  }

  publicSettings() {
    const settings = this.store.settings();
    return { ...settings, maxConcurrentTranscodes: Math.max(1, Math.min(8, Number(settings.maxConcurrentTranscodes) || 2)), transcodeCacheGB: Math.max(0.5, Number(settings.transcodeCacheGB) || 2) };
  }

  notifications() {
    const notifications = [];
    const missing = this.store.db.prepare('SELECT count(*) AS count FROM media_items WHERE missing = 1').get().count;
    if (missing) notifications.push({ level: 'warning', code: 'missing-files', message: `${missing} indexed file${missing === 1 ? '' : 's'} cannot be found`, action: 'library' });
    if (!this.store.secretConfigured('tmdbKey')) notifications.push({ level: 'info', code: 'metadata-key', message: 'Add a TMDB API key for richer movie and TV artwork and descriptions', action: 'metadata' });
    const settings = this.store.settings();
    if (settings.remoteMode === 'tunnel') notifications.push({ level: 'warning', code: 'temporary-tunnel', message: 'Cloudflare quick tunnels are temporary; use a VPN or named proxy for a permanent address', action: 'network' });
    if (settings.remoteMode === 'off') notifications.push({ level: 'info', code: 'remote-off', message: 'Remote internet access is off; your server is reachable only on configured interfaces', action: 'network' });
    return notifications;
  }

  async storage() {
    const libraries = [];
    const devices = new Map();
    for (const library of this.store.db.prepare('SELECT * FROM libraries').all()) {
      let disk = null;
      try {
        const stat = await fs.promises.statfs(library.path);
        disk = { size: stat.blocks * stat.bsize, free: stat.bavail * stat.bsize };
        devices.set(String(stat.dev), disk);
      } catch { /* unavailable libraries remain visible */ }
      const counts = this.store.db.prepare('SELECT type, count(*) AS count, COALESCE(sum(fileBytes), 0) AS bytes FROM media_items WHERE libraryId = ? AND missing = 0 GROUP BY type').all(library.id);
      libraries.push({ id: library.id, name: library.name, path: library.path, type: library.type, enabled: library.enabled, lastScanAt: library.lastScanAt, disk,
        media: counts.map(row => ({ type: row.type, count: row.count, bytes: row.bytes })) });
    }
    let systemDisk = null;
    try { const stat = await fs.promises.statfs(this.dataDir); systemDisk = { size: stat.blocks * stat.bsize, free: stat.bavail * stat.bsize }; } catch { /* non-fatal */ }
    return { libraries, systemDisk };
  }

  async stats() {
    const db = this.store.db;
    const storage = await this.storage();
    const counts = db.prepare("SELECT type, count(*) AS count FROM media_items WHERE missing = 0 GROUP BY type").all();
    const libraryCounts = {};
    counts.forEach(row => { libraryCounts[row.type] = row.count; });
    return json({
      status: 'online', version: VERSION, uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      cpu: { system: Number(this.systemCpu.toFixed(1)), process: Number((process.cpuUsage().user / 1000 / Math.max(1, (Date.now() - this.startedAt)) * 100).toFixed(2)) },
      memory: { processBytes: process.memoryUsage().rss, systemFreeBytes: os.freemem(), systemTotalBytes: os.totalmem() },
      network: { bytesPerSecond: Math.round(this.bytesPerSecond), totalBytes: this.bytesWritten || 0, addresses: this.remote.localAddresses() },
      activeUsers: this.store.activeUsers(), activeStreams: this.playback.activeSessions(),
      media: { ...libraryCounts, libraries: db.prepare('SELECT count(*) AS count FROM libraries').get().count, missing: db.prepare('SELECT count(*) AS count FROM media_items WHERE missing = 1').get().count },
      storage, scan: { ...this.scanner.progress, metadataPending: this.metadata.pending }, remote: await this.remote.status(),
      localUrl: `http://${this.remote.localAddresses()[0]?.address || '127.0.0.1'}:${this.store.settings().port}`
    });
  }

  async diagnostics() {
    let ffmpegVersion = '';
    try { ffmpegVersion = (await execFileAsync(path.join(this.ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), ['-version'], { timeout: 10000 })).stdout.split('\n')[0]; }
    catch (error) { ffmpegVersion = `Unavailable: ${error.message}`; }
    return json({ node: process.version, platform: `${os.platform()} ${os.release()}`, ffmpeg: ffmpegVersion,
      encoders: await this.playback.availableEncoders(), cloudflaredBundled: Boolean(this.cloudflared),
      database: path.join(this.dataDir, 'library.sqlite'), remote: await this.remote.status() });
  }

  async close() {
    clearInterval(this.monitor);
    clearInterval(this.playback.cleanupTimer);
    await this.remote.stopTunnel();
    this.server.close();
    this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.store.close();
  }
}

function parsePreferences(value) {
  const defaults = { autoplay: true, audioLanguage: '', subtitleLanguage: '', quality: 'auto' };
  try { return { ...defaults, ...JSON.parse(value || '{}') }; } catch { return defaults; }
}

function contentDisposition(title, extension) {
  const fallback = safeName(title).replace(/[^A-Za-z0-9._-]/g, '_') + extension;
  const preferred = safeName(title) + extension;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(preferred)}`;
}

function entryName(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

module.exports = { HearthServer, VERSION };
