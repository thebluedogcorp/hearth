# Building Hearth from source

## What builds what

| Artifact | Built by | Needs |
|---|---|---|
| Web app (`public/`) | nothing — plain files | — |
| Server (`server/`) | nothing — plain files | Node.js ≥ 20 |
| Desktop panel + installer | `electron-builder` | Node.js + `npm install` |

## Development setup

```bash
npm install           # electron, electron-builder, hls.js (dev tools only)
npm test              # end-to-end smoke test — requires ffmpeg + ffprobe on PATH
npm start             # desktop panel in development mode
```

The smoke test (`test/smoke.js`) generates real media with FFmpeg, boots a real server on port 7341, and validates 39 behaviors end-to-end. It cleans up after itself in `test/.tmp-*`.

## Windows installer

1. Fetch the Windows vendor binaries (excluded from git to keep the repo light):
   ```bash
   bash scripts/fetch-vendor.sh
   ```
   This downloads `ffmpeg.exe`/`ffprobe.exe` (gyan.dev essentials), `cloudflared.exe` (Cloudflare) and `HearthService.exe` (WinSW v2.12.0) into `resources/`.
2. Build:
   ```bash
   npx electron-builder --win nsis --x64
   ```
   Output lands in `dist/Hearth-Setup-<version>-x64.exe`.

Cross-building from Linux uses a wine-free path (electron-builder's own NSIS target must run the installer under wine to generate the uninstaller, which headless Linux machines usually can't do):

```bash
bash scripts/build-installer-linux.sh
```

It packages the app with `electron-builder --dir` and then compiles the installer with the native `makensis` from electron-builder's cache using `scripts/installer-linux.nsh`. The release pipeline runs on real Windows runners and uses the standard electron-builder path instead — that's the recommended way to produce official artifacts.

## Releasing (maintainers)

1. Bump `version` in `package.json` and `VERSION` in `server/server.js`; align asset `?v=` strings in `public/index.html`.
2. Update `CHANGELOG.md` and `RELEASE_NOTES.md` (the latter becomes the GitHub release body).
3. Commit, tag and push:
   ```bash
   git tag vX.Y.Z && git push origin main vX.Y.Z
   ```
4. The **Release** workflow builds the installer on `windows-latest`, runs the smoke test, computes SHA256 checksums, and attaches everything to the GitHub release with `RELEASE_NOTES.md` as the body.

## Verifying a release artifact

```powershell
Get-FileHash .\Hearth-Setup-1.0.2-x64.exe -Algorithm SHA256
# compare against SHA256SUMS.txt attached to the release
```
