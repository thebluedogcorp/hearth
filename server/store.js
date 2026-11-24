'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { isoNow, passwordHash, randomToken } = require('./util');

const DEFAULTS = Object.freeze({
  serverName: 'Hearth',
  port: 7341,
  bindAddress: '0.0.0.0',
  remoteMode: 'off',
  remoteEnabled: false,
  remotePublicUrl: '',
  transcodeMode: 'auto',
  allowHardwareTranscoding: true,
  maxConcurrentTranscodes: 2,
  transcodeCacheGB: 2,
  scanOnStartup: true,
  hardwareEncoder: ''
});

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    allowedLibraries TEXT NOT NULL DEFAULT '[]',
    canDownload INTEGER NOT NULL DEFAULT 1,
    disabled INTEGER NOT NULL DEFAULT 0,
    preferences TEXT NOT NULL DEFAULT '{}',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastLoginAt TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tokenHash TEXT NOT NULL UNIQUE,
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrfToken TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    lastSeenAt TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    userAgent TEXT,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expiresAt);
  CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('movies', 'tv', 'music', 'files')),
    enabled INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastScanAt TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_libraries_path_type ON libraries(path, type);
  CREATE TABLE IF NOT EXISTS shows (
    id TEXT PRIMARY KEY,
    libraryId INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    sortTitle TEXT,
    originalTitle TEXT,
    overview TEXT,
    year INTEGER,
    genres TEXT NOT NULL DEFAULT '[]',
    rating REAL,
    ratingCount INTEGER,
    externalId TEXT,
    metadataSource TEXT,
    metadataJson TEXT,
    posterPath TEXT,
    backdropPath TEXT,
    studio TEXT,
    tagline TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shows_library ON shows(libraryId);
  CREATE TABLE IF NOT EXISTS media_items (
    id TEXT PRIMARY KEY,
    libraryId INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    relativePath TEXT NOT NULL,
    title TEXT NOT NULL,
    sortTitle TEXT,
    originalTitle TEXT,
    artist TEXT,
    albumArtist TEXT,
    album TEXT,
    track INTEGER,
    disc INTEGER,
    year INTEGER,
    overview TEXT,
    genres TEXT NOT NULL DEFAULT '[]',
    tagline TEXT,
    rating REAL,
    ratingCount INTEGER,
    runtimeMs INTEGER,
    width INTEGER,
    height INTEGER,
    videoCodec TEXT,
    audioCodec TEXT,
    container TEXT,
    fileBytes INTEGER,
    modifiedTime INTEGER,
    streams TEXT NOT NULL DEFAULT '[]',
    externalId TEXT,
    metadataSource TEXT,
    metadataJson TEXT,
    posterPath TEXT,
    backdropPath TEXT,
    thumbPath TEXT,
    showId TEXT,
    showTitle TEXT,
    seasonNumber INTEGER,
    episodeNumber INTEGER,
    episodeTitle TEXT,
    director TEXT,
    cast TEXT NOT NULL DEFAULT '[]',
    studios TEXT NOT NULL DEFAULT '[]',
    missing INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastScannedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_library_type ON media_items(libraryId, type, missing);
  CREATE INDEX IF NOT EXISTS idx_media_show ON media_items(showId, seasonNumber, episodeNumber);
  CREATE INDEX IF NOT EXISTS idx_music_artist ON media_items(artist);
  CREATE INDEX IF NOT EXISTS idx_music_album ON media_items(albumArtist, album, disc, track);
  CREATE INDEX IF NOT EXISTS idx_media_year ON media_items(year);
  CREATE INDEX IF NOT EXISTS idx_media_rating ON media_items(rating);
  CREATE INDEX IF NOT EXISTS idx_media_title ON media_items(sortTitle);
  CREATE TABLE IF NOT EXISTS metadata_cache (
    key TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playback_state (
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    itemId TEXT NOT NULL,
    positionMs INTEGER NOT NULL DEFAULT 0,
    durationMs INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    audioTrack INTEGER,
    subtitleTrack INTEGER,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY(userId, itemId)
  );
  CREATE INDEX IF NOT EXISTS idx_playback_recent ON playback_state(userId, updatedAt);
  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('collection', 'playlist')),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(userId, kind);
  CREATE TABLE IF NOT EXISTS collection_items (
    collectionId TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    itemId TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    addedAt TEXT NOT NULL,
    PRIMARY KEY(collectionId, itemId)
  );
  CREATE INDEX IF NOT EXISTS idx_collection_items_item ON collection_items(itemId);
  CREATE TABLE IF NOT EXISTS favorites (
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    itemId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY(userId, itemId)
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    itemId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY(userId, itemId)
  );
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_recent ON activity(id DESC);
  CREATE TABLE IF NOT EXISTS secrets (
    name TEXT PRIMARY KEY,
    encrypted TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`;

class Store {
  constructor(dataDir, logger) {
    this.dataDir = dataDir;
    this.logger = logger;
    for (const dir of ['artwork', 'cache/transcodes', 'backups', 'logs', 'runtime']) {
      fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
    }
    this.keyPath = path.join(dataDir, 'runtime', '.master-key');
    this.db = new DatabaseSync(path.join(dataDir, 'library.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32768;');
    this.db.exec(SCHEMA);
    const userColumns = this.db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
    if (!userColumns.includes('preferences')) this.db.exec("ALTER TABLE users ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}'");
    this.db.exec('PRAGMA user_version = 1;');
    this.sessions = new Map();
    this.masterKey = this.loadMasterKey();
    this.cleanup();
  }

  loadMasterKey() {
    if (fs.existsSync(this.keyPath)) {
      const key = fs.readFileSync(this.keyPath);
      if (key.length !== 32) throw new Error('Invalid master key');
      return key;
    }
    const key = require('node:crypto').randomBytes(32);
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    if (process.platform === 'win32') {
      try {
        const identity = require('node:child_process').execFileSync('whoami', [], { encoding: 'utf8' }).trim();
        const args = [this.keyPath, '/inheritance:r', '/grant:r', `${identity}:F`, 'SYSTEM:F'];
        require('node:child_process').execFileSync('icacls', args, { stdio: 'ignore' });
      } catch (error) {
        this.logger.warn('Could not restrict master key ACL; verify data directory permissions', { message: error.message });
      }
    } else {
      fs.chmodSync(this.keyPath, 0o600);
    }
    return key;
  }

  encrypt(name, value) {
    const crypto = require('node:crypto');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(Buffer.from(`hearth:${name}`));
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  decrypt(name, encoded) {
    const crypto = require('node:crypto');
    const [iv, tag, data] = String(encoded).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`hearth:${name}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  getSecret(name) {
    const row = this.db.prepare('SELECT encrypted FROM secrets WHERE name = ?').get(name);
    if (!row) return '';
    try { return this.decrypt(name, row.encrypted); }
    catch (error) {
      this.logger.error(`Unable to decrypt ${name}`, { message: error.message });
      return '';
    }
  }

  setSecret(name, value) {
    const now = isoNow();
    this.db.prepare(`INSERT INTO secrets(name, encrypted, updatedAt) VALUES(?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET encrypted = excluded.encrypted, updatedAt = excluded.updatedAt`)
      .run(name, this.encrypt(name, value), now);
  }

  secretConfigured(name) {
    return Boolean(this.db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(name));
  }

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return DEFAULTS[key];
    try { return JSON.parse(row.value); } catch { return DEFAULTS[key]; }
  }

  settings() {
    const output = { ...DEFAULTS };
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
      try { output[row.key] = JSON.parse(row.value); } catch { /* ignore malformed legacy entry */ }
    }
    return output;
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
  }

  setSettings(values) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(values)) this.setSetting(key, value);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  isConfigured() {
    return Boolean(this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get());
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  activity(level, message, details = null) {
    this.db.prepare('INSERT INTO activity(level, message, details, createdAt) VALUES(?, ?, ?, ?)')
      .run(level, message, details ? JSON.stringify(details) : null, isoNow());
    this.logger[level === 'warning' ? 'warn' : level === 'error' ? 'error' : 'info'](message, details || undefined);
    if (this.db.prepare('SELECT count(*) AS count FROM activity').get().count > 5000) {
      this.db.prepare(`DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 4000)`).run();
    }
  }

  createSession(userId, req, remember = true) {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const now = new Date();
    const expires = new Date(now.getTime() + (remember ? 30 : 1) * 86400000);
    const result = this.db.prepare(`INSERT INTO sessions(tokenHash, userId, csrfToken, expiresAt, createdAt, lastSeenAt, userAgent, ip)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
      require('./util').hashToken(token), userId, csrfToken, expires.toISOString(), now.toISOString(), now.toISOString(),
      String(req.headers['user-agent'] || '').slice(0, 300), String(req.socket.remoteAddress || '')
    );
    this.db.prepare('UPDATE users SET lastLoginAt = ? WHERE id = ?').run(now.toISOString(), userId);
    return { token, csrfToken, expiresAt: expires.toISOString(), id: Number(result.lastInsertRowid) };
  }

  getSession(token) {
    if (!token || token.length > 200) return null;
    const row = this.db.prepare(`SELECT s.id AS sessionId, s.csrfToken, s.expiresAt, s.revoked, s.lastSeenAt,
      u.id AS id, u.username, u.role, u.allowedLibraries, u.canDownload, u.disabled, u.preferences
      FROM sessions s JOIN users u ON u.id = s.userId WHERE s.tokenHash = ?`).get(require('./util').hashToken(token));
    if (!row || row.revoked || row.disabled || new Date(row.expiresAt) <= new Date()) return null;
    return row;
  }

  touchSession(sessionId) {
    this.sessions.set(sessionId, Date.now());
    if (this.sessions.size % 50 === 0) {
      const cutoff = new Date(Date.now() - 86400000).toISOString();
      this.db.prepare('UPDATE sessions SET revoked = 1 WHERE expiresAt < ? OR lastSeenAt < ?').run(cutoff, new Date(Date.now() - 45 * 86400000).toISOString());
    }
  }

  activeUsers() {
    const cutoff = Date.now() - 60000;
    for (const [id, seen] of this.sessions) if (seen < cutoff) this.sessions.delete(id);
    return this.sessions.size;
  }

  cleanup() {
    this.db.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(new Date().toISOString());
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store, DEFAULTS };
