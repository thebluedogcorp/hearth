# Hearth 1.0.2 — Setup made a piece of cake

This release focuses on what you told us: getting from download to watching should take minutes, not an evening. It also ships a first-run wizard that works from any browser on the server machine, not just the desktop app.

## Highlights

**Browser first-run setup.** Opening Hearth in a browser on a fresh server no longer shows a dead-end sign-in page. You now get a three-step wizard — add media folders, create your account, press *Create my server* — and Hearth starts scanning immediately. The window is only open until the administrator account exists, and only from the server machine itself, so the flow is safe by default.

**The desktop app remains the recommended path.** The Electron control panel keeps its own guided wizard, runs the server for you, and offers one-click service installation, backup and diagnostics.

**Everything else is unchanged where it matters.** Direct Play and on-demand HLS transcoding, multi-user accounts with per-library permissions, resume across devices, downloads and folder ZIP, Tailscale/Cloudflare Tunnel remote access, and encrypted SQLite backups all ship exactly as before — with the full 39-check end-to-end test suite passing on every commit.

## Fixes

- Fresh installs served a sign-in page with no way to create the first account when only the browser was used — fixed with the browser setup wizard above.
- Setup responses now set the same hardened session cookie as sign-in, so you land directly in your library after creating the server.
- Setup cannot be re-run after configuration (409) and the browser window closes the moment an admin exists (403) — verified by tests.

## Upgrade

Download `Hearth-Setup-1.0.2-x64.exe` from the release, install over 1.0.1, and keep using your existing library — data and libraries carry over untouched. SHA256 checksums are published alongside the installer.

## Verified

- `node test/smoke.js` — 39/39 checks pass (setup, auth, CSRF, permissions, scanning, Direct Play, HLS, Range, resume, downloads, ZIP, backup integrity).
- Manual browser walkthrough: fresh start → wizard → library scan → details modal → playback → resume button appears after pause.
