'use strict';

(() => {
  const state = {
    user: null, csrf: null, preferences: null, route: '', libraries: [], page: 1, pages: 1,
    filters: {}, filesPath: '', filesLibraryId: null, hero: { index: 0, timer: null }, booted: false
  };
  const app = document.getElementById('app');
  let player;

  const api = {
    async request(method, path, body, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (state.csrf && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) headers['X-CSRF-Token'] = state.csrf;
      const response = await fetch(path, {
        method, headers, credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      let data;
      try { data = await response.clone().json(); } catch { try { data = await response.text(); } catch { data = ''; } }
      if (response.status === 401 && state.user && !options.soft) await init(true);
      return { ok: response.ok, status: response.status, data };
    },
    async getItem(id) {
      const response = await api.request('GET', `/api/items/${id}`);
      if (!response.ok) throw new Error(response.data?.message || 'Title unavailable');
      return response.data;
    },
    async startPlay(item, profile, startAt = 0) {
      const browserProfile = profile || detectProfile();
      const response = await api.request('POST', `/api/items/${item.id}/play`, { profile: browserProfile });
      if (!response.ok) {
        toast(response.data?.message || 'Playback could not start', 'error');
        return response;
      }
      const playback = await api.request('GET', `/api/playback/${item.id}`);
      const saved = playback.data?.state || {};
      const start = startAt || (saved.completed ? 0 : saved.positionMs || 0);
      response.data.profile = browserProfile;
      player.open(item, response.data, start);
      return response;
    },
    toast(message, type = 'success') { toast(message, type); }
  };

  function detectProfile() {
    const probe = document.createElement('video');
    const supported = [];
    [['h264', 'video/mp4; codecs="avc1.42E01E"'], ['aac', 'video/mp4; codecs="mp4a.40.2"'], ['mp3', 'audio/mpeg'],
     ['flac', 'audio/flac'], ['ogg', 'audio/ogg'], ['opus', 'audio/ogg; codecs=opus'], ['vp8', 'video/webm; codecs="vp8"'],
     ['vp9', 'video/webm; codecs="vp9"'], ['hevc', 'video/mp4; codecs="hvc1.1.6.L120.90"'], ['av1', 'video/mp4; codecs="av01.0.05M.08"']
    ].forEach(([codec, type]) => { if (probe.canPlayType(type)) supported.push(codec); });
    return {
      codecs: supported.length ? supported : ['h264', 'aac', 'mp3'],
      containers: ['mp4', 'm4v', 'mov', 'webm', 'mp3', 'flac', 'wav', 'ogg', 'opus', 'm4a']
    };
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function toast(message, type = 'success') {
    const root = document.getElementById('toast-root') || document.body;
    const element = document.createElement('div');
    element.className = `toast ${type}`;
    element.textContent = message;
    root.appendChild(element);
    setTimeout(() => element.remove(), 4200);
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let result = value; let unit = 0;
    while (result >= 1024 && unit < units.length - 1) { result /= 1024; unit++; }
    return `${result.toFixed(result >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function formatRuntime(ms) {
    if (!ms) return '';
    const minutes = Math.round(ms / 60000);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  }

  function artUrl(item, kind = 'poster') {
    return item?.[`${kind}Url`] || null;
  }

  function card(item, options = {}) {
    const image = artUrl(item, options.wide ? 'backdrop' : 'poster');
    const percentage = item.playback?.positionMs && item.runtimeMs ? Math.min(100, item.playback.positionMs / item.runtimeMs * 100) : 0;
    const fallbackTitle = esc(item.title || 'Untitled');
    return `<button class="card ${options.className || ''}" data-item="${esc(item.id)}" aria-label="${fallbackTitle}">
      <div class="poster">
        ${image ? `<img loading="lazy" src="${esc(image)}" alt="">` : `<div class="poster-fallback"><strong>${fallbackTitle}</strong><span>${esc(item.artist || item.showTitle || item.type || '')}</span></div>`}
        ${item.rating ? `<span class="rating-badge">★ ${Number(item.rating).toFixed(1)}</span>` : ''}
        ${percentage ? `<span class="progress"><span style="width:${percentage}%"></span></span>` : ''}
        ${['movie', 'episode', 'song'].includes(item.type) ? '<span class="card-quick" aria-hidden="true"></span>' : ''}      </div>
      <div class="card-label">${fallbackTitle}</div>
      <div class="card-sub">${esc(options.subtitle || item.artist || (item.seasonNumber !== null && item.seasonNumber !== undefined ? `S${item.seasonNumber}E${item.episodeNumber} · ${item.episodeTitle || ''}` : item.year || ''))}</div>
    </button>`;
  }

  function showCard(show) {
    const image = show.posterUrl;
    return `<button class="card" data-show="${esc(show.id)}">
      <div class="poster">${image ? `<img loading="lazy" src="${esc(image)}" alt="">` : `<div class="poster-fallback"><strong>${esc(show.title)}</strong><span>${show.episodeCount} episodes</span></div>`}</div>
      <div class="card-label">${esc(show.title)}</div><div class="card-sub">${esc(show.year || '')} · ${show.episodeCount} ep</div>
    </button>`;
  }

  function row(title, items, options = {}) {
    if (!items?.length) return '';
    return `<section class="row-section"><div class="section-head"><h2>${esc(title)}</h2>${options.more ? `<a href="${esc(options.more)}" data-link>See all</a>` : ''}</div>
      <div class="row-wrap"><div class="row-scroll">${items.map(item => card(item, options)).join('')}</div></div></section>`;
  }

  function empty(title, message, icon = '🎬') {
    return `<div class="empty"><div class="emoji">${icon}</div><strong>${esc(title)}</strong><p>${esc(message)}</p></div>`;
  }

  function skeletons(count = 8, className = 'poster-sk') {
    return Array.from({ length: count }, () => `<div class="skeleton ${className}"></div>`).join('');
  }

  function ensureShell() {
    if (document.getElementById('app-shell')) return;
    app.innerHTML = '';
    app.appendChild(document.getElementById('tpl-app').content.cloneNode(true));
    player = player || new HearthPlayer(api);
    document.querySelector('[data-search]').addEventListener('submit', event => {
      event.preventDefault();
      const query = document.getElementById('global-search').value.trim();
      if (query) location.hash = `#/search/${encodeURIComponent(query)}`;
    });
    document.querySelector('[data-action="toggle-sidebar"]').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
    document.querySelector('[data-action="user-menu"]').addEventListener('click', () => document.getElementById('user-popover').classList.toggle('hidden'));
    document.addEventListener('click', event => {
      const popover = document.getElementById('user-popover');
      if (popover && !popover.classList.contains('hidden') && !event.target.closest('.user-menu')) popover.classList.add('hidden');
      const sidebar = document.getElementById('sidebar');
      if (sidebar?.classList.contains('open') && !event.target.closest('#sidebar, .nav-toggle')) sidebar.classList.remove('open');
      const quickPlay = event.target.closest('.card-quick');
      if (quickPlay) {
        const quickCard = quickPlay.closest('[data-item]');
        if (quickCard) { openItem(quickCard.dataset.item, true); return; }
      }
      const cardButton = event.target.closest('[data-item]');
      if (cardButton) { openItem(cardButton.dataset.item, cardButton.dataset.play === 'true'); return; }
      const showButton = event.target.closest('[data-show]');
      if (showButton) { location.hash = `#/tv/${showButton.dataset.show}`; return; }
      const collectionButton = event.target.closest('[data-collection]');
      if (collectionButton) { location.hash = `#/collections/${collectionButton.dataset.collection}`; return; }
      const albumButton = event.target.closest('[data-album]');
      if (albumButton) { location.hash = `#/music/album/${encodeURIComponent(albumButton.dataset.album)}/${encodeURIComponent(albumButton.dataset.artist || '')}`; return; }
      const artistButton = event.target.closest('[data-artist]');
      if (artistButton) { location.hash = `#/music/artist/${encodeURIComponent(artistButton.dataset.artist)}`; return; }
    });
    document.querySelector('[data-action="sign-out"]').addEventListener('click', async () => {
      await api.request('POST', '/api/auth/logout', {});
      location.reload();
    });
    app.addEventListener('click', event => {
      const back = event.target.closest('[data-back]');
      if (back) {
        event.preventDefault();
        location.hash = back.dataset.back;
        return;
      }
      const link = event.target.closest('[data-link]');
      if (!link) return;
      event.preventDefault();
      location.hash = link.getAttribute('href');
    });
    document.addEventListener('click', event => {
      if (event.target.dataset.action === 'create-collection') createCollectionModal();
    });
  }

  function setMain(html) {
    clearInterval(state.hero.timer);
    state.hero.timer = null;
    ensureShell();
    document.getElementById('main').innerHTML = html;
    document.getElementById('main').scrollTo?.(0, 0);
    window.scrollTo({ top: 0 });
    setActiveNav();
    document.querySelectorAll('.row-scroll').forEach(rowEl => {
      rowEl.addEventListener('wheel', event => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          rowEl.scrollLeft += event.deltaY;
          event.preventDefault();
        }
      }, { passive: false });
    });
  }

  function setActiveNav() {
    const path = state.route.split('/')[1] || 'home';
    document.querySelectorAll('.top-tabs a, .sidebar a').forEach(link => {
      link.classList.toggle('active', link.getAttribute('href') === `#/${path}`);
    });
  }

  function modal(title, body, options = {}) {
    const root = document.getElementById('modal-root');
    const element = document.createElement('div');
    element.className = 'modal-backdrop';
    element.innerHTML = `<div class="modal ${options.className || ''}" role="dialog" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="close-button" data-close-modal aria-label="Close">✕</button></div>
      <div class="modal-body">${body}</div></div>`;
    root.innerHTML = '';
    root.appendChild(element);
    element.addEventListener('click', event => {
      if (event.target === element || event.target.closest('[data-close-modal]')) close();
    });
    const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', escapeHandler); };
    const escapeHandler = event => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', escapeHandler);
    return { element, close };
  }

  async function loginPage(showSetupHint = false) {
    app.innerHTML = '';
    app.appendChild(document.getElementById('tpl-login').content.cloneNode(true));
    const form = document.getElementById('login-form');
    const error = document.getElementById('login-error');
    if (showSetupHint) {
      error.textContent = 'First-run setup is not finished yet. Complete it on the server machine with the Hearth desktop app, or by opening this page locally in a browser.';
      error.classList.remove('hidden');
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(form);
      error.textContent = 'Signing you in…';
      error.classList.add('hidden');
      const response = await api.request('POST', '/api/auth/login', { username: data.get('username'), password: data.get('password') });
      if (!response.ok) {
        error.textContent = response.data?.message || 'Sign-in failed';
        error.classList.remove('hidden');
        return;
      }
      await init(true);
    });
  }

  function guessLibraryType(folderPath) {
    const lowered = folderPath.toLowerCase();
    if (/(^|[\\/])(movies?|films?)([\\/]|$)/.test(lowered) || lowered.includes('movie') || lowered.includes('film')) return 'movies';
    if (/(^|[\\/])(tv|shows?|series)([\\/]|$)/.test(lowered) || lowered.includes('series')) return 'tv';
    if (/(^|[\\/])(music|albums?)([\\/]|$)/.test(lowered) || lowered.includes('music')) return 'music';
    return 'files';
  }

  function libraryTypeLabel(type) {
    return { movies: 'Movies', tv: 'TV shows', music: 'Music', files: 'Files' }[type] || 'Files';
  }

  async function firstRunPage() {
    app.innerHTML = '';
    app.appendChild(document.getElementById('tpl-firstrun').content.cloneNode(true));
    const form = document.getElementById('firstrun-form');
    const folderInput = document.getElementById('folder-path');
    const folderList = document.getElementById('folder-list');
    const error = document.getElementById('firstrun-error');
    const folders = [];

    function renderFolders() {
      folderList.innerHTML = '';
      folders.forEach((folder, index) => {
        const item = document.createElement('li');
        item.className = 'folder-row';
        item.innerHTML = `<div><strong>${esc(folder.name)}</strong><small>${esc(folder.path)} · ${libraryTypeLabel(folder.type)}</small></div>`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ghost';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => { folders.splice(index, 1); renderFolders(); });
        item.appendChild(remove);
        folderList.appendChild(item);
      });
    }

    document.getElementById('folder-add').addEventListener('click', () => {
      const folderPath = folderInput.value.trim().replace(/[\\/]+$/, '');
      if (!folderPath) return;
      if (folders.some(folder => folder.path.toLowerCase() === folderPath.toLowerCase())) {
        folderInput.value = '';
        return;
      }
      folders.push({ path: folderPath, name: folderPath.split(/[\\/]/).pop() || folderPath, type: guessLibraryType(folderPath) });
      folderInput.value = '';
      renderFolders();
    });
    folderInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); document.getElementById('folder-add').click(); }
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      error.classList.add('hidden');
      const username = document.getElementById('admin-username').value.trim();
      const password = document.getElementById('admin-password').value;
      const confirm = document.getElementById('admin-password2').value;
      const serverName = document.getElementById('server-name').value.trim() || 'Hearth';
      if (password.length < 12) { error.textContent = 'Use a password of at least 12 characters.'; error.classList.remove('hidden'); return; }
      if (password !== confirm) { error.textContent = 'The two passwords do not match.'; error.classList.remove('hidden'); return; }
      document.getElementById('firstrun-create').disabled = true;
      error.textContent = 'Creating your server…';
      error.classList.remove('hidden');
      const response = await api.request('POST', '/api/setup', {
        step: 'complete', serverName, port: 7341, bindAddress: '0.0.0.0',
        admin: { username, password },
        libraries: folders.map(folder => ({ name: folder.name, path: folder.path, type: folder.type })),
        remote: { mode: 'off', enabled: false }, metadata: {}
      });
      if (!response.ok) {
        document.getElementById('firstrun-create').disabled = false;
        error.textContent = response.data?.message || 'Setup failed — check the values and try again.';
        error.classList.remove('hidden');
        return;
      }
      error.textContent = 'Server created! Opening your library…';
      await init(true);
    });
  }

  async function init(force = false) {
    const me = await api.request('GET', '/api/auth/me', undefined, { soft: true });
    if (!me.ok) {
      state.user = null; state.csrf = null;
      const availability = await api.request('GET', '/api/setup');
      if (availability.data?.configured === false) await firstRunPage();
      else await loginPage(availability.status === 403);
      return false;
    }
    state.user = me.data.user; state.csrf = me.data.csrfToken; state.preferences = me.data.preferences;
    localStorage.setItem('hearth-preferences', JSON.stringify(state.preferences));
    ensureShell();
    const userButton = document.getElementById('user-button');
    userButton.textContent = state.user.username.slice(0, 2).toUpperCase();
    document.getElementById('popover-name').textContent = state.user.username;
    document.getElementById('popover-role').textContent = state.user.role;
    const libraries = await api.request('GET', '/api/libraries');
    state.libraries = libraries.data?.libraries || [];
    if (!state.route || force) {
      if (!location.hash || location.hash === '#/') location.hash = '#/home';
      else await route();
    }
    return true;
  }

  async function homePage() {
    setMain(`<div class="hero skeleton" style="aspect-ratio:16/8"></div>${skeletons(8)}`);
    const response = await api.request('GET', '/api/home');
    if (!response.ok) return setMain(empty('Library unavailable', response.data?.message || 'Try again'));
    const data = response.data;
    const featured = data.featured.length ? data.featured : data.recentlyAdded.filter(item => ['movie', 'episode'].includes(item.type)).slice(0, 5);
    const heroHtml = featured.length ? hero(featured) : '';
    setMain(`${heroHtml}
      ${row('Continue Watching', data.continueWatching, { more: '#/continue' })}
      ${row('Recently Added', data.recentlyAdded.slice(0, 18), { more: '#/movies' })}
      ${row('Trending in Your Library', data.trending, {})}
      ${row('Recommended For You', data.recommended, {})}
      ${data.collections.length ? `<section><div class="section-head"><h2>Your Collections</h2><a href="#/collections" data-link>Manage</a></div>
        <div class="grid compact">${data.collections.map(item => `<button class="card" data-collection="${esc(item.id)}"><div class="poster" style="aspect-ratio:16/9"><div class="poster-fallback"><strong>${esc(item.name)}</strong><span>${esc(item.kind)}</span></div></div></button>`).join('')}</div></section>` : ''}
      ${!featured.length ? empty('Your library is ready', 'Add media folders in the Hearth desktop app and run a scan. New titles appear here automatically.', '🍿') : ''}`);
    if (featured.length) startHero(featured);
  }

  function hero(items) {
    const item = items[0];
    const backdrop = artUrl(item, 'backdrop');
    return `<section class="hero" id="home-hero">
      ${backdrop ? `<img class="hero-media" src="${esc(backdrop)}" alt="">` : '<div class="hero-fallback"></div>'}
      <div class="hero-content">
        <div class="hero-badge">${esc(item.type === 'episode' ? 'Featured Episode' : 'Featured Film')}</div>
        <h1>${esc(item.title)}</h1>
        <div class="hero-meta">${item.year ? `<span>${esc(item.year)}</span>` : ''}${item.rating ? `<span>★ ${Number(item.rating).toFixed(1)}</span>` : ''}${item.runtimeMs ? `<span>${formatRuntime(item.runtimeMs)}</span>` : ''}${item.genres?.length ? `<span>${esc(item.genres.slice(0, 3).join(', '))}</span>` : ''}</div>
        <p>${esc(item.overview || 'Metadata will appear after Hearth identifies this title.')}</p>
        <div class="hero-actions">
          <button class="primary" data-item="${esc(item.id)}" data-play="true">▶ Play</button>
          <button class="ghost" data-item="${esc(item.id)}">Details</button>
        </div>
      </div>
      <div class="hero-dots" id="hero-dots">${items.map((entry, index) => `<button data-hero="${index}" class="${index ? '' : 'active'}" aria-label="Featured title ${index + 1}"></button>`).join('')}</div>
    </section>`;
  }

  function startHero(items) {
    clearInterval(state.hero.timer);
    const dots = document.getElementById('hero-dots');
    if (!dots) return;
    const show = index => {
      const item = items[index];
      const heroEl = document.getElementById('home-hero');
      if (!heroEl) {
        clearInterval(state.hero.timer);
        state.hero.timer = null;
        return;
      }
      state.hero.index = index;
      const backdrop = artUrl(item, 'backdrop');
      const image = heroEl.querySelector('.hero-media');
      if (backdrop && image) image.src = backdrop;
      heroEl.querySelector('h1').textContent = item.title;
      heroEl.querySelector('.hero-badge').textContent = item.type === 'episode' ? 'Featured Episode' : 'Featured Film';
      heroEl.querySelector('.hero-meta').innerHTML = `${item.year ? `<span>${esc(item.year)}</span>` : ''}${item.rating ? `<span>★ ${Number(item.rating).toFixed(1)}</span>` : ''}${item.runtimeMs ? `<span>${formatRuntime(item.runtimeMs)}</span>` : ''}`;
      heroEl.querySelector('p').textContent = item.overview || 'Metadata will appear after Hearth identifies this title.';
      [...dots.children].forEach((dot, dotIndex) => dot.classList.toggle('active', dotIndex === index));
      heroEl.querySelectorAll('[data-item]').forEach(button => button.dataset.item = item.id);
    };
    dots.addEventListener('click', event => {
      const button = event.target.closest('[data-hero]');
      if (!button) return;
      show(Number(button.dataset.hero));
    });
    state.hero.timer = setInterval(() => show((state.hero.index + 1) % items.length), 8500);
  }

  async function moviesPage() {
    setMain(`<div class="page-head"><h1>Movies</h1><p>Every film in your personal library, sorted and filtered instantly.</p></div>
      <div class="filters" id="movie-filters"></div><div class="grid" id="movie-grid">${skeletons(12)}</div><div class="form-actions"><button class="ghost" id="load-more" hidden>Load more</button></div>`);
    await renderItemList('#movie-grid', '#movie-filters', 'movie', '#load-more');
  }

  async function musicPage() {
    setMain(`<div class="page-head"><h1>Music</h1><p>Artists, albums and playlists from your own audio collection.</p></div><div id="music-body">${skeletons(6)}</div>`);
    const [artists, albums] = await Promise.all([
      api.request('GET', '/api/music/artists'),
      api.request('GET', '/api/music/albums')
    ]);
    if (!artists.ok || !albums.ok) return setMain(empty('Music unavailable', 'Could not load your music library.', '🎵'));
    setMain(`<div class="page-head"><h1>Music</h1><p>Artists, albums and playlists from your own audio collection.</p></div>
      ${artists.data.artists.length ? `<section><div class="section-head"><h2>Artists</h2></div><div class="grid compact">${artists.data.artists.map(artist => `
        <button class="card" data-artist="${esc(artist.artist)}"><div class="poster" style="aspect-ratio:1"><div class="poster-fallback"><strong>${esc(artist.artist)}</strong><span>${artist.songs} songs</span></div></div></button>`).join('')}</div></section>` : ''}
      ${albums.data.albums.length ? `<section><div class="section-head"><h2>Albums</h2></div><div class="grid">${albums.data.albums.map(album => `
        <button class="card" data-album="${esc(album.album)}" data-artist="${esc(album.albumArtist)}">
          <div class="poster">${album.posterUrl ? `<img loading="lazy" src="${esc(album.posterUrl)}" alt="">` : `<div class="poster-fallback"><strong>${esc(album.album)}</strong><span>${esc(album.albumArtist)}</span></div>`}</div>
          <div class="card-label">${esc(album.album)}</div><div class="card-sub">${esc(album.albumArtist || '')} · ${album.tracks} tracks</div></button>`).join('')}</div></section>` : ''}
      ${!albums.data.albums.length ? empty('No albums indexed', 'Add a music library in the desktop app.', '🎧') : ''}`);
  }

  async function artistPage(artist) {
    const response = await api.request('GET', `/api/items?type=song&artist=${encodeURIComponent(artist)}&limit=100`);
    if (!response.ok) return setMain(empty('Artist unavailable', response.data?.message || '', '🎵'));
    setMain(`<div class="page-head"><button class="ghost" data-back="#/music">Back</button><h1>${esc(artist)}</h1></div>
      <section class="section-head"><h2>Albums</h2></section><div id="artist-albums" class="grid"></div>
      <section class="section-head"><h2>All Songs</h2></section><div class="row-scroll">${response.data.items.map(item => card(item)).join('') || empty('No songs', '')}</div>`);
    const albums = [...new Set(response.data.items.map(item => item.album).filter(Boolean))];
    document.getElementById('artist-albums').innerHTML = albums.map(album => {
      const sample = response.data.items.find(item => item.album === album);
      return `<button class="card" data-album="${esc(album)}" data-artist="${esc(artist)}"><div class="poster">${artUrl(sample, 'poster') ? `<img src="${esc(artUrl(sample, 'poster'))}" alt="">` : `<div class="poster-fallback"><strong>${esc(album)}</strong></div>`}</div><div class="card-label">${esc(album)}</div></button>`;
    }).join('') || empty('No albums grouped', 'Songs are still indexed.');
  }

  async function albumPage(album, artist) {
    const params = new URLSearchParams({ type: 'song', album, limit: '100' });
    if (artist) params.set('artist', artist);
    const response = await api.request('GET', `/api/items?${params}`);
    if (!response.ok) return setMain(empty('Album unavailable', response.data?.message || '', '🎵'));
    const tracks = response.data.items;
    const first = tracks[0];
    setMain(`<div class="page-head"><button class="ghost" data-back="#/music">Back</button><h1>${esc(album)}</h1><p>${esc(first?.albumArtist || artist || '')} · ${tracks.length} tracks</p></div>
      ${tracks.length ? `<button class="primary" id="play-album">▶ Play Album</button><div class="stack" style="margin-top:30px">${tracks.map((track, index) => `
        <button class="ghost wide" data-item="${esc(track.id)}" data-play="true" style="display:flex;justify-content:space-between">
          <span>${index + 1}. ${esc(track.title)}</span><span>${formatRuntime(track.runtimeMs)}</span></button>`).join('')}</div>` : empty('Album not indexed', '', '🎵')}`);
    document.getElementById('play-album')?.addEventListener('click', () => first && api.startPlay(first));
  }

  async function tvPage() {
    setMain(`<div class="page-head"><h1>TV Shows</h1><p>Browse series, seasons and episodes with watch progress.</p></div>
      <div class="filters"><input id="tv-search" placeholder="Search series"><button class="chip" id="tv-refresh">Search</button></div>
      <div class="grid" id="tv-grid">${skeletons(12)}</div>`);
    const load = async () => {
      const query = document.getElementById('tv-search').value.trim();
      const response = await api.request('GET', `/api/shows${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      if (!response.ok) return setMain(empty('TV library unavailable', response.data?.message || '', '📺'));
      document.getElementById('tv-grid').innerHTML = response.data.shows.map(showCard).join('') || empty('No series indexed', 'Add a TV library in the desktop app.', '📺');
    };
    document.getElementById('tv-refresh').addEventListener('click', load);
    document.getElementById('tv-search').addEventListener('keydown', event => { if (event.key === 'Enter') load(); });
    await load();
  }

  async function showPage(id) {
    setMain(skeletons(5));
    const response = await api.request('GET', `/api/shows/${id}`);
    if (!response.ok) return setMain(empty('Show unavailable', response.data?.message || ''));
    const show = response.data;
    setMain(`<div class="detail-hero">${show.backdropUrl ? `<img class="hero-media" src="${esc(show.backdropUrl)}" alt="">` : '<div class="hero-fallback"></div>'}
      <div class="hero-content"><div class="hero-badge">Series</div><h1>${esc(show.title)}</h1>
      <div class="hero-meta">${show.year ? `<span>${esc(show.year)}</span>` : ''}${show.rating ? `<span>★ ${Number(show.rating).toFixed(1)}</span>` : ''}<span>${show.episodeCount} episodes</span></div>
      <p>${esc(show.overview || '')}</p></div></div>
      ${show.cast?.length ? `<section><div class="section-head"><h2>Cast</h2></div><div class="cast-grid">${show.cast.map(person => `
        <div class="cast-card">${person.profile ? `<img class="avatar" src="${esc(person.profile)}" alt="">` : '<div class="avatar"></div>'}<strong>${esc(person.name)}</strong><span>${esc(person.character || '')}</span></div>`).join('')}</div></section>` : ''}
      ${show.seasons.map(season => `<section><div class="section-head"><h2>Season ${season.season}</h2></div>
        <div class="row-scroll">${season.episodes.map(item => card(item, { className: 'episode-card', wide: true, subtitle: `${formatRuntime(item.runtimeMs)} · ${item.episodeTitle || ''}` })).join('')}</div></section>`).join('')}`);
  }

  async function filesPage() {
    if (!state.libraries.some(library => library.type === 'files')) {
      setMain(`<div class="page-head"><h1>Files & Downloads</h1></div>${empty('No file library', 'Add a “Files” library in Hearth desktop to share documents and downloads.', '🗂️')}`);
      return;
    }
    if (!state.filesLibraryId) state.filesLibraryId = state.libraries.find(library => library.type === 'files').id;
    setMain(`<div class="page-head"><h1>Files & Downloads</h1><p>Browse approved folders and download with Range resume support.</p></div>
      <div class="filters"><select id="files-library">${state.libraries.filter(library => library.type === 'files').map(library => `<option value="${library.id}" ${library.id === state.filesLibraryId ? 'selected' : ''}>${esc(library.name)}</option>`).join('')}</select>
      <button class="chip" id="files-up">↑ Up</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody id="files-body"></tbody></table></div>`);
    document.getElementById('files-library').addEventListener('change', event => {
      state.filesLibraryId = Number(event.target.value); state.filesPath = ''; loadFiles();
    });
    document.getElementById('files-up').addEventListener('click', () => { state.filesPath = parentPath(state.filesPath); loadFiles(); });
    await loadFiles();
  }

  function parentPath(path) {
    if (!path) return '';
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    parts.pop();
    return parts.join('/');
  }

  async function loadFiles() {
    const body = document.getElementById('files-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
    const response = await api.request('GET', `/api/files?libraryId=${state.filesLibraryId}&path=${encodeURIComponent(state.filesPath)}`);
    if (!response.ok) { body.innerHTML = `<tr><td colspan="4">${esc(response.data?.message || 'Folder unavailable')}</td></tr>`; return; }
    state.filesPath = response.data.path;
    body.innerHTML = response.data.files.map(file => `<tr>
      <td class="name">${file.directory ? '📁' : '📄'} ${esc(file.name)}</td><td>${file.directory ? '—' : formatBytes(file.size)}</td>
      <td>${new Date(file.modified).toLocaleString()}</td><td class="actions">
      ${file.directory ? `<button class="chip small" data-open-path="${esc(file.path)}">Open</button>` : ''}
      ${!file.directory ? `<button class="file-action" data-preview-path="${esc(file.path)}" data-preview-lib="${state.filesLibraryId}">Preview</button>` : ''}
      ${!file.directory ? `<a class="file-action" href="${esc(file.downloadUrl)}" download>Download</a>` : `<a class="file-action" href="/api/files/download?libraryId=${state.filesLibraryId}&path=${encodeURIComponent(file.path)}">Download ZIP</a>`}
      </td></tr>`).join('') || '<tr><td colspan="4">This folder is empty.</td></tr>';
    body.querySelectorAll('[data-open-path]').forEach(button => button.addEventListener('click', () => {
      state.filesPath = button.dataset.openPath; loadFiles();
    }));
    body.querySelectorAll('[data-preview-path]').forEach(button => button.addEventListener('click', () => previewFile(Number(button.dataset.previewLib), button.dataset.previewPath)));
  }

  async function previewFile(libraryId, filePath) {
    const url = `/api/files/preview?libraryId=${libraryId}&path=${encodeURIComponent(filePath)}`;
    const modalWindow = modal('File preview', '<div class="stack"><div id="preview-area">Loading preview…</div><a class="primary" id="preview-download" download>Download</a></div>');
    const download = modalWindow.element.querySelector('#preview-download');
    download.href = `/api/files/download?libraryId=${libraryId}&path=${encodeURIComponent(filePath)}`;
    const area = modalWindow.element.querySelector('#preview-area');
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      const type = response.headers.get('content-type') || '';
      if (!response.ok) throw new Error((await response.json())?.message || 'Preview unavailable');
      if (type.startsWith('image/')) {
        const blob = await response.blob();
        area.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="">`;
      } else if (type.includes('pdf')) {
        area.innerHTML = `<iframe src="${url}" style="width:100%;height:65vh;border:0;border-radius:12px"></iframe>`;
      } else if (type.startsWith('video/') || type.startsWith('audio/')) {
        area.innerHTML = type.startsWith('video/') ? `<video controls src="${url}" style="width:100%;border-radius:12px"></video>` : `<audio controls src="${url}" style="width:100%"></audio>`;
      } else {
        area.innerHTML = `<pre style="white-space:pre-wrap;font:13px ui-monospace;background:#0a0a12;padding:18px;border-radius:12px">${esc(await response.text())}</pre>`;
      }
    } catch (error) {
      area.textContent = error.message;
    }
  }

  async function collectionsPage() {
    const response = await api.request('GET', '/api/collections');
    if (!response.ok) return setMain(empty('Collections unavailable', response.data?.message || ''));
    const collections = response.data.collections;
    setMain(`<div class="page-head"><h1>Collections</h1><p>Curate custom sets, favorites and watchlists.</p><button class="primary" data-action="create-collection">New collection</button></div>
      ${collections.length ? `<div class="grid compact">${collections.map(collection => `<button class="card" data-collection="${esc(collection.id)}">
        <div class="poster" style="aspect-ratio:16/9"><div class="poster-fallback"><strong>${esc(collection.name)}</strong><span>${esc(collection.kind)}</span></div></div>
        <div class="card-label">${esc(collection.name)}</div><div class="card-sub">${esc(collection.description || '')}</div></button>`).join('')}</div>` : empty('No collections yet', 'Create your first collection to organize titles.', '❐')}`);
  }

  async function collectionDetailPage(id) {
    const response = await api.request('GET', `/api/collections/${id}`);
    if (!response.ok) return setMain(empty('Collection unavailable', response.data?.message || ''));
    const { collection, items } = response.data;
    setMain(`<div class="page-head"><button class="ghost" data-back="#/collections">Back</button><h1>${esc(collection.name)}</h1><p>${esc(collection.description || '')}</p>
      <button class="danger" id="delete-collection">Delete</button></div>
      ${items.length ? `<div class="grid">${items.map(item => card(item)).join('')}</div>` : empty('Empty collection', 'Use the + button on any title to add it.', '❐')}`);
    document.getElementById('delete-collection').addEventListener('click', async () => {
      await api.request('DELETE', `/api/collections/${id}`);
      toast('Collection deleted');
      location.hash = '#/collections';
    });
  }

  async function createCollectionModal() {
    const window = modal('New collection', `<form id="collection-form" class="stack">
      <label class="field">Name<input name="name" required maxlength="100"></label>
      <label class="field">Type<select name="kind"><option value="collection">Collection</option><option value="playlist">Playlist</option></select></label>
      <label class="field">Description<textarea name="description" maxlength="1000"></textarea></label>
      <p class="form-error"></p><button class="primary" type="submit">Create</button></form>`);
    window.element.querySelector('#collection-form').addEventListener('submit', async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      const response = await api.request('POST', '/api/collections', data);
      if (!response.ok) { window.element.querySelector('.form-error').textContent = response.data?.message || 'Could not create'; return; }
      window.close(); toast('Collection created'); location.hash = `#/collections/${response.data.collection.id}`;
    });
  }

  async function searchPage(query) {
    setMain(`<div class="page-head"><h1>Search</h1></div><div class="filters"><input id="search-input" value="${esc(query || '')}" placeholder="Movies, episodes, songs, albums, artists"><button class="primary" id="search-run">Search</button></div><div id="search-results">${query ? '' : empty('Search your server', 'Find any indexed title, artist, album or file.', '⌕')}</div>`);
    const run = async () => {
      const value = document.getElementById('search-input').value.trim();
      if (!value) return;
      history.replaceState(null, '', `#/search/${encodeURIComponent(value)}`);
      document.getElementById('search-results').innerHTML = skeletons(6);
      const response = await api.request('GET', `/api/search?q=${encodeURIComponent(value)}`);
      document.getElementById('search-results').innerHTML = response.ok && response.data.items.length
        ? `<div class="grid">${response.data.items.map(item => card(item)).join('')}</div>`
        : empty('No matches', 'Try another title, artist, album or episode name.', '🔍');
    };
    document.getElementById('search-run').addEventListener('click', run);
    document.getElementById('search-input').addEventListener('keydown', event => { if (event.key === 'Enter') run(); });
    if (query) run();
  }

  async function listPage(kind, title, endpoint) {
    setMain(`<div class="page-head"><h1>${esc(title)}</h1></div><div class="grid">${skeletons(10)}</div>`);
    const response = await api.request('GET', endpoint);
    document.getElementById('main').innerHTML = `<div class="page-head"><h1>${esc(title)}</h1></div>${response.ok && response.data.items.length ? `<div class="grid">${response.data.items.map(item => card(item)).join('')}</div>` : empty(`No ${title.toLowerCase()} yet`, 'Titles you mark will appear here.')}`;
  }

  async function openItem(id, autoPlay = false) {
    const item = await api.getItem(id);
    if (autoPlay) { await api.startPlay(item); return; }
    const backdrop = artUrl(item, 'backdrop');
    const state = item.playback || {};
    const episodes = item.episodes || [];
    const tracks = item.tracks || [];
    const canPlay = ['movie', 'episode', 'song'].includes(item.type);
    modal(item.title, `
      <div class="detail-hero" style="min-height:280px">${backdrop ? `<img class="hero-media" src="${esc(backdrop)}" alt="">` : '<div class="hero-fallback"></div>'}
        <div class="hero-content"><div class="hero-meta">${item.year ? `<span>${esc(item.year)}</span>` : ''}${item.rating ? `<span>★ ${Number(item.rating).toFixed(1)}</span>` : ''}${item.runtimeMs ? `<span>${formatRuntime(item.runtimeMs)}</span>` : ''}<span>${esc(item.type)}</span></div>
        <h1 style="font-size:clamp(26px,5vw,48px)">${esc(item.title)}</h1>
        <div class="detail-actions">${canPlay ? `<button class="primary" data-play-item="${esc(item.id)}">▶ ${state.positionMs ? 'Resume' : 'Play'}</button>` : ''}
        <button class="ghost" data-fav-item="${esc(item.id)}">${item.favorite ? '★ Favorited' : '☆ Favorite'}</button>
        <button class="ghost" data-list-item="${esc(item.id)}">${item.watched ? '✓ On Watchlist' : '+ Watchlist'}</button>
        ${item.fileBytes ? `<button class="ghost" data-download-item="${esc(item.id)}">Download</button>` : ''}
        <button class="ghost" data-collect-item="${esc(item.id)}">+ Collection</button></div></div></div>
      ${item.overview ? `<p style="max-width:720px">${esc(item.overview)}</p>` : ''}
      <div class="detail-body"><div><h3>Details</h3><div class="stack">
        ${item.genres?.length ? `<div><strong>Genres:</strong> ${esc(item.genres.join(', '))}</div>` : ''}
        ${item.director ? `<div><strong>Director:</strong> ${esc(item.director)}</div>` : ''}
        ${item.artist ? `<div><strong>Artist:</strong> ${esc(item.artist)}</div>` : ''}
        ${item.album ? `<div><strong>Album:</strong> ${esc(item.album)}</div>` : ''}
        ${item.streams?.length ? `<div><strong>Media:</strong> ${esc(item.videoCodec || '')} ${item.height ? `${item.height}p` : ''} · ${esc(item.audioCodec || '')} · ${esc(item.container.toUpperCase())} · ${formatBytes(item.fileBytes)}</div>` : ''}
        ${item.streams?.length ? `<div><strong>Tracks:</strong> ${item.streams.filter(stream => stream.type === 'audio').length} audio · ${item.streams.filter(stream => stream.type === 'subtitle').length} subtitle</div>` : ''}
      </div></div>
      ${item.cast?.length ? `<div><h3>Top cast</h3><div class="cast-grid">${item.cast.map(person => `<div class="cast-card"><div class="avatar"></div><strong>${esc(person.name)}</strong><span>${esc(person.character || '')}</span></div>`).join('')}</div></div>` : ''}</div>
      ${episodes.length ? `<section><div class="section-head"><h2>Episodes</h2></div><div class="grid wide">${episodes.map(entry => card(entry, { className: 'episode-card', wide: true, subtitle: `S${entry.seasonNumber}E${entry.episodeNumber} · ${entry.episodeTitle || ''}` })).join('')}</div></section>` : ''}
      ${tracks.length ? `<section><div class="section-head"><h2>Tracks</h2></div><div class="stack">${tracks.map((track, index) => `<button class="ghost wide" data-item="${esc(track.id)}" data-play="true" style="display:flex;justify-content:space-between"><span>${index + 1}. ${esc(track.title)}</span><span>${formatRuntime(track.runtimeMs)}</span></button>`).join('')}</div></section>` : ''}`);
    const modalRoot = document.getElementById('modal-root');
    modalRoot.querySelector('[data-play-item]')?.addEventListener('click', () => api.startPlay(item));
    modalRoot.querySelector('[data-fav-item]')?.addEventListener('click', async event => {
      const response = await api.request('POST', `/api/items/${item.id}/favorite`, { value: !item.favorite });
      if (response.ok) { event.target.textContent = response.data.favorite ? '★ Favorited' : '☆ Favorite'; item.favorite = response.data.favorite; }
    });
    modalRoot.querySelector('[data-list-item]')?.addEventListener('click', async event => {
      const response = await api.request('POST', `/api/items/${item.id}/watchlist`, { value: !item.watched });
      if (response.ok) { event.target.textContent = response.data.watchlist ? '✓ On Watchlist' : '+ Watchlist'; item.watched = response.data.watchlist; }
    });
    modalRoot.querySelector('[data-download-item]')?.addEventListener('click', () => {
      window.location.href = `/api/items/${item.id}/download`;
    });
    modalRoot.querySelector('[data-collect-item]')?.addEventListener('click', async () => {
      const collections = await api.request('GET', '/api/collections');
      const collectionWindow = modal('Add to collection', `<form id="add-to-collection" class="stack">
        <label class="field">Collection<select name="id" required>${collections.data.collections.map(entry => `<option value="${esc(entry.id)}">${esc(entry.name)}</option>`).join('')}</select></label>
        <button class="primary" type="submit">Add</button></form>`);
      collectionWindow.element.querySelector('#add-to-collection').addEventListener('submit', async event => {
        event.preventDefault();
        const collectionId = new FormData(event.target).get('id');
        const response = await api.request('POST', `/api/collections/${collectionId}/items/${item.id}`);
        if (response.ok) { collectionWindow.close(); toast('Added to collection'); } else toast(response.data?.message || 'Could not add', 'error');
      });
    });
  }

  async function renderItemList(gridSelector, filterSelector, type, moreId) {
    const params = new URLSearchParams({ type, page: state.page, limit: '48', ...(state.filters[type] || {}) });
    const response = await api.request('GET', `/api/items?${params}`);
    if (!response.ok) { document.querySelector(gridSelector).innerHTML = ''; setMain(empty('Library unavailable', response.data?.message || '')); return; }
    state.pages = response.data.pages;
    const genres = [...new Set(response.data.items.flatMap(item => item.genres || []))].sort();
    const years = [...new Set(response.data.items.map(item => item.year).filter(Boolean))].sort((a, b) => b - a);
    if (filterSelector) document.querySelector(filterSelector).innerHTML = `
      <input data-filter="q" placeholder="Search ${type === 'song' ? 'songs' : 'titles'}" value="${esc(state.filters[type]?.q || '')}">
      ${type === 'song' ? '' : `<select data-filter="genre"><option value="">All genres</option>${genres.map(genre => `<option ${state.filters[type]?.genre === genre ? 'selected' : ''}>${esc(genre)}</option>`).join('')}</select>`}
      ${type === 'song' ? '' : `<select data-filter="year"><option value="">All years</option>${years.map(year => `<option ${String(state.filters[type]?.year) === String(year) ? 'selected' : ''}>${year}</option>`).join('')}</select>`}
      <select data-filter="sort"><option value="added">Recently added</option><option value="title" ${state.filters[type]?.sort === 'title' ? 'selected' : ''}>Title</option><option value="year" ${state.filters[type]?.sort === 'year' ? 'selected' : ''}>Year</option><option value="rating" ${state.filters[type]?.sort === 'rating' ? 'selected' : ''}>Rating</option></select>`;
    document.querySelector(gridSelector).innerHTML = response.data.items.map(item => card(item)).join('') || empty('No titles found', 'Adjust filters or add media folders.', '🎞️');
    document.querySelectorAll('[data-filter]').forEach(input => input.addEventListener('change', () => {
      state.filters[type] = { ...(state.filters[type] || {}) };
      if (input.dataset.filter === 'sort' || input.value) state.filters[type][input.dataset.filter] = input.value;
      else delete state.filters[type][input.dataset.filter];
      state.page = 1; renderItemList(gridSelector, filterSelector, type, moreId);
    }));
    const more = document.getElementById(moreId);
    if (more) {
      more.hidden = state.page >= state.pages;
      more.onclick = () => { state.page++; renderItemList(gridSelector, filterSelector, type, moreId); };
    }
  }

  async function route() {
    const hash = location.hash.slice(2) || 'home';
    state.route = hash;
    if (!state.user) return;
    const parts = hash.split('/');
    switch (parts[0]) {
      case 'home': await homePage(); break;
      case 'movies': state.page = 1; await moviesPage(); break;
      case 'tv': parts[1] ? await showPage(decodeURIComponent(parts[1])) : await tvPage(); break;
      case 'music':
        if (parts[1] === 'artist') await artistPage(decodeURIComponent(parts[2]));
        else if (parts[1] === 'album') await albumPage(decodeURIComponent(parts[2]), decodeURIComponent(parts[3] || ''));
        else await musicPage();
        break;
      case 'files': await filesPage(); break;
      case 'collections': parts[1] ? await collectionDetailPage(parts[1]) : await collectionsPage(); break;
      case 'search': await searchPage(decodeURIComponent(parts[1] || '')); break;
      case 'favorites': await listPage('favorites', 'Favorites', '/api/me/favorites'); break;
      case 'watchlist': await listPage('watchlist', 'Watchlist', '/api/me/watchlist'); break;
      case 'continue': await listPage('continue', 'Continue Watching', '/api/me/continue-watching'); break;
      default: location.hash = '#/home';
    }
  }

  async function boot() {
    try {
      const health = await fetch('/api/health');
      if (!health.ok) throw new Error('Server health check failed');
      await init();
      state.booted = true;
      window.addEventListener('hashchange', route);
      await route();
      if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    } catch (error) {
      app.innerHTML = `<div class="auth-screen"><div class="auth-panel"><h1>Server unavailable</h1><p>${esc(error.message)}</p><button class="primary" id="retry-server">Retry</button></div></div>`;
      document.getElementById('retry-server')?.addEventListener('click', () => location.reload());
    }
  }

  boot();
})();
