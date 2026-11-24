'use strict';

class HearthPlayer {
  constructor(api) {
    this.api = api;
    this.modal = null;
    this.root = null;
    this.video = null;
    this.state = null;
    this.hls = null;
    this.heartbeatTimer = null;
    this.idleTimer = null;
    this.lastSaved = 0;
    this.previewTimer = null;
    this.selectedSubtitle = null;
    this.selectedAudio = null;
    this.disposed = false;
    document.addEventListener('keydown', event => this.onKey(event));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveProgress(true); });
    window.addEventListener('beforeunload', () => this.saveProgress(true));
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => this.video?.play());
      navigator.mediaSession.setActionHandler('pause', () => this.video?.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.action('prev'));
      navigator.mediaSession.setActionHandler('nexttrack', () => this.action('next'));
    }
  }

  open(item, play, startAt = 0) {
    this.close();
    this.disposed = false;
    this.state = { item, play, startAt, episodes: item.episodes || [], tracks: item.tracks || [] };
    this.selectedAudio = play.audioStream ?? null;
    this.selectedSubtitle = null;
    this.render();
    this.attach();
    this.load();
  }

  render() {
    const item = this.state.item;
    const isAudio = item.type === 'song';
    this.modal = document.createElement('div');
    this.modal.className = 'modal-backdrop player-backdrop';
    this.modal.innerHTML = `
      <div class="modal player-modal" role="dialog" aria-label="${this.escape(item.title)} player">
        <div class="player-shell ${isAudio ? 'audio-mode' : ''}" id="player-shell">
          ${isAudio ? '<audio id="hearth-video" preload="metadata"></audio>' : '<video id="hearth-video" preload="metadata" playsinline></video>'}
          <div class="player-overlay" id="player-overlay">
            <div class="player-top">
              <button class="player-button" data-player="close" aria-label="Close player">✕</button>
              <div class="player-title">${this.escape(item.title)}<small>${this.escape(item.showTitle ? `${item.showTitle} · S${item.seasonNumber}E${item.episodeNumber}` : item.artist || item.year || '')}</small></div>
              ${isAudio ? '<button class="player-button" data-player="minimize" aria-label="Minimize to background player">—</button>' : ''}
              <span class="player-session" style="margin-left:auto;font-size:12px;color:rgba(255,255,255,.58)"></span>
            </div>
            <div class="player-bottom">
              <div class="seek-wrap">
                <div class="seek-preview" id="seek-preview"><img alt=""></div>
                <input id="player-seek" type="range" min="0" max="1000" value="0" aria-label="Seek">
              </div>
              <div class="player-row">
                <button class="player-button main" data-player="toggle" aria-label="Play or pause">▶</button>
                <button class="player-button" data-player="back10" aria-label="Back 10 seconds">-10</button>
                <button class="player-button" data-player="fwd10" aria-label="Forward 10 seconds">+10</button>
                <button class="player-button" data-player="prev" aria-label="Previous episode or track">⏮</button>
                <button class="player-button" data-player="next" aria-label="Next episode or track">⏭</button>
                <span class="time"><span id="time-current">0:00</span> / <span id="time-duration">0:00</span></span>
                <span class="spacer"></span>
                <button class="player-button" data-player="speed" aria-label="Playback speed">1×</button>
                <button class="player-button" data-player="volume" aria-label="Mute or unmute">🔊</button>
                <button class="player-button" data-player="settings" aria-label="Playback settings">⚙</button>
                <button class="player-button" data-player="pip" aria-label="Picture in picture">⧉</button>
                <button class="player-button" data-player="fullscreen" aria-label="Fullscreen">⛶</button>
              </div>
            </div>
            <div class="player-menu hidden" id="player-menu"></div>
            <div class="player-message hidden" id="player-message"><strong></strong><span></span></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(this.modal);
    this.root = this.modal.querySelector('.player-shell');
    this.video = this.modal.querySelector('#hearth-video');
    this.menu = this.modal.querySelector('#player-menu');
    this.overlay = this.modal.querySelector('#player-overlay');
    this.seek = this.modal.querySelector('#player-seek');
    this.message = this.modal.querySelector('#player-message');
    this.sessionBadge = this.modal.querySelector('.player-session');
    this.modal.addEventListener('click', event => { if (event.target === this.modal) this.close(); });
    this.overlay.addEventListener('click', event => {
      const button = event.target.closest('[data-player]');
      if (!button) return;
      this.action(button.dataset.player);
      event.stopPropagation();
    });
    this.video.addEventListener('click', () => this.action('toggle'));
    this.video.addEventListener('play', () => this.setPlaying(true));
    this.video.addEventListener('pause', () => { this.setPlaying(false); this.saveProgress(); });
    this.video.addEventListener('ended', () => this.onEnded());
    this.video.addEventListener('timeupdate', () => this.updateTime());
    this.video.addEventListener('progress', () => this.updateBuffer());
    this.video.addEventListener('loadedmetadata', () => { this.updateTime(); this.restoreAudioSubtitle(); });
    this.video.addEventListener('waiting', () => this.root.classList.add('loading'));
    this.video.addEventListener('canplay', () => this.root.classList.remove('loading'));
    this.video.addEventListener('error', () => this.showError('Playback stopped', 'The browser could not decode this stream. Try selecting another quality or audio track.'));
    this.seek.addEventListener('input', () => {
      const ratio = Number(this.seek.value) / 1000;
      const duration = this.video.duration || (this.state.item.runtimeMs / 1000) || 0;
      this.currentTime.textContent = this.formatTime(ratio * duration);
    });
    this.seek.addEventListener('change', () => {
      const ratio = Number(this.seek.value) / 1000;
      const duration = this.video.duration || (this.state.item.runtimeMs / 1000) || 0;
      this.video.currentTime = ratio * duration;
    });
    this.seek.addEventListener('pointermove', event => this.previewSeek(event));
    this.seek.addEventListener('pointerleave', () => this.modal.querySelector('#seek-preview').style.display = 'none');
    this.startIdleDetection();
  }

  attach() {
    this.currentTime = this.modal.querySelector('#time-current');
    this.duration = this.modal.querySelector('#time-duration');
  }

  async load(restartAt = null) {
    const { item, play } = this.state;
    this.root.classList.add('loading');
    this.sessionBadge.textContent = play.transcoded ? 'Transcoding' : play.directStream ? 'Direct Stream' : 'Direct Play';
    try {
      if (play.directPlay) {
        this.video.src = play.url;
      } else if (window.Hls && Hls.isSupported()) {
        this.destroyHls();
        this.hls = new Hls({ enableWorker: true, lowLatencyMode: false, capLevelToPlayerSize: true, startLevel: -1, maxBufferLength: 30, backBufferLength: 60 });
        this.hls.loadSource(play.url);
        this.hls.attachMedia(this.video);
        this.hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) this.hls.startLoad();
            else this.showError('Playback error', data.details || 'The stream could not continue.');
          }
        });
      } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.video.src = play.url;
      } else {
        throw new Error('This browser does not support HLS playback');
      }
      if (restartAt !== null && Number.isFinite(restartAt)) {
        this.video.addEventListener('loadedmetadata', () => { this.video.currentTime = restartAt; }, { once: true });
      } else if (this.state.startAt > 5) {
        this.video.addEventListener('loadedmetadata', () => { this.video.currentTime = this.state.startAt / 1000; }, { once: true });
      }
      await this.loadSubtitles();
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (!this.video?.paused && this.state?.play?.id) {
          this.api.request('POST', `/api/play/${this.state.play.id}/heartbeat`, {}).catch(() => {});
        }
      }, 25000);
      this.video.play().catch(() => this.showMessage('Tap to play', 'Your browser blocked automatic playback. Press play.'));
    } catch (error) {
      this.showError('Cannot start playback', error.message);
    }
  }

  async loadSubtitles() {
    const tracks = (this.state.item.streams || []).filter(stream => stream.type === 'subtitle');
    this.subtitleTracks = tracks;
    if (!tracks.length) return;
    for (const track of tracks) {
      const element = document.createElement('track');
      element.kind = 'subtitles';
      element.label = track.title || track.language || `Track ${track.index}`;
      element.srclang = track.language || 'en';
      element.src = `/api/items/${this.state.item.id}/subtitle/${track.index}.vtt`;
      this.video.appendChild(element);
    }
  }

  restoreAudioSubtitle() {
    const prefs = JSON.parse(localStorage.getItem('hearth-player-prefs') || '{}');
    if (prefs.speed) this.video.playbackRate = prefs.speed;
    if (this.selectedSubtitle !== null) {
      const trackIndex = this.subtitleTracks.findIndex(track => String(track.index) === String(this.selectedSubtitle));
      if (trackIndex >= 0 && this.video.textTracks[trackIndex]) this.video.textTracks[trackIndex].mode = 'showing';
    }
  }

  async action(name) {
    if (!this.video) return;
    switch (name) {
      case 'toggle': this.video.paused ? this.video.play() : this.video.pause(); break;
      case 'back10': this.video.currentTime = Math.max(0, this.video.currentTime - 10); break;
      case 'fwd10': this.video.currentTime = Math.min(this.video.duration || Infinity, this.video.currentTime + 10); break;
      case 'speed': this.cycleSpeed(); break;
      case 'volume': this.video.muted = !this.video.muted; this.modal.querySelector('[data-player="volume"]').textContent = this.video.muted ? '🔇' : '🔊'; break;
      case 'settings': this.renderSettings(); break;
      case 'pip': if (document.pictureInPictureElement) await document.exitPictureInPicture(); else if (this.video.requestPictureInPicture) await this.video.requestPictureInPicture(); break;
      case 'fullscreen':
        if (document.fullscreenElement) await document.exitFullscreen();
        else await this.root.requestFullscreen();
        break;
      case 'close': this.close(); break;
      case 'minimize': this.minimize(); break;
      case 'next': await this.switchNeighbor(1); break;
      case 'prev': await this.switchNeighbor(-1); break;
    }
  }

  cycleSpeed() {
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const index = (speeds.indexOf(this.video.playbackRate) + 1) % speeds.length;
    this.video.playbackRate = speeds[index];
    const prefs = JSON.parse(localStorage.getItem('hearth-player-prefs') || '{}');
    prefs.speed = speeds[index];
    localStorage.setItem('hearth-player-prefs', JSON.stringify(prefs));
    this.modal.querySelector('[data-player="speed"]').textContent = `${speeds[index]}×`;
  }

  renderSettings() {
    this.menu.classList.toggle('hidden');
    const audioTracks = (this.state.item.streams || []).filter(stream => stream.type === 'audio');
    const subtitleTracks = this.subtitleTracks || [];
    this.menu.innerHTML = `
      <h4>Audio</h4>
      ${audioTracks.map(track => `<button data-audio="${track.index}" class="${String(track.index) === String(this.selectedAudio) ? 'active' : ''}">${this.escape(track.title || track.language || `Audio ${audioTracks.indexOf(track) + 1}`)} · ${this.escape(track.codec || '')}</button>`).join('') || '<button disabled>No alternate audio</button>'}
      <h4>Subtitles</h4>
      <button data-subtitle="off" class="${this.selectedSubtitle === null ? 'active' : ''}">Off</button>
      ${subtitleTracks.map(track => `<button data-subtitle="${track.index}" class="${String(track.index) === String(this.selectedSubtitle) ? 'active' : ''}">${this.escape(track.title || track.language || `Subtitle ${track.index}`)}</button>`).join('') || ''}
    `;
    this.menu.querySelectorAll('[data-audio]').forEach(button => button.addEventListener('click', () => {
      this.menu.classList.add('hidden');
      this.switchAudio(Number(button.dataset.audio));
    }));
    this.menu.querySelectorAll('[data-subtitle]').forEach(button => button.addEventListener('click', () => {
      this.menu.classList.add('hidden');
      this.selectSubtitle(button.dataset.subtitle);
    }));
  }

  async switchAudio(audioStream) {
    const current = this.video.currentTime;
    const response = await this.api.request('POST', `/api/items/${this.state.item.id}/play`, { profile: { ...this.state.play.profile, audioStream } });
    if (!response.ok) { this.api.toast(response.data.message || 'Could not switch audio track', 'error'); return; }
    this.state.play = response.data;
    this.selectedAudio = audioStream;
    await this.load(current);
  }

  selectSubtitle(value) {
    this.selectedSubtitle = value === 'off' ? null : value;
    [...this.video.textTracks].forEach(track => {
      const match = this.subtitleTracks.findIndex(item => String(item.index) === String(this.selectedSubtitle));
      track.mode = track === this.video.textTracks[match] ? 'showing' : 'disabled';
    });
  }

  async switchNeighbor(direction) {
    const item = this.state.item;
    let next = null;
    if (item.type === 'episode' && item.episodes?.length) {
      const index = item.episodes.findIndex(entry => entry.id === item.id);
      next = item.episodes[index + direction];
    } else if (item.type === 'song' && item.tracks?.length) {
      const index = item.tracks.findIndex(entry => entry.id === item.id);
      next = item.tracks[index + direction];
    }
    if (!next) return;
    const details = await this.api.getItem(next.id);
    const play = await this.api.startPlay(details);
    if (!play.ok) return;
    this.open(details, play.data, 0);
  }

  previewSeek(event) {
    if (this.state.item.type === 'song') return;
    const preview = this.modal.querySelector('#seek-preview');
    const rect = this.seek.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const seconds = Math.round(ratio * ((this.state.item.runtimeMs || 0) / 1000));
    preview.style.display = 'block';
    preview.style.left = `${Math.max(85, Math.min(rect.width - 85, event.clientX - rect.left))}px`;
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      preview.querySelector('img').src = `/api/items/${this.state.item.id}/preview?ts=${seconds}`;
    }, 130);
  }

  updateTime() {
    if (!this.currentTime || !Number.isFinite(this.video.duration)) return;
    this.currentTime.textContent = this.formatTime(this.video.currentTime);
    this.duration.textContent = this.formatTime(this.video.duration);
    this.seek.value = Math.round((this.video.currentTime / this.video.duration) * 1000);
    if (this.miniSeek) this.miniSeek.value = this.seek.value;
    if (this.miniTime) this.miniTime.textContent = `${this.formatTime(this.video.currentTime)} / ${this.formatTime(this.video.duration)}`;
    if (Date.now() - this.lastSaved > 8000) this.saveProgress();
  }

  updateBuffer() {
    if (!this.video.buffered.length) return;
    const end = this.video.buffered.end(this.video.buffered.length - 1);
    this.root.style.setProperty('--buffer', `${Math.min(100, end / this.video.duration * 100)}%`);
  }

  setPlaying(playing) {
    const modalButton = this.modal?.querySelector('[data-player="toggle"]');
    if (modalButton) modalButton.textContent = playing ? '❚❚' : '▶';
    const miniButton = this.mini?.querySelector('[data-mini="toggle"]');
    if (miniButton) miniButton.textContent = playing ? '❚❚' : '▶';
    this.root?.classList.toggle('loading', false);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
      const item = this.state?.item;
      if (item) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: item.title || 'Hearth',
          artist: item.artist || item.showTitle || 'Hearth',
          album: item.album || item.year || 'Personal Media',
          artwork: item.posterUrl ? [{ src: item.posterUrl, sizes: '512x512', type: 'image/jpeg' }] : []
        });
      }
    }
  }

  async saveProgress(force = false) {
    if (!this.video || this.disposed || !Number.isFinite(this.video.duration)) return;
    if (!force && Date.now() - this.lastSaved < 5000) return;
    this.lastSaved = Date.now();
    const payload = {
      positionMs: Math.round((this.video.currentTime || 0) * 1000),
      durationMs: Math.round(this.video.duration * 1000),
      completed: this.video.ended,
      audioTrack: this.selectedAudio,
      subtitleTrack: this.selectedSubtitle
    };
    try { await this.api.request('POST', `/api/playback/${this.state.item.id}`, payload); }
    catch { /* progress will be saved on the next heartbeat */ }
  }

  async onEnded() {
    await this.saveProgress(true);
    const prefs = JSON.parse(localStorage.getItem('hearth-preferences') || '{}');
    if (prefs.autoplay !== false) await this.switchNeighbor(1);
    else this.close();
  }

  showError(title, detail) {
    this.root.classList.remove('loading');
    this.message.classList.remove('hidden');
    this.message.querySelector('strong').textContent = title;
    this.message.querySelector('span').textContent = detail || '';
    this.sessionBadge.textContent = 'Error';
  }

  showMessage(title, detail) {
    this.message.classList.remove('hidden');
    this.message.querySelector('strong').textContent = title;
    this.message.querySelector('span').textContent = detail || '';
  }

  startIdleDetection() {
    const resetIdle = () => {
      this.root.classList.remove('idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (!this.video?.paused) this.root.classList.add('idle');
      }, 2800);
    };
    ['pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach(event => this.root.addEventListener(event, resetIdle, { passive: true }));
    resetIdle();
  }

  minimize() {
    if (!this.modal || this.state.item.type !== 'song') return;
    this.minimized = true;
    this.modal.classList.add('hidden');
    const item = this.state.item;
    this.mini = document.getElementById('mini-player');
    this.mini.classList.remove('hidden');
    const artwork = item.posterUrl || item.backdropUrl;
    this.mini.innerHTML = `
      <div class="mini-info">
        ${artwork ? `<img src="${this.escape(artwork)}" alt="">` : '<div class="mini-art"></div>'}
        <div class="mini-title">${this.escape(item.title)}</div>
        <div class="mini-sub">${this.escape(item.artist || item.album || '')} · <span id="mini-time">0:00 / 0:00</span></div>
      </div>
      <div class="mini-controls">
        <button data-mini="prev" aria-label="Previous track">⏮</button>
        <button data-mini="toggle" class="playing" aria-label="Play or pause">❚❚</button>
        <button data-mini="next" aria-label="Next track">⏭</button>
        <button data-mini="expand" aria-label="Open player">⤢</button>
        <button data-mini="close" aria-label="Stop and close">✕</button>
      </div>`;
    this.miniTime = this.mini.querySelector('#mini-time');
    this.miniSeek = null;
    this.mini.querySelectorAll('[data-mini]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      const action = button.dataset.mini;
      if (action === 'toggle') this.action('toggle');
      else if (action === 'prev') this.action('prev');
      else if (action === 'next') this.action('next');
      else if (action === 'expand') this.restore();
      else if (action === 'close') this.close();
    }));
  }

  restore() {
    if (!this.minimized || !this.modal) return;
    this.minimized = false;
    this.modal.classList.remove('hidden');
    this.mini?.classList.add('hidden');
    this.miniTime = null;
    this.miniSeek = null;
  }

  onKey(event) {
    if (!this.modal || this.modal.classList.contains('hidden')) return;
    if (event.target.matches('input, textarea, select')) return;
    const keys = { ' ': 'toggle', k: 'toggle', ArrowLeft: 'back10', ArrowRight: 'fwd10', j: 'back10', l: 'fwd10', m: 'volume', f: 'fullscreen', Escape: 'close' };
    if (keys[event.key]) {
      event.preventDefault();
      this.action(keys[event.key]);
    }
  }

  destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }

  close() {
    this.saveProgress(true);
    this.disposed = true;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    clearTimeout(this.idleTimer);
    this.destroyHls();
    try { if (this.state?.play?.id && !this.video?.ended) this.api.request('DELETE', `/api/play/${this.state.play.id}`); } catch { /* session cleanup is best-effort */ }
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.modal?.remove();
    this.modal = null;
    this.video = null;
    this.mini?.classList.add('hidden');
    if (this.mini) this.mini.innerHTML = '';
    this.mini = null;
    this.miniTime = null;
    this.miniSeek = null;
    this.minimized = false;
  }

  formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
}

window.HearthPlayer = HearthPlayer;
