'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'test', '.tmp-data');
const MEDIA = path.join(ROOT, 'test', '.tmp-media');
const setupToken = crypto.randomBytes(32).toString('hex');

function cleanup() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(MEDIA, { recursive: true, force: true });
  fs.mkdirSync(path.join(MEDIA, 'Movies'), { recursive: true });
  fs.mkdirSync(path.join(MEDIA, 'Music', 'Artist', 'Album'), { recursive: true });
  fs.mkdirSync(path.join(MEDIA, 'Files', 'Documents'), { recursive: true });
}

cleanup();
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', path.join(MEDIA, 'Movies', 'Example Movie (2020).mkv')]);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '8', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(MEDIA, 'Music', 'Artist', 'Album', '01 Example Track.mp3')]);
fs.writeFileSync(path.join(MEDIA, 'Files', 'Documents', 'notes.txt'), 'A download and preview test file.\n');
fs.writeFileSync(path.join(MEDIA, 'Files', 'Documents', '..ignored.txt'), 'not indexed');

const { HearthServer } = require('../server/server');
const server = new HearthServer({ dataDir: DATA, ffmpegDir: '', cloudflared: '', setupToken });
server.store.setSetting('port', Number(process.env.HEARTH_TEST_PORT || 7341));

let passed = 0;
function check(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`PASS ${label}`);
}
async function request(method, urlPath, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${server.server.address().port}${urlPath}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual'
  });
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(buffer);
  let data;
  const binary = ['video/mp2t', 'application/zip', 'image/'].some(type => (response.headers.get('content-type') || '').includes(type));
  if (binary) data = Buffer.from(buffer);
  else {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { status: response.status, data, headers: response.headers };
}

