# Installation & first run

## Option A — Windows installer (recommended)

1. Download `Hearth-Setup-<version>-x64.exe` from the [Releases](../releases) page.
2. (Optional but wise) Verify the checksum:
   ```powershell
   Get-FileHash .\Hearth-Setup-1.0.2-x64.exe -Algorithm SHA256
   ```
   Compare with the `SHA256SUMS.txt` published on the same release.
3. Run the installer. Per-user install by default; you may change the install directory during setup.
4. Launch **Hearth** from the Start menu or desktop shortcut.

### The first-run wizard

The desktop control panel starts the bundled server for you and opens a guided wizard:

1. **Add media folders** — pick any folders containing movies, TV shows, music or general files. Hearth reads them; it never moves, renames or deletes anything.
2. **Create your administrator account** — this is the sign-in you'll use on every device.
3. **Create the server** — scanning starts in the background right away; the app is usable immediately.

Advanced options (collapsed by default): server name, listening port (default 7341), visibility (home network vs. this PC only), and optional TMDB / MusicBrainz keys for artwork and metadata.

### After setup

- The **Dashboard** shows server status, library size, active sessions and recent activity.
- **Libraries** lets you add more folders, trigger rescans or remove libraries (files are untouched).
- **Network** lists your LAN addresses and remote-access options.
- **Backup** creates a consistent snapshot of your entire database (`VACUUM INTO`).

## Option B — Headless / any OS (Node.js ≥ 22)

```bash
git clone https://github.com/thebluedogcorp/hearth.git
cd hearth
npm install --omit=dev

# first run — the setup token protects the one-time setup window
node server/index.js --data /var/lib/hearth --setup-token "$(openssl rand -hex 24)"
```

- Open `http://<this-machine>:7341` **from this machine** (or its console browser) to complete the browser wizard. First-run setup is deliberately restricted to the server itself and disappears the moment your admin account exists.
- For fully remote provisioning, keep a setup token: `POST /api/setup` from the server itself with header `X-Hearth-Setup: <token>` (this is what the desktop app does).
- CLI flags: `--data <dir>` (required, absolute), `--port <n>`, `--ffmpeg-dir <dir>` (if `ffmpeg` is not on PATH), `--cloudflared <path>`, `--setup-token <32+ chars>`.

### FFmpeg

Direct Play needs no FFmpeg at all; transcoding, thumbnails and scanning do. On Windows the installer bundles `ffmpeg.exe`/`ffprobe.exe`. On Linux, install from your package manager (`apt install ffmpeg`) or point `--ffmpeg-dir` at a folder containing both binaries.

## Windows service mode

From the desktop panel (**Service → Install service**) or manually:

```powershell
# from an elevated PowerShell in the Hearth install directory
powershell -ExecutionPolicy Bypass -File resources\service\install-service.ps1 -DataDir "$env:APPDATA\Hearth" -ResourcesDir "<install>\resources" -Port 7341
```

The service runs the server in the background even when the panel is closed; the desktop app detects and reuses it.

## Updating

Install the new version over the old one. Your data directory (database, artwork, logs, backups) is untouched by upgrades and uninstalls.

## Uninstalling

Use Windows "Apps & features". To also remove all data, delete `%APPDATA%\Hearth` afterwards (the installer deliberately keeps it so a reinstall preserves your library).
