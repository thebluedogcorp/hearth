'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchJson, parseJsonArray } = require('./util');

const TMDB_IMAGE = 'https://image.tmdb.org/t/p/';
const ONE_DAY = 86400000;

class MetadataService {
  constructor({ store, logger }) {
    this.store = store;
    this.db = store.db;
    this.logger = logger;
    this.videoQueue = Promise.resolve();
    this.musicQueue = Promise.resolve();
    this.musicLastRequest = 0;
    this.workers = 0;
    this.pending = 0;
  }

  cacheGet(key, maxAge = 30 * ONE_DAY) {
    const row = this.db.prepare('SELECT response, createdAt FROM metadata_cache WHERE key = ?').get(key);
    if (!row || Date.now() - new Date(row.createdAt).getTime() > maxAge) return null;
    try { return JSON.parse(row.response); } catch { return null; }
  }

  cacheSet(key, value) {
    this.db.prepare(`INSERT INTO metadata_cache(key, response, createdAt) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET response = excluded.response, createdAt = excluded.createdAt`)
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  queueVideo(item) {
    this.pending++;
    const job = this.videoQueue.then(() => this.refreshVideo(item)).catch(error => {
      this.logger.warn('Video metadata refresh failed', { item: item.title, message: error.message });
    }).finally(() => { this.pending--; });
    this.videoQueue = job;
    return job;
  }

  queueMusic(item) {
    this.pending++;
    const job = this.musicQueue.then(() => this.refreshMusic(item)).catch(error => {
      this.logger.warn('Music metadata refresh failed', { item: item.title, message: error.message });
    }).finally(() => { this.pending--; });
    this.musicQueue = job;
    return job;
  }

  async tmdb(endpoint, params = {}) {
    const key = this.store.getSecret('tmdbKey');
    if (!key) return null;
    const query = new URLSearchParams({ ...params, api_key: key });
    const url = `https://api.themoviedb.org/3/${endpoint}?${query}`;
    const cacheKey = `tmdb:${endpoint}?${new URLSearchParams(params)}`;
    const cached = this.cacheGet(cacheKey, 30 * ONE_DAY);
    if (cached) return cached;
    const data = await fetchJson(url, { headers: { Accept: 'application/json' } }, 20000);
    this.cacheSet(cacheKey, data);
    return data;
  }

  async searchTmdb(kind, query, year = null) {
    const data = await this.tmdb(`search/${kind === 'tv' ? 'tv' : 'movie'}`, { query, ...(year ? { year } : {}), include_adult: 'false' });
    return (data?.results || []).slice(0, 12).map(result => ({
      externalId: String(result.id), title: result.title || result.name, year: Number((result.release_date || result.first_air_date || '').slice(0, 4)) || null,
      overview: result.overview || '', poster: result.poster_path ? `${TMDB_IMAGE}w500${result.poster_path}` : null
    }));
  }

  async searchMusic(item, query = null) {
    const token = this.store.getSecret('musicBrainzToken');
    const recording = query || `recording:"${(item.title || '').replace(/["\\]/g, '')}"`;
    const artist = item.artist ? ` AND artist:"${item.artist.replace(/["\\]/g, '')}"` : '';
    const queryUrl = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(recording + artist)}&fmt=json&limit=8`;
    const cached = this.cacheGet(`musicbrainz:${queryUrl}`, 7 * ONE_DAY);
    const data = cached || await this.musicRequest(queryUrl, token);
    if (!cached && data) this.cacheSet(`musicbrainz:${queryUrl}`, data);
    return (data?.recordings || []).map(result => ({
      externalId: result.id, title: result.title, artist: result['artist-credit']?.map(artist => artist.name).join(', ') || item.artist,
      album: result.releases?.[0]?.title || item.album, year: result.releases?.[0]?.date?.slice(0, 4) || null
    }));
  }

  async musicRequest(url, token) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 1100 - (Date.now() - this.musicLastRequest))));
    this.musicLastRequest = Date.now();
    return fetchJson(url, { headers: { Accept: 'application/json', 'User-Agent': `HearthMediaServer/1.0 (${process.env.HEARTH_CONTACT_URL || 'self-hosted'})`, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, 25000);
  }

  async refreshVideo(item, forcedId = null) {
    const isTv = item.type === 'episode';
    const kind = isTv ? 'tv' : 'movie';
    let details = null;
    if (forcedId) {
      details = await this.tmdb(`${kind}/${forcedId}`, { append_to_response: 'credits,external_ids' });
      if (!details) return false;
    } else {
      const matches = await this.searchTmdb(kind, item.showTitle || item.title, item.year || null);
      if (!matches?.length) return false;
      const match = matches[0];
      details = await this.tmdb(`${kind}/${match.externalId}`, { append_to_response: 'credits,external_ids' });
      if (!details) return false;
    }
    const now = new Date().toISOString();
    const genres = (details.genres || []).map(genre => genre.name);
    const posterPath = await this.cacheImage(details.poster_path, `${TMDB_IMAGE}w780${details.poster_path}`, `${details.id}-poster`);
    const backdropPath = await this.cacheImage(details.backdrop_path, `${TMDB_IMAGE}w1280${details.backdrop_path}`, `${details.id}-backdrop`);
    if (isTv) {
      this.db.prepare(`UPDATE shows SET title = ?, originalTitle = ?, overview = ?, year = ?, genres = ?, rating = ?, ratingCount = ?,
        externalId = ?, metadataSource = 'tmdb', metadataJson = ?, posterPath = COALESCE(?, posterPath), backdropPath = COALESCE(?, backdropPath),
        studio = ?, tagline = ?, updatedAt = ? WHERE id = ?`).run(
        details.name, details.original_name, details.overview, Number(details.first_air_date?.slice(0, 4)) || null, JSON.stringify(genres),
        details.vote_average || null, details.vote_count || null, String(details.id), JSON.stringify(details), posterPath, backdropPath,
        details.networks?.[0]?.name || '', details.tagline || '', now, item.showId
      );
      const season = await this.tmdb(`tv/${details.id}/season/${item.seasonNumber || 1}`);
      const episode = season?.episodes?.find(entry => entry.episode_number === item.episodeNumber);
      if (episode) {
        this.db.prepare(`UPDATE media_items SET episodeTitle = ?, overview = ?, runtimeMs = COALESCE(?, runtimeMs), externalId = ?,
          metadataSource = 'tmdb', metadataJson = ?, backdropPath = COALESCE(?, backdropPath), updatedAt = ? WHERE id = ?`).run(
          episode.name, episode.overview, Math.round((episode.runtime || 0) * 60000) || null, String(episode.id), JSON.stringify(episode),
          await this.cacheImage(episode.still_path, `${TMDB_IMAGE}w780${episode.still_path}`, `${episode.id}-still`), now, item.id
        );
      } else {
        this.db.prepare('UPDATE media_items SET externalId = ?, metadataSource = ?, metadataJson = ?, updatedAt = ? WHERE id = ?')
          .run(String(details.id), 'tmdb-show', JSON.stringify(details), now, item.id);
      }
      const cast = (details.credits?.cast || []).slice(0, 16).map(person => ({ name: person.name, character: person.character, profile: person.profile_path ? `${TMDB_IMAGE}w185${person.profile_path}` : null }));
      this.db.prepare('UPDATE shows SET metadataJson = ? WHERE id = ?').run(JSON.stringify({ ...details, cast }), item.showId);
    } else {
      const cast = (details.credits?.cast || []).slice(0, 16).map(person => ({ name: person.name, character: person.character }));
      const director = (details.credits?.crew || []).find(person => person.job === 'Director')?.name || '';
      this.db.prepare(`UPDATE media_items SET title = ?, originalTitle = ?, overview = ?, year = ?, genres = ?, rating = ?, ratingCount = ?,
        tagline = ?, director = ?, cast = ?, studios = ?, externalId = ?, metadataSource = 'tmdb', metadataJson = ?,
        posterPath = COALESCE(?, posterPath), backdropPath = COALESCE(?, backdropPath), updatedAt = ? WHERE id = ?`).run(
        details.title, details.original_title, details.overview, Number(details.release_date?.slice(0, 4)) || null, JSON.stringify(genres),
        details.vote_average || null, details.vote_count || null, details.tagline || '', director, JSON.stringify(cast),
        JSON.stringify((details.production_companies || []).map(company => company.name)), String(details.id), JSON.stringify(details),
        posterPath, backdropPath, now, item.id
      );
    }
    return true;
  }

  async refreshMusic(item, forcedId = null) {
    let details = null;
    let externalId = forcedId;
    if (forcedId) {
      const url = `https://musicbrainz.org/ws/2/recording/${forcedId}?fmt=json&inc=artists+releases+release-groups`;
      details = this.cacheGet(url, 30 * ONE_DAY) || await this.musicRequest(url, this.store.getSecret('musicBrainzToken'));
    } else {
      const matches = await this.searchMusic(item);
      if (!matches?.length) return false;
      const match = matches[0];
      externalId = match.externalId;
      const url = `https://musicbrainz.org/ws/2/recording/${match.externalId}?fmt=json&inc=artists+releases+release-groups`;
      details = this.cacheGet(url, 30 * ONE_DAY) || await this.musicRequest(url, this.store.getSecret('musicBrainzToken'));
    }
    if (!details) return false;
    const release = details.releases?.[0];
    let artwork = null;
    if (release?.id) {
      const coverUrl = `https://coverartarchive.org/release/${release.id}/front-500.jpg`;
      artwork = await this.cacheImage(true, coverUrl, `${externalId}-cover`, true);
    }
    this.db.prepare(`UPDATE media_items SET title = ?, artist = ?, albumArtist = ?, album = ?, year = ?, externalId = ?,
      metadataSource = 'musicbrainz', metadataJson = ?, posterPath = COALESCE(?, posterPath), thumbPath = COALESCE(?, thumbPath), updatedAt = ? WHERE id = ?`).run(
      details.title, details['artist-credit']?.map(artist => artist.name).join(', ') || item.artist,
      details['artist-credit']?.[0]?.name || item.albumArtist, release?.title || item.album,
      Number(release?.date?.slice(0, 4)) || item.year, details.id, JSON.stringify(details), artwork, artwork, new Date().toISOString(), item.id
    );
    return true;
  }

  async cacheImage(selector, url, id, optional = false) {
    if (!selector) return null;
    if (!url) return null;
    const target = path.join(this.store.dataDir, 'artwork', `${id.replace(/[^a-zA-Z0-9-]/g, '_')}.jpg`);
    if (fs.existsSync(target) && fs.statSync(target).size > 100) return target;
    try {
      const guard = AbortSignal.timeout(25000);
      const response = await fetch(url, { signal: guard, redirect: 'follow' });
      if (!response.ok) throw new Error(`Artwork request failed (${response.status})`);
      if (!/^image\//.test(response.headers.get('content-type') || '')) throw new Error('Upstream did not return an image');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 12 * 1024 * 1024 || bytes.length < 32) throw new Error('Invalid artwork size');
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, bytes);
      fs.renameSync(temporary, target);
      return target;
    } catch (error) {
      this.logger.warn('Could not cache artwork', { id, message: error.message });
      return null;
    }
  }

  async search(itemId, query) {
    const item = this.db.prepare('SELECT * FROM media_items WHERE id = ?').get(itemId);
    if (!item) return [];
    if (item.type === 'song') return this.searchMusic(item, query || item.title);
    return this.searchTmdb(item.type === 'episode' ? 'tv' : 'movie', query || item.showTitle || item.title, item.year || null);
  }

  async apply(itemId, externalId) {
    const item = this.db.prepare('SELECT * FROM media_items WHERE id = ?').get(itemId);
    if (!item) throw new Error('Item not found');
    const results = await this.search(itemId, item.showTitle || item.title);
    const selected = results.find(result => result.externalId === String(externalId));
    if (!selected) throw new Error('Metadata match not found; run a new search');
    const original = { ...item };
    if (item.type === 'song') {
      await this.refreshMusic({ ...item, title: selected.title, artist: selected.artist, album: selected.album }, String(externalId));
    } else {
      await this.refreshVideo(item, String(externalId));
    }
    this.store.activity('info', `Metadata matched manually: ${selected.title}`, { itemId });
  }
}

module.exports = { MetadataService };