(async () => {
  await server.listen();
  let health = await request('GET', '/api/health');
  check(health.status === 200 && health.data.configured === false, 'health endpoint before setup');
  const shell = await fetch(`http://127.0.0.1:${server.server.address().port}/`);
  check((shell.headers.get('content-type') || '').startsWith('text/html'), 'web shell served with HTML MIME type');
  check((await request('GET', '/api/admin/stats')).status === 401, 'admin APIs reject anonymous requests');
  const availability = await request('GET', '/api/setup');
  check(availability.status === 200 && availability.data.configured === false && availability.data.browserSetup === true, 'browser can query first-run availability');
  check((await request('POST', '/api/setup', { step: 'complete', serverName: 'X', port: 70000, admin: { username: 'admin', password: 'short' }, libraries: [], remote: { mode: 'off' } })).status === 400, 'browser setup validates payload without desktop secret');
  const setup = await request('POST', '/api/setup', {
    step: 'complete', serverName: 'Test Hearth', port: server.server.address().port, bindAddress: '127.0.0.1',
    admin: { username: 'owner', password: 'correct horse battery staple' },
    libraries: [
      { name: 'Films', path: path.join(MEDIA, 'Movies'), type: 'movies' },
      { name: 'Music', path: path.join(MEDIA, 'Music'), type: 'music' },
      { name: 'Downloads', path: path.join(MEDIA, 'Files'), type: 'files' }
    ], remote: { mode: 'off', enabled: false }
  }, { 'X-Hearth-Setup': setupToken });
  check(setup.status === 200 && setup.data.token, 'first-run setup creates admin session');
  check(setup.headers.get('set-cookie')?.includes('HttpOnly'), 'setup response sets secure session cookie');
  check((await request('GET', '/api/setup')).status === 403, 'browser setup window closes after configuration');
  check((await request('POST', '/api/setup', { step: 'complete' }, { 'X-Hearth-Setup': setupToken })).status === 409, 're-running setup is rejected');
  const auth = { Authorization: `Bearer ${setup.data.token}`, 'X-Hearth-Desktop': '1' };
  const users = await request('POST', '/api/admin/users', { username: 'viewer', password: 'a strong viewer password', allowedLibraries: [1, 3], canDownload: true }, auth);
  check(users.status === 201 && users.data.user.role === 'user', 'create restricted user account');
  const userId = users.data.user.id;
  check((await request('GET', '/api/admin/stats', undefined, auth)).status === 200, 'admin dashboard stats');
  check((await request('GET', '/api/admin/users', undefined, auth)).data.users.length === 2, 'list user accounts');
  check((await request('POST', '/api/auth/login', { username: 'owner', password: 'wrong password' })).status === 401, 'wrong password rejected');
  const login = await request('POST', '/api/auth/login', { username: 'owner', password: 'correct horse battery staple' }, { 'X-Hearth-Desktop': '1' });
  check(login.status === 200 && login.data.token && login.headers.get('set-cookie')?.includes('HttpOnly'), 'desktop login returns token and secure cookie attributes');

  await new Promise(resolve => setTimeout(resolve, 5000));
  const home = await request('GET', '/api/home', undefined, auth);
  check(home.status === 200 && home.data.recentlyAdded.length >= 2, 'scan and home rows return indexed media');
  const items = await request('GET', '/api/items?type=movie', undefined, auth);
  check(items.data.items.length === 1, 'movie library indexed');
  const itemId = items.data.items[0].id;
  const details = await request('GET', `/api/items/${itemId}`, undefined, auth);
  check(details.status === 200 && details.data.streams.length === 2, 'ffprobe stream metadata exposed to authorized user');
  const play = await request('POST', `/api/items/${itemId}/play`, { profile: { codecs: [], containers: [] } }, auth);
  check(play.status === 200 && play.data.directPlay === false && play.data.url.endsWith('master.m3u8'), 'incompatible profile selects HLS transcoding');
  const session = play.data.id;
  const master = await request('GET', `/api/play/${session}/master.m3u8`, undefined, auth);
  check(master.status === 200 && master.data.includes('#EXT-X-STREAM-INF'), 'HLS master playlist');
  const variant = await request('GET', `/api/play/${session}/360.m3u8`, undefined, auth);
  check(variant.status === 200 && variant.data.includes('360/1.ts'), 'HLS variant uses quality-scoped segment paths');
  const segment = await request('GET', `/api/play/${session}/360/1.ts`, undefined, auth);
  check(segment.status === 200 && Buffer.isBuffer(segment.data) && segment.data.length > 1000, 'on-demand FFmpeg HLS segment');
  const direct = await request('POST', `/api/items/${itemId}/play`, { profile: { codecs: ['h264', 'aac'], containers: ['mkv'] } }, auth);
  check(direct.data.directPlay === true, 'compatible profile uses Direct Play');
  const directResponse = await fetch(`http://127.0.0.1:${server.server.address().port}${direct.data.url}`, { headers: { Authorization: `Bearer ${setup.data.token}`, Range: 'bytes=0-1023' } });
  check(directResponse.status === 206 && (await directResponse.arrayBuffer()).byteLength === 1024, 'direct playback supports HTTP Range');
  const playback = await request('POST', `/api/playback/${itemId}`, { positionMs: 5000, durationMs: 12000 }, auth);
  check(playback.status === 200, 'resume position saved');
  check((await request('GET', `/api/playback/${itemId}`, undefined, auth)).data.state.positionMs === 5000, 'resume position read');

  const browserLogin = await request('POST', '/api/auth/login', { username: 'viewer', password: 'a strong viewer password' });
  const cookieHeader = browserLogin.headers.get('set-cookie').split(';')[0];
  const csrf = browserLogin.data.csrfToken;
  check((await request('GET', '/api/home', undefined, { Cookie: cookieHeader })).status === 200, 'browser cookie session works');
  check((await request('POST', `/api/items/${itemId}/favorite`, { value: true }, { Cookie: cookieHeader })).status === 403, 'cookie mutation without CSRF rejected');
  const favorite = await request('POST', `/api/items/${itemId}/favorite`, { value: true }, { Cookie: cookieHeader, 'X-CSRF-Token': csrf });
  check(favorite.status === 200 && favorite.data.favorite, 'favorites with CSRF token');
  const forbidden = await request('GET', '/api/items?type=song', undefined, { Cookie: cookieHeader });
  check(forbidden.data.items.length === 0 || forbidden.data.items.every(item => item.libraryId !== 2), 'per-user library restriction enforced');
  const downloads = await request('GET', `/api/files/download?libraryId=3&path=${encodeURIComponent('Documents/notes.txt')}`, undefined, { Cookie: cookieHeader });
  check(downloads.status === 200 && downloads.data.includes('download and preview'), 'individual file download');
  const traversal = await request('GET', `/api/files/download?libraryId=3&path=${encodeURIComponent('../..ignored.txt')}`, undefined, { Cookie: cookieHeader });
  check(traversal.status === 403, 'directory traversal rejected');
  const folder = await request('GET', `/api/files/download?libraryId=3&path=Documents`, undefined, { Cookie: cookieHeader });
  check(folder.status === 200 && folder.headers.get('content-type') === 'application/zip', 'folder ZIP download');
  check((await request('GET', '/api/files/download?libraryId=3&path=Documents', undefined, { Cookie: cookieHeader })).status === 200, 'folder download can be repeated');
  const update = await request('PATCH', `/api/admin/users/${userId}`, { canDownload: false }, auth);
  check(update.status === 200 && update.data.user.canDownload === false, 'download permission revoked');
  check((await request('GET', `/api/files/download?libraryId=3&path=${encodeURIComponent('Documents/notes.txt')}`, undefined, { Cookie: cookieHeader })).status === 403, 'revoked download permission enforced');

  const backup = await request('POST', '/api/admin/backups', {}, auth);
  check(backup.status === 201 && backup.data.backup.name.endsWith('.hearthbackup'), 'consistent SQLite backup');
  const backupFile = path.join(DATA, 'backups', backup.data.backup.name);
  check(fs.statSync(backupFile).size > 1000, 'backup file exists');
  const patched = await request('PATCH', '/api/admin/settings', { serverName: 'Renamed Hearth' }, auth);
  check(patched.status === 200 && patched.data.settings.serverName === 'Renamed Hearth', 'settings update');
  const zipPath = path.join(ROOT, 'test', 'zip-check.zip');
  fs.writeFileSync(zipPath, folder.data, 'binary');
  const { execFileSync: exec } = require('node:child_process');
  exec('unzip', ['-t', zipPath]);
  check(fs.statSync(zipPath).size > 200, 'ZIP central directory validates with unzip');

  await server.close();
  fs.rmSync(zipPath, { force: true });
  console.log(`\n${passed} checks passed.`);
})().catch(async error => {
  console.error(error.stack);
  try { await server.close(); } catch {}
  process.exitCode = 1;
});
