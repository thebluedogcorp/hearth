# Contributing to Hearth

Thanks for helping make self-hosted media friendly.

## Ground rules

- **No placeholders or stubs.** Code that ships must actually work end-to-end; there is a test suite and it should keep passing (`npm test`).
- **Zero native build dependencies.** Features must work with Node's built-ins (`node:sqlite`, `node:http`, …). Anything that needs `node-gyp` is a design smell here.
- **Windows-first UX, portable server.** The desktop panel targets Windows; the server must keep running on plain Node.js on any OS.
- **Respect the security model.** New routes need auth + CSRF considerations; see [docs/SECURITY.md](docs/SECURITY.md). If you touch setup/auth/file-serving, add a test proving the boundary.

## Workflow

1. Fork / branch from `main`.
2. Keep the smoke test green: `npm test` (FFmpeg required on PATH).
3. For UI changes, verify in a real browser — setup flow, browse, play, download at minimum.
4. Update docs (`README.md`, `docs/*`) when behavior or flags change; add a `CHANGELOG.md` entry.
5. Open a PR describing what changed and why. CI runs the smoke matrix on Node 20/22/24.

## Code layout

```
server/   media server (store, scanner, metadata, playback, remote, zip, server, index)
public/   web app served by the server (vanilla JS, hls.js)
desktop/  Electron control panel
resources/ packaging resources (ffmpeg/cloudflared fetched by scripts/fetch-vendor.sh)
test/     end-to-end smoke test
```

## Releases

Maintainers bump the version, update `CHANGELOG.md` + `RELEASE_NOTES.md`, and push a `vX.Y.Z` tag — GitHub Actions builds the NSIS installer, runs the smoke test on Windows, and attaches artifacts with SHA256 checksums to the release automatically.
