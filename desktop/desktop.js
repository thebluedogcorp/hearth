'use strict';

(() => {
  const app = document.getElementById('app');
  const view = () => document.getElementById('view');
  const state = { setup: null, status: null, stats: null, settings: null, users: [], libraries: [], storage: null, diagnostics: null, service: null, activity: [], notifications: [] };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function toast(message, type = 'success') {
    const root = document.createElement('div');
    root.className = `notice ${type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'ok'}`;
    root.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:200;max-width:360px;box-shadow:var(--shadow)';
    root.textContent = message;
    document.body.appendChild(root);
    setTimeout(() => root.remove(), 4500);
  }

  async function request(method, path, body) {
    const response = await window.hearth.request(method, path, body);
    if (!response.ok && response.status !== 401) toast(response.data?.message || `Request failed (${response.status})`, 'error');
    return response;
  }

  function bytes(value) {
    const num = Number(value) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let result = num; let index = 0;
    while (result >= 1024 && index < units.length - 1) { result /= 1024; index++; }
    return `${result.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function timeAgo(value) {
    if (!value) return 'never';
    const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  async function ensureShell() {
    if (!document.getElementById('view')) {
      app.innerHTML = '';
      app.appendChild(document.getElementById('tpl-shell').content.cloneNode(true));
      document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        render(button.dataset.view);
      }));
      document.getElementById('btn-start').addEventListener('click', async () => {
        document.getElementById('btn-start').disabled = true;
        await window.hearth.control('start');
        document.getElementById('btn-start').disabled = false;
        await refreshStatus();
        toast('Server start requested');
      });
      document.getElementById('btn-stop').addEventListener('click', async () => {
        document.getElementById('btn-stop').disabled = true;
        await window.hearth.control('stop');
        document.getElementById('btn-stop').disabled = false;
        await refreshStatus();
        toast('Server stopped');
      });
      document.getElementById('btn-restart').addEventListener('click', async () => {
        document.getElementById('btn-restart').disabled = true;
        await window.hearth.control('restart');
        document.getElementById('btn-restart').disabled = false;
        await refreshStatus();
        toast('Server restarted');
      });
      document.getElementById('btn-open-web').addEventListener('click', () => {
        window.hearth.openExternal(`http://127.0.0.1:${state.status?.port || 7341}`);
      });
      window.hearth.onServerStatus(async () => { await refreshStatus(); updateStatusChrome(); });
      setInterval(refreshStatus, 5000);
      setInterval(refreshData, 15000);
    }
  }

  function updateStatusChrome() {
    const dot = document.getElementById('status-dot');
    const label = document.getElementById('status-label');
    const detail = document.getElementById('status-detail');
    if (!dot || !label || !detail) return;
    dot.classList.toggle('online', Boolean(state.status?.running));
    label.textContent = state.status?.running ? 'Online' : 'Offline';
    detail.textContent = state.status?.running ? `Server · port ${state.status.port}` : 'Server stopped';
  }

  async function refreshStatus() {
    state.status = await window.hearth.status();
    updateStatusChrome();
  }

  async function refreshData() {
    if (!document.getElementById('view') || document.getElementById('wizard-body') || state.setupMode) return;
    const results = await Promise.allSettled([
      request('GET', '/api/admin/stats'), request('GET', '/api/admin/settings'), request('GET', '/api/admin/users'),
      request('GET', '/api/admin/storage'), request('GET', '/api/admin/activity?limit=30'), request('GET', '/api/admin/notifications'),
      request('GET', '/api/admin/diagnostics')
    ]);
    state.stats = results[0].status === 'fulfilled' ? results[0].value.data : state.stats;
    state.settings = results[1].status === 'fulfilled' ? results[1].value.data.settings : state.settings;
    state.users = results[2].status === 'fulfilled' ? results[2].value.data.users : state.users;
    state.storage = results[3].status === 'fulfilled' ? results[3].value.data.storage : state.storage;
    state.activity = results[4].status === 'fulfilled' ? results[4].value.data.activity : state.activity;
    state.notifications = results[5].status === 'fulfilled' ? results[5].value.data.notifications : state.notifications;
    state.diagnostics = results[6].status === 'fulfilled' ? results[6].value.data : state.diagnostics;
    // Do not wipe a form out from under the user while they are editing it.
    const editing = document.querySelector('#library-form:not(.hidden), #user-form:not(.hidden), .modal-backdrop');
    if (editing) return;
    const activeView = document.querySelector('.nav-item.active')?.dataset.view || 'dashboard';
    if (activeView === 'dashboard') renderDashboard(true);
    if (activeView === 'libraries') renderLibraries(true);
    if (activeView === 'storage') renderStorage(true);
    if (activeView === 'users') renderUsers(true);
    if (activeView === 'network') renderNetwork(true);
    if (activeView === 'playback') renderPlayback(true);
    if (activeView === 'metadata') renderMetadata(true);
    if (activeView === 'logs') renderLogs(true);
    if (activeView === 'backup') renderBackup(true);
  }

  async function boot() {
    const setup = await request('GET', '/api/setup');
    state.setup = setup.data;
    if (!setup.ok || setup.data?.configured) {
      const me = await request('GET', '/api/auth/me');
      if (!me.ok) {
        await ensureShell();
        renderLogin();
        return;
      }
      await ensureShell();
      await refreshStatus();
      await refreshData();
      render('dashboard');
      return;
    }
    await ensureShell();
    await refreshStatus();
    renderOnboarding();
  }

  function renderLogin() {
    view().innerHTML = `
      <div class="wizard"><div class="wizard-head"><div class="brand">HEARTH</div><h1>Sign in</h1><p>Confirm the administrator account created during setup.</p></div>
      <div class="panel"><form id="desktop-login" class="stack"><div class="form-grid"><label class="field">Username<input name="username" autocomplete="username" required></label>
      <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label></div><p class="form-error" id="login-error"></p><button class="primary" type="submit">Sign in</button></form></div></div>`;
    document.getElementById('desktop-login').addEventListener('submit', async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      const response = await window.hearth.request('POST', '/api/auth/login', data);
      if (!response.ok) { document.getElementById('login-error').textContent = response.data?.message || 'Sign-in failed'; return; }
      await refreshStatus(); await refreshData(); render('dashboard');
    });
  }

  async function renderOnboarding() {
    state.setupMode = true;
    document.body.classList.add('setup-mode');
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const root = view();
    root.innerHTML = '';
    const wizardState = { libraries: [], remoteMode: 'off', remoteEnabled: false, remotePublicUrl: '', bindAddress: '0.0.0.0', port: 7341, serverName: 'Hearth', metadata: { tmdbKey: '', musicBrainzToken: '' }, advanced: false };
    root.innerHTML = `
      <div class="quick-setup">
        <div class="wizard-head">
          <div class="brand">HEARTH</div>
          <h1>Create your private streaming server</h1>
          <p>Add a folder, choose a password, and press one button. You can add more libraries, users and remote access later.</p>
        </div>
        <div class="panel setup-panel">
          <section class="setup-step">
            <div class="setup-step-title"><span>1</span><div><strong>Add media folders</strong><small>Hearth reads these folders; it never moves or changes your files.</small></div></div>
            <div class="setup-add-row">
              <button class="primary" id="pick-library">Choose folder…</button>
              <span class="setup-hint">Movie, TV, music and download folders are all supported.</span>
            </div>
            <div id="library-list" class="row-list"></div>
          </section>
          <section class="setup-step">
            <div class="setup-step-title"><span>2</span><div><strong>Create your administrator account</strong><small>This is the sign-in for managing Hearth.</small></div></div>
            <div class="form-grid">
              <label class="field">Username<input id="wizard-username" value="admin" autocomplete="username"></label>
              <label class="field">Password<input id="wizard-password" type="password" autocomplete="new-password" placeholder="At least 12 characters"></label>
              <label class="field">Confirm password<input id="wizard-password2" type="password" autocomplete="new-password"></label>
            </div>
          </section>
          <section class="setup-step">
            <div class="setup-step-title"><span>3</span><div><strong>Create the server</strong><small>Hearth will scan your folders automatically.</small></div></div>
            <button class="primary wide" id="wizard-next">Create my server</button>
            <p class="form-error" id="wizard-error"></p>
          </section>
          <details class="setup-advanced" id="advanced-settings">
            <summary>Advanced settings (optional)</summary>
            <div class="form-grid" style="margin-top:16px">
              <label class="field">Server name<input id="wizard-server-name" value="Hearth" maxlength="60"></label>
              <label class="field">Port<input id="wizard-port" type="number" min="1024" max="65535" value="7341"></label>
              <label class="field">Visibility<select id="wizard-bind"><option value="0.0.0.0">Home network and remote</option><option value="127.0.0.1">This PC only</option></select></label>
              <label class="field">TMDB API key (optional)<input id="wizard-tmdb" placeholder="Improves movie and TV artwork"></label>
              <label class="field">MusicBrainz token (optional)<input id="wizard-mbtoken" placeholder="Optional music metadata token"></label>
            </div>
            <div class="notice">Remote access is off by default. You can safely enable VPN, HTTPS proxy or a temporary tunnel later from Network.</div>
          </details>
        </div>
      </div>`;

    const inferLibraryType = folder => {
      const name = folder.toLowerCase();
      if (/(movie|film|cinema)/.test(name)) return 'movies';
      if (/(tv|show|series|episode)/.test(name)) return 'tv';
      if (/(music|audio|song|album)/.test(name)) return 'music';
      if (/(download|file|document|share)/.test(name)) return 'files';
      return 'movies';
    };

    const drawLibraries = () => {
      const list = document.getElementById('library-list');
      list.innerHTML = wizardState.libraries.map((library, index) => `
        <div class="item-row">
          <div class="grow"><strong>${esc(library.name || 'Media library')}</strong><small>${esc(library.path)}</small></div>
          <div class="actions">
            <select data-index="${index}" data-field="type">
              <option value="movies" ${library.type === 'movies' ? 'selected' : ''}>Movies</option>
              <option value="tv" ${library.type === 'tv' ? 'selected' : ''}>TV Shows</option>
              <option value="music" ${library.type === 'music' ? 'selected' : ''}>Music</option>
              <option value="files" ${library.type === 'files' ? 'selected' : ''}>Files</option>
            </select>
            <button class="danger small" data-remove="${index}">Remove</button>
          </div>
        </div>`).join('') || '<div class="empty"><strong>No folder selected yet</strong>You can also add folders after setup.</div>';
    };

    document.getElementById('pick-library').addEventListener('click', async () => {
      const folders = await window.hearth.pickDirectory();
      if (!folders?.length) return;
      for (const folder of folders) {
        if (wizardState.libraries.some(library => library.path.toLowerCase() === folder.toLowerCase())) continue;
        wizardState.libraries.push({ name: folder.split(/[\\/]/).pop() || 'Media', path: folder, type: inferLibraryType(folder) });
      }
      drawLibraries();
    });
    document.getElementById('library-list').addEventListener('change', event => {
      const select = event.target.closest('[data-field]');
      if (select) wizardState.libraries[Number(select.dataset.index)].type = select.value;
    });
    document.getElementById('library-list').addEventListener('click', event => {
      const remove = event.target.closest('[data-remove]');
      if (remove) { wizardState.libraries.splice(Number(remove.dataset.remove), 1); drawLibraries(); }
    });
    document.getElementById('wizard-server-name').addEventListener('input', event => wizardState.serverName = event.target.value);
    document.getElementById('wizard-port').addEventListener('input', event => wizardState.port = Number(event.target.value));
    document.getElementById('wizard-bind').addEventListener('change', event => wizardState.bindAddress = event.target.value);
    document.getElementById('wizard-tmdb').addEventListener('input', event => wizardState.metadata.tmdbKey = event.target.value);
    document.getElementById('wizard-mbtoken').addEventListener('input', event => wizardState.metadata.musicBrainzToken = event.target.value);
    drawLibraries();

    document.getElementById('wizard-next').addEventListener('click', async () => {
      const error = document.getElementById('wizard-error');
      error.textContent = '';
      const username = document.getElementById('wizard-username').value.trim();
      const password = document.getElementById('wizard-password').value;
      if (password.length < 12) { error.textContent = 'Please use at least 12 characters for your password.'; return; }
      if (password !== document.getElementById('wizard-password2').value) { error.textContent = 'The passwords do not match.'; return; }
      if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) { error.textContent = 'Use 3–64 letters, numbers, dots, underscores or hyphens for the username.'; return; }

      const button = document.getElementById('wizard-next');
      button.disabled = true;
      button.textContent = 'Creating your server…';
      try {
        const response = await request('POST', '/api/setup', {
          step: 'complete', serverName: wizardState.serverName || 'Hearth', port: wizardState.port,
          bindAddress: wizardState.bindAddress, admin: { username, password },
          libraries: wizardState.libraries,
          remote: { mode: wizardState.remoteMode, enabled: wizardState.remoteEnabled, publicUrl: wizardState.remotePublicUrl },
          metadata: wizardState.metadata
        });
        if (!response.ok) throw new Error(response.data?.message || 'Setup could not complete');
        state.setupMode = false;
        state.setup = { configured: true };
        document.body.classList.remove('setup-mode');
        if (response.data?.restartRequired) {
          await window.hearth.control('restart');
          await new Promise(resolve => setTimeout(resolve, 2500));
        }
        await refreshStatus();
        await refreshData();
        document.querySelector('.nav-item[data-view="dashboard"]')?.classList.add('active');
        render('dashboard');
        toast('Your server is ready!', 'success');
      } catch (submitError) {
        error.textContent = submitError.message;
        button.disabled = false;
        button.textContent = 'Create my server';
      }
    });
  }

  function metric(label, value, detail, percentage) {
    return `<div class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail || '')}</small>${percentage !== undefined ? `<div class="bar"><span style="width:${Math.max(0, Math.min(100, percentage))}%"></span></div>` : ''}</div>`;
  }

  function renderDashboard(onlyUpdate = false) {
    if (!view() || document.getElementById('wizard-body')) return;
    const stats = state.stats || {};
    const mem = stats.memory || {};
    const disk = stats.storage?.systemDisk || {};
    const used = disk.size && disk.free !== undefined ? disk.size - disk.free : 0;
    view().innerHTML = `
      <div class="view-head"><div><h1>Dashboard</h1><p>Server health, active sessions, bandwidth and library activity in one place.</p></div>
        <div class="head-actions"><button class="ghost" id="scan-all">Scan libraries</button><button class="primary" id="open-web">Open Web App</button></div></div>
      <div class="metric-grid">
        ${metric('Server status', stats.status === 'online' ? 'Online' : 'Offline', `${state.status?.running ? 'Process running' : 'Process stopped'} · v${stats.version || ''}`)}
        ${metric('CPU', `${stats.cpu?.system ?? 0}%`, `System · process ${stats.cpu?.process ?? 0}%`, stats.cpu?.system ?? 0)}
        ${metric('Memory', bytes(mem.systemFreeBytes ? (mem.systemTotalBytes - mem.systemFreeBytes) : 0), `Free ${bytes(mem.systemFreeBytes)} of ${bytes(mem.systemTotalBytes)}`, mem.systemTotalBytes ? (mem.systemTotalBytes - mem.systemFreeBytes) / mem.systemTotalBytes * 100 : 0)}
        ${metric('Network I/O', `${bytes(stats.network?.bytesPerSecond || 0)}/s`, `Total sent ${bytes(stats.network?.totalBytes || 0)}`)}
      </div>
      <div class="section"><div class="metric-grid">
        ${metric('Active users', stats.activeUsers ?? 0, 'Signed in in the last minute')}
        ${metric('Active streams', stats.activeStreams ?? 0, 'Playback sessions in last 90 seconds')}
        ${metric('Library items', ['movie', 'episode', 'song', 'file'].reduce((sum, type) => sum + (stats.media?.[type] || 0), 0), `Movies ${stats.media?.movie || 0} · TV ${stats.media?.episode || 0} · Music ${stats.media?.song || 0} · Files ${stats.media?.file || 0}`)}
        ${metric('Disk space free', bytes(disk.free), `${bytes(disk.size)} total`, disk.size ? used / disk.size * 100 : 0)}
      </div></div>
      <div class="section"><div class="section-head"><h2>Notifications</h2></div><div class="stack">${state.notifications?.length ? state.notifications.map(note => `<div class="notice ${note.level === 'warning' ? 'warn' : ''}">${esc(note.message)}</div>`).join('') : '<div class="notice ok">No notifications. Your server is healthy.</div>'}</div></div>
      <div class="section"><div class="section-head"><h2>Recent activity</h2></div><div class="row-list">${state.activity?.map(entry => `<div class="item-row"><div class="grow"><strong>${esc(entry.message)}</strong><small>${new Date(entry.createdAt).toLocaleString()} · ${esc(entry.level)}</small></div></div>`).join('') || '<div class="empty">No recent activity</div>'}</div></div>
      <div class="section"><div class="section-head"><h2>Library scan</h2></div><div class="panel"><div class="stat-line"><span>Status</span><span>${stats.scan?.running ? 'Scanning' : 'Idle'}</span></div>
        <div class="stat-line"><span>Discovered / processed</span><span>${stats.scan?.discovered || 0} / ${stats.scan?.processed || 0}</span></div>
        <div class="stat-line"><span>Added / updated / missing</span><span>${stats.scan?.added || 0} / ${stats.scan?.updated || 0} / ${stats.scan?.removed || 0}</span></div>
        <div class="stat-line"><span>Metadata pending</span><span>${stats.scan?.metadataPending || 0}</span></div></div></div>
      <div class="section"><div class="section-head"><h2>Windows background service</h2></div><div class="panel"><div class="stack" id="service-area"></div></div></div>`;
    document.getElementById('scan-all').addEventListener('click', async () => { await request('POST', '/api/admin/scan', {}); toast('Scan queued'); });
    document.getElementById('open-web').addEventListener('click', () => window.hearth.openExternal(`http://127.0.0.1:${state.status?.port || 7341}`));
    renderServiceControls();
    if (onlyUpdate) return;
  }

  async function renderServiceControls() {
    const area = document.getElementById('service-area');
    if (!area) return;
    const serviceState = await window.hearth.serviceStatus();
    if (document.getElementById('service-area') !== area) return;
    state.service = serviceState;
    const installed = state.service.available && state.service.status && !['NotInstalled', 'unsupported'].includes(state.service.status);
    area.innerHTML = `<div class="item-row"><div class="grow"><strong>${installed ? `Service: ${esc(state.service.status)}` : 'Service not installed'}</strong><small>${installed ? 'Runs even when the desktop app is closed.' : 'Optional. Requires administrator approval.'}</small></div><div class="actions">
      ${installed && state.service.status !== 'Running' ? '<button class="primary" id="service-start">Start</button>' : ''}
      ${installed && state.service.status === 'Running' ? '<button class="ghost" id="service-stop">Stop</button>' : ''}
      ${installed ? '<button class="danger" id="service-uninstall">Uninstall</button>' : (state.service.available ? '<button class="primary" id="service-install">Install Service</button>' : '')}</div></div>
      ${!state.service.available ? '<div class="notice">Background service is available on Windows installations.</div>' : ''}
      <label class="check-row"><input type="checkbox" id="auto-restart" ${state.status?.restartEnabled ? 'checked' : ''}><div><strong>Restart on failure</strong><small>Automatically restarts the desktop-managed server process after an unexpected exit.</small></div></label>
      ${state.service.status === 'Running' ? '<div class="notice warn">While the service runs, stop it before changing the port or restoring a backup.</div>' : ''}`;
    const restartToggle = document.getElementById('auto-restart');
    if (!restartToggle) return;
    restartToggle.addEventListener('change', async event => {
      state.status = await window.hearth.setRestart(event.target.checked);
      toast(event.target.checked ? 'Automatic restart enabled' : 'Automatic restart disabled');
    });
    document.getElementById('service-install')?.addEventListener('click', async () => {
      try { await window.hearth.serviceInstall(); toast('Service installed'); } catch (error) { toast(error.message, 'error'); }
      await refreshStatus(); renderServiceControls();
    });
    document.getElementById('service-start')?.addEventListener('click', async () => { try { await window.hearth.serviceControl('start'); toast('Service started'); } catch (error) { toast(error.message, 'error'); } await refreshStatus(); renderServiceControls(); });
    document.getElementById('service-stop')?.addEventListener('click', async () => { try { await window.hearth.serviceControl('stop'); toast('Service stopped'); } catch (error) { toast(error.message, 'error'); } await refreshStatus(); renderServiceControls(); });
    document.getElementById('service-uninstall')?.addEventListener('click', async () => { try { await window.hearth.serviceControl('uninstall'); toast('Service uninstalled'); } catch (error) { toast(error.message, 'error'); } await refreshStatus(); renderServiceControls(); });
  }

  function inferLibraryType(folder) {
    const name = String(folder).toLowerCase();
    if (/(movie|film|cinema)/.test(name)) return 'movies';
    if (/(tv|show|series|episode)/.test(name)) return 'tv';
    if (/(music|audio|song|album)/.test(name)) return 'music';
    if (/(download|file|document|share)/.test(name)) return 'files';
    return 'movies';
  }

  function renderLibraries(onlyUpdate = false) {
    view().innerHTML = `<div class="view-head"><div><h1>Media libraries</h1><p>Choose a folder and Hearth detects the library type. You can edit it before scanning.</p></div>
      <div class="head-actions"><button class="primary" id="quick-add-library">Add Folder</button><button class="ghost" id="add-library">Advanced</button><button class="ghost" id="scan-all">Scan All</button></div></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Path</th><th>Last scan</th><th>Actions</th></tr></thead><tbody>${state.storage?.libraries?.map(library => `<tr>
        <td><strong>${esc(library.name)}</strong></td><td>${esc(library.type)}</td><td class="path">${esc(library.path)}</td><td>${timeAgo(library.lastScanAt)}</td>
        <td class="actions"><button class="ghost small" data-scan="${library.id}">Scan</button><button class="ghost small" data-full="${library.id}">Full Scan</button><button class="danger small" data-remove="${library.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="5">No libraries configured yet.</td></tr>'}</tbody></table></div>
      <div class="notice" style="margin-top:18px">Hearth indexes files in these folders. It never deletes or moves your original media.</div>
      <div id="library-form" class="panel hidden" style="margin-top:25px"><h2>Add library</h2><div class="form-grid">
        <label class="field">Display name<input id="library-name"></label><label class="field">Category<select id="library-type"><option value="movies">Movies</option><option value="tv">TV Shows</option><option value="music">Music</option><option value="files">Files / Downloads</option></select></label>
        <label class="field">Folder path<input id="library-path" placeholder="D:\\Media\\Movies"></label><div class="field"><span>&nbsp;</span><button class="ghost" id="choose-path">Choose folder</button></div></div>
        <p class="form-error" id="library-error"></p><div class="form-actions"><button class="ghost" id="cancel-library">Cancel</button><button class="primary" id="save-library">Save and scan</button></div></div>`;

    const guess = folder => inferLibraryType(folder);
    const folderName = folder => folder.split(/[\\/]/).filter(Boolean).pop() || 'Media';
    const addLibrary = async library => {
      const response = await request('POST', '/api/admin/libraries', library);
      if (response.ok) {
        toast(`Library added: ${library.name}`);
        await refreshData();
        renderLibraries(true);
      } else {
        toast(response.data?.message || 'Could not add library', 'error');
      }
    };

    document.getElementById('quick-add-library').addEventListener('click', async () => {
      const folders = await window.hearth.pickDirectory();
      if (!folders?.length) return;
      for (const folder of folders) {
        await addLibrary({ name: folderName(folder), path: folder, type: guess(folder) });
      }
    });
    document.getElementById('add-library').addEventListener('click', () => document.getElementById('library-form').classList.remove('hidden'));
    document.getElementById('cancel-library').addEventListener('click', () => document.getElementById('library-form').classList.add('hidden'));
    document.getElementById('choose-path').addEventListener('click', async () => {
      const folders = await window.hearth.pickDirectory();
      const folder = folders?.[0];
      if (!folder) return;
      document.getElementById('library-path').value = folder;
      if (!document.getElementById('library-name').value.trim()) document.getElementById('library-name').value = folderName(folder);
      document.getElementById('library-type').value = guess(folder);
    });
    document.getElementById('save-library').addEventListener('click', async () => {
      const library = {
        name: document.getElementById('library-name').value.trim(),
        type: document.getElementById('library-type').value,
        path: document.getElementById('library-path').value.trim()
      };
      if (!library.name || !library.path) {
        document.getElementById('library-error').textContent = 'Choose a folder and enter a library name.';
        return;
      }
      const response = await request('POST', '/api/admin/libraries', library);
      if (response.ok) {
        document.getElementById('library-form').classList.add('hidden');
        toast(`Library added: ${library.name}`);
        await refreshData();
        renderLibraries(true);
      } else {
        document.getElementById('library-error').textContent = response.data?.message || 'Could not add library';
      }
    });
    document.getElementById('scan-all').addEventListener('click', async () => { await request('POST', '/api/admin/scan', {}); toast('Scan queued'); });
    view().querySelectorAll('[data-scan]').forEach(button => button.addEventListener('click', () => request('POST', `/api/admin/libraries/${button.dataset.scan}/scan`, {})));
    view().querySelectorAll('[data-full]').forEach(button => button.addEventListener('click', () => request('POST', `/api/admin/libraries/${button.dataset.full}/scan`, { full: true })));
    view().querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', async () => { if (confirm('Remove this library and its indexed metadata? Files are not deleted.')) { await request('DELETE', `/api/admin/libraries/${button.dataset.remove}`); await refreshData(); renderLibraries(true); } }));
    if (onlyUpdate) return;
  }

  function renderStorage(onlyUpdate = false) {
    const storage = state.storage || {};
    view().innerHTML = `<div class="view-head"><div><h1>Storage</h1><p>See disk capacity and media counts for each configured folder.</p></div></div>
      <div class="metric-grid">${metric('System disk free', bytes(storage.systemDisk?.free), `${bytes(storage.systemDisk?.size)} total`, storage.systemDisk ? 100 - storage.systemDisk.free / storage.systemDisk.size * 100 : 0)}
        ${metric('Libraries', storage.libraries?.length || 0, 'Configured storage locations')}
        ${metric('Total indexed bytes', bytes((storage.libraries || []).flatMap(library => library.media || []).reduce((sum, row) => sum + row.bytes, 0)), 'Media files from scans')}</div>
      <div class="section"><div class="section-head"><h2>Library storage</h2></div><div class="table-wrap"><table><thead><tr><th>Library</th><th>Path</th><th>Media</th><th>Indexed size</th><th>Disk free</th></tr></thead><tbody>
      ${(storage.libraries || []).map(library => `<tr><td><strong>${esc(library.name)}</strong></td><td class="path">${esc(library.path)}</td><td>${(library.media || []).map(row => `${row.count} ${row.type}`).join(', ') || '0'}</td><td>${bytes((library.media || []).reduce((sum, row) => sum + row.bytes, 0))}</td><td>${library.disk ? bytes(library.disk.free) : 'Unavailable'}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    if (onlyUpdate) return;
  }

  function renderUsers(onlyUpdate = false) {
    view().innerHTML = `<div class="view-head"><div><h1>Users & permissions</h1><p>Create individual profiles, restrict libraries and control downloads.</p></div><div class="head-actions"><button class="primary" id="new-user">New User</button></div></div>
      <div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Libraries</th><th>Downloads</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>${state.users.map(user => `<tr>
        <td><strong>${esc(user.username)}</strong></td><td>${esc(user.role)}</td><td>${user.role === 'admin' ? 'All' : (user.allowedLibraries.length ? esc(user.allowedLibraries.map(id => state.storage?.libraries?.find(lib => lib.id === id)?.name || id).join(', ')) : 'None')}</td>
        <td>${user.canDownload ? 'Allowed' : 'Blocked'}</td><td>${user.disabled ? 'Disabled' : 'Active'}</td><td>${timeAgo(user.lastLoginAt)}</td>
        <td class="actions"><button class="ghost small" data-edit="${user.id}">Edit</button><button class="danger small" data-delete="${user.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7">No users loaded.</td></tr>'}</tbody></table></div>
      <div id="user-form" class="panel hidden" style="margin-top:25px"><h2 id="user-form-title">New user</h2><div class="form-grid">
        <label class="field">Username<input id="user-username"></label><label class="field">Password (new/reset)<input id="user-password" type="password" placeholder="Leave blank when editing to keep current"></label>
        <label class="field">Role<select id="user-role"><option value="user">User</option><option value="admin">Administrator</option></select></label><label class="field">Downloads<select id="user-download"><option value="true">Allowed</option><option value="false">Blocked</option></select></label>
        <label class="field">Status<select id="user-disabled"><option value="false">Active</option><option value="true">Disabled</option></select></label></div>
        <h3 style="margin-top:18px">Library access</h3><div class="row-list" id="user-libraries"></div>
        <p class="form-error" id="user-error"></p><div class="form-actions"><button class="ghost" id="cancel-user">Cancel</button><button class="primary" id="save-user">Save user</button></div></div>`;
    let editingId = null;
    const form = document.getElementById('user-form');
    const drawLibraries = () => document.getElementById('user-libraries').innerHTML = (state.storage?.libraries || []).map(library => `<label class="check-row"><input type="checkbox" data-lib="${library.id}"><div><strong>${esc(library.name)}</strong><small>${esc(library.type)}</small></div></label>`).join('') || '<div class="empty">Add libraries first.</div>';
    document.getElementById('new-user').addEventListener('click', () => {
      editingId = null; document.getElementById('user-form-title').textContent = 'New user';
      ['user-username', 'user-password'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('user-role').value = 'user'; document.getElementById('user-download').value = 'true'; document.getElementById('user-disabled').value = 'false';
      drawLibraries(); form.classList.remove('hidden');
    });
    document.getElementById('cancel-user').addEventListener('click', () => form.classList.add('hidden'));
    view().querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => {
      const user = state.users.find(entry => entry.id === Number(button.dataset.edit));
      editingId = user.id; document.getElementById('user-form-title').textContent = `Edit ${user.username}`;
      document.getElementById('user-username').value = user.username; document.getElementById('user-password').value = '';
      document.getElementById('user-role').value = user.role; document.getElementById('user-download').value = String(user.canDownload); document.getElementById('user-disabled').value = String(user.disabled);
      drawLibraries();
      document.querySelectorAll('[data-lib]').forEach(input => input.checked = user.allowedLibraries.includes(Number(input.dataset.lib)) || user.role === 'admin');
      form.classList.remove('hidden');
    }));
    document.getElementById('save-user').addEventListener('click', async () => {
      const payload = {
        username: document.getElementById('user-username').value,
        role: document.getElementById('user-role').value,
        canDownload: document.getElementById('user-download').value === 'true',
        disabled: document.getElementById('user-disabled').value === 'true',
        allowedLibraries: [...document.querySelectorAll('[data-lib]:checked')].map(input => Number(input.dataset.lib))
      };
      const password = document.getElementById('user-password').value;
      if (password) payload.password = password;
      const response = editingId ? await request('PATCH', `/api/admin/users/${editingId}`, payload) : await request('POST', '/api/admin/users', payload);
      if (response.ok) { form.classList.add('hidden'); await refreshData(); renderUsers(true); toast('User saved'); }
    });
    view().querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => {
      if (confirm('Delete this user and their playback history?')) { await request('DELETE', `/api/admin/users/${button.dataset.delete}`); await refreshData(); renderUsers(true); }
    }));
    if (onlyUpdate) return;
  }

  async function renderNetwork(onlyUpdate = false) {
    const stats = state.stats || {};
    const remote = stats.remote || {};
    const addresses = stats.network?.addresses || [];
    view().innerHTML = `<div class="view-head"><div><h1>Network & remote access</h1><p>Local addresses, remote access mode, health checks and temporary HTTPS tunnel controls.</p></div><div class="head-actions"><button class="ghost" id="test-remote">Test remote</button><button class="primary" id="save-network">Save settings</button></div></div>
      <div class="cards-grid"><div class="panel"><h3>Local access</h3><div class="stack">${addresses.map(address => `<div class="stat-line"><span>${esc(address.name)}</span><span><a href="http://${esc(address.address)}:${state.settings.port}" class="link">${esc(address.address)}:${state.settings.port}</a></span></div>`).join('') || '<div>No network adapters found</div>'}</div></div>
      <div class="panel"><h3>Remote access</h3><div class="stack"><div class="stat-line"><span>Mode</span><span>${esc(remote.mode || 'off')}</span></div><div class="stat-line"><span>Status</span><span>${esc(remote.state || 'off')}</span></div><div class="stat-line"><span>URL</span><span>${remote.url ? `<a href="${esc(remote.url)}" class="link">${esc(remote.url)}</a>` : 'Not configured'}</span></div><div class="stat-line"><span>Last test</span><span>${remote.lastChecked ? new Date(remote.lastChecked).toLocaleString() : 'Never'}</span></div></div>${remote.error ? `<div class="notice error">${esc(remote.error)}</div>` : ''}</div></div>
      <div class="section"><div class="panel"><h2>Connection settings</h2><div class="form-grid">
        <label class="field">Port<input id="network-port" type="number" min="1024" max="65535" value="${state.settings.port}"></label>
        <label class="field">Bind address<select id="network-bind"><option value="0.0.0.0" ${state.settings.bindAddress === '0.0.0.0' ? 'selected' : ''}>All interfaces</option><option value="127.0.0.1" ${state.settings.bindAddress === '127.0.0.1' ? 'selected' : ''}>Localhost only</option></select></label>
        <label class="field">Remote mode<select id="remote-mode"><option value="off" ${remote.mode === 'off' ? 'selected' : ''}>Off / LAN only</option><option value="vpn" ${remote.mode === 'vpn' ? 'selected' : ''}>VPN (Tailscale / WireGuard)</option><option value="tunnel" ${remote.mode === 'tunnel' ? 'selected' : ''}>Temporary HTTPS tunnel</option><option value="proxy" ${remote.mode === 'proxy' ? 'selected' : ''}>HTTPS reverse proxy</option></select></label>
        <label class="field">Public URL (reverse proxy)<input id="remote-url" value="${esc(state.settings.remotePublicUrl || '')}" placeholder="https://media.example.com"></label>
      </div><div class="notice">Changing the port or bind address requires a server restart. For VPN access, install your VPN client first.</div></div></div>
      <div class="section"><div class="section-head"><h2>Tunnel control</h2></div><div class="panel"><div class="actions"><button class="primary" id="start-tunnel">Start temporary tunnel</button><button class="danger" id="stop-tunnel">Stop tunnel</button></div><small>Quick tunnels are for convenience. For a permanent address use VPN or your own HTTPS reverse proxy.</small></div></div>`;
    document.getElementById('save-network').addEventListener('click', async () => {
      const response = await request('PATCH', '/api/admin/settings', { port: Number(document.getElementById('network-port').value), bindAddress: document.getElementById('network-bind').value, remoteMode: document.getElementById('remote-mode').value, remotePublicUrl: document.getElementById('remote-url').value });
      if (response.ok) { toast('Network settings saved'); if (response.data.restartRequired) { await window.hearth.control('restart'); await refreshStatus(); } }
    });
    document.getElementById('test-remote').addEventListener('click', async () => {
      const response = await request('POST', '/api/admin/remote/test', {});
      toast(response.data?.ok ? 'Remote URL reached this server' : response.data?.message || 'Remote test failed', response.data?.ok ? 'success' : 'error');
      await refreshData(); renderNetwork(true);
    });
    document.getElementById('start-tunnel').addEventListener('click', async () => { await request('POST', '/api/admin/remote/tunnel/start', {}); toast('Tunnel starting'); setTimeout(() => { refreshData(); renderNetwork(true); }, 2500); });
    document.getElementById('stop-tunnel').addEventListener('click', async () => { await request('POST', '/api/admin/remote/tunnel/stop', {}); await refreshData(); renderNetwork(true); });
    if (onlyUpdate) return;
  }

  async function renderPlayback(onlyUpdate = false) {
    view().innerHTML = `<div class="view-head"><div><h1>Streaming & transcoding</h1><p>Direct Play when compatible; automatic FFmpeg transcoding when a device needs it.</p></div><button class="primary" id="save-playback">Save settings</button></div>
      <div class="section"><div class="panel"><div class="form-grid">
        <label class="field">Transcoding mode<select id="transcode-mode"><option value="auto" ${state.settings.transcodeMode === 'auto' ? 'selected' : ''}>Auto — hardware first</option><option value="software" ${state.settings.transcodeMode === 'software' ? 'selected' : ''}>Software only</option></select></label>
        <label class="field">Hardware acceleration<select id="hardware"><option value="">Auto detect</option><option value="nvenc" ${state.settings.hardwareEncoder === 'nvenc' ? 'selected' : ''}>NVIDIA NVENC</option><option value="qsv" ${state.settings.hardwareEncoder === 'qsv' ? 'selected' : ''}>Intel QSV</option><option value="amf" ${state.settings.hardwareEncoder === 'amf' ? 'selected' : ''}>AMD AMF</option></select></label>
        <label class="field">Max concurrent transcodes<input id="max-transcodes" type="number" min="1" max="8" value="${state.settings.maxConcurrentTranscodes}"></label>
        <label class="field">Transcode cache size (GB)<input id="cache-gb" type="number" min="0.5" step="0.5" value="${state.settings.transcodeCacheGB}"></label>
        <label class="field">Scan on startup<select id="scan-startup"><option value="true" ${state.settings.scanOnStartup ? 'selected' : ''}>Enabled</option><option value="false" ${state.settings.scanOnStartup ? '' : 'selected'}>Disabled</option></select></label>
        <label class="field">Server name<input id="server-name" value="${esc(state.settings.serverName)}"></label>
      </div></div></div>
      <div class="section"><div class="section-head"><h2>Detected encoders</h2></div><div class="cards-grid">
        ${metric('NVIDIA NVENC', state.diagnostics?.encoders?.nvenc ? 'Available' : 'Not available', 'Validated with a test encode')}
        ${metric('Intel QSV', state.diagnostics?.encoders?.qsv ? 'Available' : 'Not available', 'Validated with a test encode')}
        ${metric('AMD AMF', state.diagnostics?.encoders?.amf ? 'Available' : 'Not available', 'Validated with a test encode')}
        ${metric('Software libx264', state.diagnostics?.encoders?.software ? 'Available' : 'Not available', 'Always reliable fallback')}
      </div></div>
      <div class="section"><div class="section-head"><h2>FFmpeg diagnostics</h2></div><div class="panel"><div class="stat-line"><span>Version</span><span>${esc(state.diagnostics?.ffmpeg || 'Unknown')}</span></div><div class="stat-line"><span>Node runtime</span><span>${esc(state.diagnostics?.node || '')}</span></div></div></div>`;
    document.getElementById('save-playback').addEventListener('click', async () => {
      const response = await request('PATCH', '/api/admin/settings', {
        transcodeMode: document.getElementById('transcode-mode').value,
        hardwareEncoder: document.getElementById('hardware').value,
        allowHardwareTranscoding: document.getElementById('transcode-mode').value !== 'software',
        maxConcurrentTranscodes: Number(document.getElementById('max-transcodes').value),
        transcodeCacheGB: Number(document.getElementById('cache-gb').value),
        scanOnStartup: document.getElementById('scan-startup').value === 'true',
        serverName: document.getElementById('server-name').value
      });
      if (response.ok) toast('Playback settings saved');
    });
    if (onlyUpdate) return;
  }

  async function renderMetadata(onlyUpdate = false) {
    const configured = (await request('GET', '/api/admin/settings')).data;
    const secrets = configured?.secrets || {};
    view().innerHTML = `<div class="view-head"><div><h1>Metadata & API providers</h1><p>Configure provider keys, manually identify titles and edit metadata.</p></div><button class="primary" id="save-metadata">Save credentials</button></div>
      <div class="section"><div class="panel"><div class="form-grid">
        <label class="field">TMDB API key ${secrets.tmdbKey ? '<span class="success-note">configured</span>' : '<span class="form-error">not configured</span>'}<input id="tmdb-key" placeholder="${secrets.tmdbKey ? 'Leave blank to keep current' : 'TMDB v3 API key'}"></label>
        <label class="field">MusicBrainz token ${secrets.musicBrainzToken ? '<span class="success-note">configured</span>' : '<span class="form-error">optional</span>'}<input id="mb-token" placeholder="${secrets.musicBrainzToken ? 'Leave blank to keep current' : 'Optional token for higher accountability'}"></label>
      </div><div class="notice">Movie/TV: TMDB requires a free API key. Music: MusicBrainz can work without a key; rate limits are respected. Artwork is cached locally and the original media always comes from your folders.</div></div></div>
      <div class="section"><div class="panel"><h2>Manual identify / edit</h2><div class="filter"><input id="metadata-query" placeholder="Search title, artist or album"><button class="ghost" id="metadata-search">Search</button></div><div id="metadata-results" class="row-list"></div></div></div>
      <div class="section"><div class="panel"><h2>Edit selected title</h2><div class="form-grid"><label class="field">Item ID<input id="edit-item-id"></label><label class="field">Title<input id="edit-title"></label><label class="field">Year<input id="edit-year" type="number"></label><label class="field">Overview<textarea id="edit-overview"></textarea></label></div>
        <div class="form-actions"><button class="ghost" id="refresh-provider">Refresh from provider</button><button class="primary" id="save-metadata-item">Save title</button></div></div></div>`;
    document.getElementById('save-metadata').addEventListener('click', async () => {
      const payload = {};
      const tmdb = document.getElementById('tmdb-key').value.trim();
      const music = document.getElementById('mb-token').value.trim();
      if (tmdb) payload.tmdbKey = tmdb;
      if (music) payload.musicBrainzToken = music;
      if (Object.keys(payload).length) { await request('POST', '/api/admin/settings/secrets', payload); toast('Credentials saved'); await refreshData(); renderMetadata(true); }
    });
    document.getElementById('metadata-search').addEventListener('click', async () => {
      const query = document.getElementById('metadata-query').value.trim();
      if (!query) return;
      const response = await request('GET', `/api/items?type=movie&limit=100&q=${encodeURIComponent(query)}`);
      const tvResponse = await request('GET', `/api/shows?q=${encodeURIComponent(query)}`);
      const songs = await request('GET', `/api/items?type=song&limit=100&q=${encodeURIComponent(query)}`);
      const results = [...(response.data?.items || []), ...(songs.data?.items || [])].map(item => ({ id: item.id, title: item.title, subtitle: [item.year, item.artist, item.album].filter(Boolean).join(' · ') }));
      (tvResponse.data?.shows || []).forEach(show => results.push({ id: show.id, title: show.title, subtitle: `Series · ${show.episodeCount} episodes` }));
      document.getElementById('metadata-results').innerHTML = results.map(result => `<div class="item-row"><div class="grow"><strong>${esc(result.title)}</strong><small>${esc(result.subtitle || '')}</small></div><button class="ghost small" data-edit-id="${esc(result.id)}">Edit</button></div>`).join('') || '<div class="empty">No indexed items matched.</div>';
      document.querySelectorAll('[data-edit-id]').forEach(button => button.addEventListener('click', async () => {
        const itemId = button.dataset.editId;
        const details = await request('GET', `/api/items/${itemId}`);
        const item = details.data || {};
        document.getElementById('edit-item-id').value = itemId;
        document.getElementById('edit-title').value = item.title || '';
        document.getElementById('edit-year').value = item.year || '';
        document.getElementById('edit-overview').value = item.overview || '';
      }));
    });
    document.getElementById('refresh-provider').addEventListener('click', async () => {
      const itemId = document.getElementById('edit-item-id').value.trim();
      if (!itemId) return;
      const search = await request('GET', `/api/admin/metadata/search?itemId=${encodeURIComponent(itemId)}`);
      const first = search.data?.results?.[0];
      if (!first) { toast('No provider match found', 'warn'); return; }
      await request('POST', '/api/admin/metadata/apply', { itemId, externalId: first.externalId });
      toast('Metadata refreshed');
    });
    document.getElementById('save-metadata-item').addEventListener('click', async () => {
      const itemId = document.getElementById('edit-item-id').value.trim();
      if (!itemId) return;
      await request('PATCH', `/api/admin/items/${itemId}`, {
        title: document.getElementById('edit-title').value, year: document.getElementById('edit-year').value,
        overview: document.getElementById('edit-overview').value
      });
      toast('Title metadata saved');
    });
    if (onlyUpdate) return;
  }

  async function renderLogs(onlyUpdate = false) {
    const response = await request('GET', '/api/admin/logs?lines=400');
    view().innerHTML = `<div class="view-head"><div><h1>Logs & diagnostics</h1><p>Server log tail from today’s rotating log file.</p></div><div class="head-actions"><button class="ghost" id="refresh-log">Refresh</button><button class="ghost" id="show-diagnostics">Diagnostics JSON</button></div></div>
      <div class="log-box">${esc(response.data || 'No log output yet.')}</div><div id="diag-output" class="panel hidden" style="margin-top:18px"><pre style="white-space:pre-wrap;font:12px ui-monospace">${esc(JSON.stringify(state.diagnostics, null, 2))}</pre></div>`;
    document.getElementById('refresh-log').addEventListener('click', () => renderLogs());
    document.getElementById('show-diagnostics').addEventListener('click', () => document.getElementById('diag-output').classList.toggle('hidden'));
    if (onlyUpdate) return;
  }

  async function renderBackup(onlyUpdate = false) {
    const response = await request('GET', '/api/admin/backups');
    const backups = response.data?.backups || [];
    view().innerHTML = `<div class="view-head"><div><h1>Backup & restore</h1><p>Create a consistent SQLite snapshot, download it, or restore from a local file.</p></div><div class="head-actions"><button class="primary" id="make-backup">Create Backup</button><button class="ghost" id="restore-backup">Restore Backup</button></div></div>
      <div class="row-list">${backups.map(backup => `<div class="item-row"><div class="grow"><strong>${esc(backup.name)}</strong><small>Created ${esc(backup.created)}</small></div><div class="actions"><button class="ghost small" data-download="${esc(backup.name)}">Download</button></div></div>`).join('') || '<div class="empty">No backups yet.</div>'}</div>
      <div class="notice" style="margin-top:20px">Backups include the library database, users, settings and encrypted credentials. Artwork caches and original media files are not duplicated.</div>`;
    document.getElementById('make-backup').addEventListener('click', async () => {
      const created = await request('POST', '/api/admin/backups', {});
      if (created.ok) { toast('Backup created'); renderBackup(); }
    });
    document.getElementById('restore-backup').addEventListener('click', async () => {
      const file = await window.hearth.pickFile([{ name: 'Hearth backup', extensions: ['hearthbackup'] }]);
      if (!file) return;
      if (!confirm('Stop the server and restore this backup? A pre-restore snapshot will be kept.')) return;
      try { await window.hearth.restoreBackup(file); toast('Backup restored and server restarted'); }
      catch (error) { toast(error.message, 'error'); }
      await refreshStatus(); await refreshData();
    });
    view().querySelectorAll('[data-download]').forEach(button => button.addEventListener('click', async () => {
      const path = `/api/admin/backups/${encodeURIComponent(button.dataset.download)}/download`;
      try { const saved = await window.hearth.download(path, button.dataset.download); if (saved) toast('Backup saved'); } catch (error) { toast(error.message, 'error'); }
    }));
    if (onlyUpdate) return;
  }

  async function renderUpdates(onlyUpdate = false) {
    view().innerHTML = `<div class="view-head"><div><h1>Updates</h1><p>Check a signed HTTPS update manifest and install a verified Windows package.</p></div></div>
      <div class="section"><div class="panel"><h2>Check for updates</h2><div class="form-grid"><label class="field">Update manifest URL<input id="update-url" placeholder="https://your-domain/hearth-update.json"></label>
      <div class="field"><span>&nbsp;</span><button class="primary" id="check-update">Check Now</button></div></div>
      <div class="notice">The manifest should contain <code>version</code>, <code>url</code> and <code>sha256</code>. HTTPS and checksum verification are enforced. This installer is currently unsigned, so Windows may show a SmartScreen warning.</div>
      <div id="update-result" class="stack" style="margin-top:18px"></div></div></div>`;
    document.getElementById('check-update').addEventListener('click', async () => {
      const area = document.getElementById('update-result');
      area.innerHTML = '<div class="notice">Checking…</div>';
      try {
        const manifest = await window.hearth.updateCheck(document.getElementById('update-url').value.trim());
        const current = '1.0.1';
        const newer = manifest.version && manifest.version !== current;
        area.innerHTML = `<div class="notice ${newer ? 'ok' : ''}"><strong>${newer ? `Version ${esc(manifest.version)} available` : 'You are up to date'}</strong><br>Current version ${current}${newer ? '' : ' · No newer release in manifest'}</div>
          ${newer ? `<button class="primary" id="install-update">Download & verify</button>` : ''}`;
        document.getElementById('install-update')?.addEventListener('click', async () => {
          try {
            const downloaded = await window.hearth.updateDownload({ url: manifest.url, expectedSha256: manifest.sha256 });
            await window.hearth.updateRun(downloaded.path);
            toast('Installer launched');
          } catch (error) { toast(error.message, 'error'); }
        });
      } catch (error) { area.innerHTML = `<div class="notice error">${esc(error.message)}</div>`; }
    });
    if (onlyUpdate) return;
  }

  async function render(name) {
    switch (name) {
      case 'dashboard': renderDashboard(); break;
      case 'libraries': renderLibraries(); break;
      case 'storage': renderStorage(); break;
      case 'users': renderUsers(); break;
      case 'network': await renderNetwork(); break;
      case 'playback': await renderPlayback(); break;
      case 'metadata': await renderMetadata(); break;
      case 'logs': await renderLogs(); break;
      case 'backup': await renderBackup(); break;
      case 'updates': await renderUpdates(); break;
    }
  }

  boot();
})();
