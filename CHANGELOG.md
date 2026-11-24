# Changelog

All notable changes to Hearth are documented here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.0.2 — 2026-11-24

### Added
- Browser-based first-run setup: a fresh, unconfigured server now shows a three-step wizard (media folders → administrator account → create) instead of a dead-end sign-in page. Available only from the server machine (`loopback`) and only until the admin account exists; rate-limited.
- `GET /api/setup` now reports `browserSetup: true` while the first-run window is open.
- Setup responses set the hardened session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS), so browsers land directly in the library.
- Browser walkthrough and screenshots; CI workflow; automated Windows release pipeline with SHA256 checksums.

### Changed
- `POST /api/setup` accepts browser requests while unconfigured from loopback; the desktop app path (`X-Hearth-Setup` token) is unchanged and still works at any point.
- Version alignment: package, server banner and web asset cache-busting all report 1.0.2.

### Fixed
- Fresh browser-only installs could not create the first account (sign-in page shown with zero users).
- Re-running setup after configuration now correctly returns `409`, and the browser setup window closes with `403` — both covered by tests.

## 1.0.1 — 2026-11-23

- Initial public preview: Node.js media server (`node:sqlite`, zero native dependencies), Electron desktop control panel, OTT web app, scanning with ffprobe, TMDB/MusicBrainz metadata, Direct Play and on-demand HLS transcoding with hardware-encoder detection (NVENC/QSV/AMF), multi-user accounts, per-library permissions, downloads and folder ZIP, Windows service mode, Tailscale/Cloudflare Tunnel remote access, encrypted backups, NSIS installer.
