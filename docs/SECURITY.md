# Security model

This document describes exactly how Hearth protects your data, what its boundaries are, and what it deliberately does not do.

## Accounts & authentication

- **Password storage**: scrypt with N=32768, r=8, p=1, 32-byte salt, 64-byte derived key; verification is constant-time and uses a dummy hash for unknown users so response timing does not reveal account existence.
- **Sign-in rate limiting**: per-IP (25 attempts / 15 min) and per-username (6 attempts / 15 min), in-memory sliding window.
- **Sessions**: opaque 192-bit tokens stored server-side (SQLite) with an independent CSRF token. Browser sessions use `HttpOnly; SameSite=Lax` cookies (`Secure` added automatically on HTTPS); the desktop app authenticates with `Authorization: Bearer` and is only honored from loopback.
- **Session lifecycle**: 30-day expiry, revocable per-device from the account popover; password change revokes every other session.

## CSRF & browser safety

- Every mutating browser request (`POST/PATCH/PUT/DELETE`) must carry the session-bound `X-CSRF-Token` header; bearer-token (desktop) requests are exempt by design and loopback-only.
- Content-Security-Policy forbids inline scripts (`script-src 'self'`), restricts media/images to self and data/blob, and frames are refused everywhere.
- Static assets are served with `nosniff`; uploaded/downloaded content paths are validated.

## First-run setup (the sensitive window)

Setup creates the administrator, so it is guarded twice:

1. **Loopback only** — browser setup is accepted solely from the server machine itself while **no** admin account exists. A remote device can see availability status but cannot perform setup.
2. **Desktop token** — the bundled desktop app additionally proves its identity with a random 256-bit per-launch token (`X-Hearth-Setup` header), also loopback-only.
3. **Bounded** — the moment an administrator exists, browser setup returns `403` and re-setup attempts return `409`. Both behaviors are enforced by the automated test suite.
4. **Rate limited** — unauthenticated (browser) setup attempts are rate-limited like sign-in.

## File safety

- Every file-serving route resolves the requested path inside its library root and rejects anything that escapes it (symlink-aware `realpath` assertion).
- Directory listings and downloads are library-scoped; users can only see libraries their account allows (admin, or explicit allow-list).
- Downloads are a per-user permission, default **off** for new accounts, enforced per request.

## Secrets (TMDB/MusicBrainz keys)

Stored AES-256-GCM encrypted in the database under a master key kept in `runtime/.master-key` (mode 0600 on POSIX; `icacls`-restricted on Windows). Keys never appear in logs, URLs or API responses after saving.

## Data protection

- Structured JSON logs redact query strings containing credentials and never log passwords or tokens.
- Backups are consistent SQLite snapshots; the backup API and panel live behind admin auth.
- **No telemetry** — the server makes no outbound connections except the metadata APIs you configure and tunnels you enable.

## Known boundaries (be aware)

- Transport security is only as strong as your remote-access choice: use Tailscale, HTTPS tunnel or a TLS-terminating proxy for anything outside your LAN (see [REMOTE-ACCESS.md](REMOTE-ACCESS.md)).
- Quick tunnels (`trycloudflare.com`) are capability URLs — share them like passwords.
- The first-run window trusts the local machine; on a shared computer, complete setup promptly.

## Reporting a vulnerability

Please open a **private** security advisory via GitHub (Security tab → Report a vulnerability) or contact the maintainers directly. Do not open public issues for security problems. Fixes land in the next patch release; we credit reporters by default unless asked otherwise.
