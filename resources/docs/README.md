# Hearth — Premium Self-Hosted Media Server

Hearth turns a Windows PC into a private streaming platform. The bundled Node.js server indexes folders you choose, serves an OTT-style web app to phones, tablets, laptops and TV browsers, and plays compatible files directly or transcodes them on demand with FFmpeg.

## Product components

- **Windows desktop control panel** — Electron shell with first-run wizard, dashboard, libraries, storage, users, network, playback, metadata, logs, backup and update controls.
- **Media server** — dependency-free Node.js server using `node:sqlite`, native HTTP, FFmpeg/ffprobe, on-demand HLS and authenticated sessions.
- **Web app** — responsive dark streaming interface with Home, Movies, TV, Music, Files, Collections and Search.
- **Optional Windows service** — WinSW wrapper around the bundled Node runtime for background operation.

## Quick start

1. Run `Hearth-Setup-1.0.0-x64.exe`.
2. Launch Hearth and complete the nine-step setup wizard.
3. Add folders for Movies, TV, Music and/or Files.
4. Create the administrator account and choose a port (default `7341`).
5. Open the displayed LAN URL from another device and sign in.
6. Add a TMDB key in **Metadata** for richer movie/TV artwork and descriptions; MusicBrainz works without a key.

Default data location: `%APPDATA%\Hearth\ServerData`. Uninstalling does not delete media, server data or backups.

## Security model

- Passwords use salted scrypt with constant-time verification.
- Browser sessions use HttpOnly, SameSite=Strict cookies plus CSRF tokens; the desktop uses an opaque encrypted token.
- Every library, item, artwork, subtitle, preview, stream and download route re-checks user and library permissions.
- Metadata provider credentials are AES-256-GCM encrypted at rest; logs redact credential-like fields.
- Setup routes are loopback-only and protected by a per-run secret.
- File access uses absolute-path containment plus realpath checks; symlinks are skipped during scans and ZIP creation.
- Remote HTTPS is provided by Cloudflare Tunnel or your reverse proxy; direct public HTTP exposure is discouraged and never required.

## Playback model

- Browser capability detection selects Direct Play when the container and codecs are supported.
- H.264/AAC content in unsupported containers is remuxed to HLS without re-encoding.
- Incompatible video/audio is transcoded into 4-second HLS segments with source, 1080p, 720p, 480p and 360p variants.
- Hardware encoders are validated with a test encode before use; NVENC, QSV and AMF fall back to libx264.
- Embedded and sidecar text subtitles are converted to WebVTT. Image-based subtitle tracks are reported as unsupported rather than silently failing.
- Playback state supports resume, Continue Watching, speed control, audio/subtitle selection, fullscreen, PiP and Media Session controls.

## Documentation

- [Hearth User Guide](../../download/Hearth-User-Guide.pdf)
- [Hearth User Guide HTML source](../../download/Hearth-User-Guide.html)
- Installed copies are placed in `resources\docs` by the installer package.

## Development

```bash
npm install
npm test
npm start
npm run package:win
```

`npm test` starts an isolated server on port 7341 and runs 35 end-to-end checks covering setup, authentication, RBAC, scanning, direct play, HLS transcoding, range requests, favorites, file downloads, path traversal rejection, permissions, backup and settings.

The Windows installer build uses electron-builder for the application layout and a native NSIS 3.11 compiler for `Hearth-Setup-1.0.0-x64.exe`. FFmpeg, cloudflared and WinSW are downloaded at build time and their licenses are bundled.

## Architecture notes

- The server intentionally has no runtime npm dependencies, reducing supply-chain surface and startup cost.
- SQLite is used with WAL mode, foreign keys, bounded caches and indexes for library, show, music, playback and activity queries.
- Scans are serialized per server and metadata/thumbnail work runs in background queues, so browsing remains responsive during large scans.
- Remote access modes are explicit: LAN-only, VPN, temporary authenticated HTTPS tunnel, or reverse proxy. Quick tunnels are labeled temporary in the UI.
- Backups use SQLite `VACUUM INTO` for a consistent database snapshot; source media files are not duplicated.
- The updater accepts only HTTPS manifests and verifies SHA-256 before launching a silent installer.

## Known build limitation

The Linux build sandbox can execute the complete server test suite and produce the Windows package/installer, but cannot launch Windows or install the NSIS package. Windows-specific behavior—service installation, GPU acceleration and SmartScreen behavior—must be smoke-tested on a Windows machine.
