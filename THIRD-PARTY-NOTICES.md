# Hearth third-party notices

Hearth includes and depends on the following projects. Each is used under its own license. This file summarizes the components bundled in the Windows package and points to the complete license text shipped beside each component.

## Runtime and application

- **Electron** — MIT License. Bundled desktop shell. Chromium/Component licenses are included by Electron as `LICENSES.chromium.html` in the application folder.
- **Node.js** — MIT License. Used through Electron's `ELECTRON_RUN_AS_NODE` runtime; no separate Node.js installation is required.
- **node:sqlite** — SQLite is public domain. Bundled as part of Node.js.
- **hls.js** — Apache License 2.0. Bundled locally as `public/hls.min.js`; no CDN is used.
- **FFmpeg / ffprobe** — GPL-compatible distribution. License: `resources\ffmpeg\LICENSE.txt`; source/build information: `resources\ffmpeg\FFMPEG-SOURCE.txt`.
- **cloudflared** — Apache License 2.0. Optional temporary tunnel helper; license: `resources\binaries\THIRD-PARTY-NOTICES.txt`.
- **WinSW** — MIT License. Optional Windows service wrapper; license: `resources\service\WINSW-LICENSE.txt`.

## Optional external services

- **TMDB** — optional metadata and artwork provider. Requires the operator's own API key. Metadata is cached locally; media files are never fetched from TMDB.
- **MusicBrainz** — optional music metadata provider. Rate limits are respected and an optional authentication token is supported.
- **Cover Art Archive** — optional album artwork source reached through MusicBrainz release identifiers.

## Build-time tools

- **NSIS** — zlib/libpng-licensed installer system. It produces the installer but is not a runtime dependency.
- **electron-builder** — MIT-licensed packaging tool used only to create the application layout.
- **resedit** — MIT-licensed resource editor used only for build-time Windows executable metadata.
- **Paged.js** — MIT-licensed pagination library used only to render this project's documentation PDF.

External metadata providers only receive search queries necessary to identify titles. User media, watch history and server contents are not uploaded to them.
